import { setTimeout as sleep } from 'node:timers/promises';
import { newId } from '../../../core/id.js';
import {
  type DeliveryDecision,
  decideAfterAttempt,
} from '../../../core/retry-policy.js';
import {
  serializeWebhookBody,
  signingSecrets,
  signWebhook,
} from '../../../core/webhook-signature.js';
import type { Clock } from '../../../platform/clock.js';
import { errorFields, type Logger } from '../../../platform/logger.js';
import type {
  ClaimedDelivery,
  DeliveryStore,
  DeliveryTarget,
  EndpointGoneReason,
  GuardedWriteResult,
  NewAttempt,
  RecordAttemptInput,
} from '../ports/delivery-store.port.js';
import type {
  SendOutcome,
  WebhookSender,
} from '../ports/webhook-sender.port.js';

/** Chờ trước lần ghi kết quả thứ 2 và thứ 3 khi DB lỗi tạm thời (quyết định #20 của lát 6). */
const RECORD_RETRY_DELAYS_MS = [200, 400];

/**
 * Kết quả xử lý một delivery, để vòng lặp log: đã gửi (kèm `attempt_count` sau lần này,
 * outcome và quyết định), endpoint đã xóa/tắt, hoặc mất quyền giữa chừng. `attemptCount` khác
 * `attempt_number` trong DB sau một lần replay (WRK-08) nên đặt tên đúng là "count".
 */
export type DeliverResult =
  | {
      status: 'sent';
      attemptCount: number;
      outcome: SendOutcome;
      decision: DeliveryDecision;
    }
  | {
      status: 'endpoint_gone';
      reason: EndpointGoneReason;
    }
  | { status: 'lease_lost' };

/**
 * Tùy chọn của `Deliver`: `User-Agent`, lịch retry, logger để báo lần ghi kết quả bị lỗi;
 * `random` (mặc định `Math.random`) chỉ để test cố định jitter.
 */
export interface DeliverOptions {
  userAgent: string;
  retryDelaysMs: readonly number[];
  logger: Pick<Logger, 'warn'>;
  random?: () => number;
}

/**
 * Use case: xử lý một delivery worker đã giành quyền (spec 07, bước 2, 4, 5).
 *
 * Ba thao tác DB (nạp, rồi ghi kết quả) tách rời, không giữ kết nối khi gửi HTTP (WRK-12).
 * Không ném lỗi với kết quả bình thường; chỉ ném lỗi lạ (dữ liệu hỏng, secret sai dạng, DB lỗi
 * kéo dài) để vòng lặp log `error` và delivery được lấy lại sau khi hết lease (WRK-11).
 */
export class Deliver {
  constructor(
    private readonly store: DeliveryStore,
    private readonly sender: WebhookSender,
    private readonly clock: Clock,
    private readonly options: DeliverOptions,
  ) {}

  /** Nạp → (endpoint xóa/tắt thì kết thúc) → ký, gửi → ghi attempt và trạng thái mới. */
  async execute(claim: ClaimedDelivery): Promise<DeliverResult> {
    // 1. Nạp sự kiện + endpoint HIỆN TẠI (WRK-06)
    const target = await this.store.loadTarget(claim);
    const goneReason = endpointGoneReason(target.endpoint);
    if (goneReason) {
      const written = await this.store.failForEndpoint(claim, {
        reason: goneReason,
        now: this.clock.now(),
      });
      return written === 'done'
        ? { status: 'endpoint_gone', reason: goneReason }
        : { status: 'lease_lost' };
    }
    // 2. Ký ngay trước khi gửi rồi gửi; đo thời lượng bằng đồng hồ đơn điệu
    const sentAt = this.clock.now();
    const startedMs = performance.now();
    const outcome = await this.sender.send(this.buildRequest(target, sentAt));
    const durationMs = Math.round(performance.now() - startedMs);
    // 3. Quyết định trạng thái mới rồi ghi kết quả có điều kiện mã giữ quyền
    const attemptCount = claim.attemptCount + 1;
    const now = this.clock.now();
    const decision = decideAfterAttempt({
      succeeded: outcome.status === 'ok',
      attemptCount,
      now,
      retryDelaysMs: this.options.retryDelaysMs,
      random: this.options.random ?? Math.random,
    });
    const written = await this.recordWithRetry(claim, {
      attempt: toAttempt(outcome, sentAt, durationMs),
      decision,
      lastError: errorLabel(outcome),
      now,
    });
    if (written === 'lease_lost') return { status: 'lease_lost' };
    return { status: 'sent', attemptCount, outcome, decision };
  }

  /**
   * Dựng request: body serialize một lần, ký đúng các byte đó (SIG-01) bằng secret hiện tại và
   * secret cũ còn hạn (SEC-22); `webhook-id` là ID sự kiện.
   */
  private buildRequest(target: DeliveryTarget, sentAt: Date) {
    const body = serializeWebhookBody(target.event);
    const signature = signWebhook({
      webhookId: target.event.id,
      sentAt,
      body,
      secrets: signingSecrets(target.endpoint, sentAt),
    });
    return {
      url: target.endpoint.url,
      body,
      headers: {
        ...signature,
        'content-type': 'application/json',
        'user-agent': this.options.userAgent,
      },
    };
  }

  /**
   * Ghi kết quả, thử lại tối đa 3 lần khi store ném lỗi (DB lỗi tạm thời), để không phải gửi
   * lại HTTP chỉ vì DB chậm một lúc. Mỗi lần lỗi được log `warn`; lần cuối vẫn lỗi thì ném ra
   * cho vòng lặp log `error`. Lỗi không tạm thời (vd vi phạm CHECK) cũng bị thử lại: vô hại, chỉ
   * tốn thêm 600ms trước khi ném. `lease_lost` là kết quả, không thử lại. Lần thử lại sau một
   * COMMIT đã thành công mà mất phản hồi sẽ gặp `lease_lost`: dữ liệu vẫn đúng, và log `warn`
   * ngay trước đó cho biết vì sao.
   */
  private async recordWithRetry(
    claim: ClaimedDelivery,
    input: RecordAttemptInput,
  ): Promise<GuardedWriteResult> {
    for (const [index, delayMs] of RECORD_RETRY_DELAYS_MS.entries()) {
      try {
        return await this.store.recordAttempt(claim, input);
      } catch (error) {
        this.options.logger.warn(
          { delivery_id: claim.id, try: index + 1, error: errorFields(error) },
          'recording attempt failed, retrying',
        );
        await sleep(delayMs);
      }
    }
    return this.store.recordAttempt(claim, input);
  }
}

/** Lý do kết thúc delivery nếu endpoint đã xóa hoặc đang vô hiệu hóa; `null` nếu còn hoạt động. */
function endpointGoneReason(
  endpoint: DeliveryTarget['endpoint'],
): EndpointGoneReason | null {
  if (endpoint.deletedAt) return 'endpoint_deleted';
  if (endpoint.disabledAt) return 'endpoint_disabled';
  return null;
}

/** Đổi outcome thành attempt cần ghi: có mã HTTP thì kèm snippet, không thì nhãn lỗi. */
function toAttempt(
  outcome: SendOutcome,
  startedAt: Date,
  durationMs: number,
): NewAttempt {
  const id = newId('attempt', startedAt.getTime());
  switch (outcome.status) {
    case 'ok':
    case 'http_status':
      return {
        id,
        startedAt,
        durationMs,
        httpStatus: outcome.httpStatus,
        responseSnippet: outcome.snippet,
        error: null,
      };
    case 'ssrf_blocked':
    case 'dns':
    case 'tls':
    case 'timeout':
    case 'connection_refused':
    case 'connection_error':
      return {
        id,
        startedAt,
        durationMs,
        httpStatus: null,
        responseSnippet: null,
        error: outcome.status,
      };
  }
}

/**
 * Nhãn ngắn của một outcome: `null` khi 2xx, `http <mã>` hoặc tên lỗi. Dùng cho `last_error` và
 * log; không chứa URL hay snippet vì cả hai đều lộ ra ngoài (API, log, SEC-13).
 */
export function errorLabel(outcome: SendOutcome): string | null {
  switch (outcome.status) {
    case 'ok':
      return null;
    case 'http_status':
      return `http ${outcome.httpStatus}`;
    case 'ssrf_blocked':
    case 'dns':
    case 'tls':
    case 'timeout':
    case 'connection_refused':
    case 'connection_error':
      return outcome.status;
  }
}
