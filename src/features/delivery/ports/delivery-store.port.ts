import type { Id } from '../../../core/id.js';
import type { DeliveryDecision } from '../../../core/retry-policy.js';
import type { SendOutcome } from './webhook-sender.port.js';

/**
 * Một delivery mà worker vừa giành quyền (spec 07 bước 1). `leaseToken` là mã giữ quyền: mọi
 * thao tác ghi sau đó phải khớp mã này (WRK-09). `attemptCount` là số attempt đã có trước lần
 * gửi này.
 */
export interface ClaimedDelivery {
  id: Id<'delivery'>;
  eventId: Id<'event'>;
  endpointId: Id<'endpoint'>;
  leaseToken: string;
  attemptCount: number;
}

/**
 * Dữ liệu cần để gửi một delivery: sự kiện và endpoint ở trạng thái HIỆN TẠI (WRK-06).
 * Khai báo riêng ở feature delivery, không import feature endpoints (ARCH-12).
 */
export interface DeliveryTarget {
  event: { id: Id<'event'>; type: string; createdAt: Date; payload: unknown };
  endpoint: {
    url: string;
    secret: string;
    previousSecret: string | null;
    previousSecretExpiresAt: Date | null;
    deletedAt: Date | null;
    disabledAt: Date | null;
  };
}

/** Nhãn lỗi của một attempt không có mã HTTP (cột `attempts.error`). */
export type AttemptError = Exclude<SendOutcome['status'], 'ok' | 'http_status'>;

/**
 * Một attempt cần ghi. Có đúng một trong hai: `httpStatus` (đích đã trả lời) hoặc `error`
 * (không có phản hồi HTTP), khớp CHECK `attempts_http_status_xor_error` của schema.
 */
export interface NewAttempt {
  id: Id<'attempt'>;
  startedAt: Date;
  durationMs: number;
  httpStatus: number | null;
  responseSnippet: string | null;
  error: AttemptError | null;
}

/**
 * Kết quả của một lần ghi có điều kiện mã giữ quyền: `done`, hoặc `lease_lost` khi delivery
 * không còn `in_flight` với đúng mã của mình (worker khác đã giành lại, WRK-09).
 */
export type GuardedWriteResult = 'done' | 'lease_lost';

/** Lý do kết thúc delivery khi endpoint không còn nhận được (spec 07 bước 2). */
export type EndpointGoneReason = 'endpoint_deleted' | 'endpoint_disabled';

/**
 * Phần tối đa của một lô dành cho delivery hết lease (D-23): phần còn lại dành cho delivery
 * đến hạn, để tin độc quay vòng không bỏ đói delivery mới.
 */
const EXPIRED_LEASE_BATCH_SHARE = 0.5;

/** Đầu vào của `claimDue`: "bây giờ", hạn lease mới, số delivery tối đa. */
export interface ClaimDueInput {
  now: Date;
  leaseUntil: Date;
  limit: number;
}

/** Đầu vào của `failForEndpoint`. */
export interface FailForEndpointInput {
  reason: EndpointGoneReason;
  now: Date;
}

/** Đầu vào của `recordAttempt`: attempt cần ghi, quyết định, nhãn `last_error`, "bây giờ". */
export interface RecordAttemptInput {
  attempt: NewAttempt;
  decision: DeliveryDecision;
  lastError: string | null;
  now: Date;
}

/** Port lưu trữ delivery của worker (adapter: `adapters/postgres`). */
export interface DeliveryStore {
  /**
   * Giành quyền tối đa `limit` delivery: `pending` đã đến hạn (sớm tối đa 1 giây) và `in_flight`
   * đã quá lease (worker cũ chết); delivery hết lease chiếm tối đa `EXPIRED_LEASE_BATCH_SHARE`
   * lô (làm tròn lên). Mỗi delivery nhận `lease_until = leaseUntil` và mã giữ quyền mới.
   */
  claimDue(input: ClaimDueInput): Promise<ClaimedDelivery[]>;
  /** Nạp sự kiện và endpoint hiện tại của delivery; thiếu dữ liệu là lỗi dữ liệu nên ném lỗi. */
  loadTarget(claim: ClaimedDelivery): Promise<DeliveryTarget>;
  /** Kết thúc delivery `failed` vì endpoint đã xóa / bị vô hiệu hóa; không ghi attempt. */
  failForEndpoint(
    claim: ClaimedDelivery,
    input: FailForEndpointInput,
  ): Promise<GuardedWriteResult>;
  /**
   * Ghi attempt (số thứ tự tiếp nối lịch sử, WRK-08) và cập nhật delivery theo `decision`, tăng
   * `attempt_count`, cập nhật `first_failure_at` của endpoint (RTY-10), tất cả trong một
   * transaction. Mất quyền thì không ghi gì.
   */
  recordAttempt(
    claim: ClaimedDelivery,
    input: RecordAttemptInput,
  ): Promise<GuardedWriteResult>;
}

/** Số delivery hết lease tối đa trong một lô `limit` (D-23); dùng chung cho mọi bản store. */
export function maxExpiredInBatch(limit: number): number {
  return Math.ceil(limit * EXPIRED_LEASE_BATCH_SHARE);
}
