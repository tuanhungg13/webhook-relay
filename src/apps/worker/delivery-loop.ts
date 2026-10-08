import type {
  ClaimedDelivery,
  DeliveryStore,
} from '../../features/delivery/ports/delivery-store.port.js';
import {
  type DeliverResult,
  errorLabel,
} from '../../features/delivery/use-cases/deliver.use-case.js';
import type { Clock } from '../../platform/clock.js';
import { errorFields, type Logger } from '../../platform/logger.js';

/** Phần logger vòng lặp dùng; test truyền bản giả. */
export type LoopLogger = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;

/** Thứ vòng lặp cần: giành quyền, xử lý một delivery, đồng hồ, logger. */
export interface DeliveryLoopDeps {
  store: Pick<DeliveryStore, 'claimDue'>;
  deliver: { execute(claim: ClaimedDelivery): Promise<DeliverResult> };
  clock: Clock;
  logger: LoopLogger;
}

/** Cấu hình vòng lặp: `WORKER_CONCURRENCY`, `WORKER_IDLE_SLEEP`, `LEASE_DURATION`. */
export interface DeliveryLoopOptions {
  concurrency: number;
  idleSleepMs: number;
  leaseMs: number;
}

/**
 * Vòng lặp lấy việc của worker giai đoạn 1 (D-23): quét Postgres giành tối đa số chỗ trống,
 * chạy song song, hết việc thì ngủ `idleSleepMs`.
 *
 * Backpressure (WRK-07, NODE-01): đủ `concurrency` việc thì chờ một việc xong mới quét tiếp, nên
 * việc chờ nằm trong DB chứ không dồn trong bộ nhớ. Lỗi của một việc được bắt và log trong
 * phạm vi việc đó (WRK-11); delivery giữ `in_flight` và được giành lại sau khi hết lease.
 */
export class DeliveryLoop {
  private readonly running = new Set<Promise<void>>();
  private stopping = false;
  /** Đánh thức giấc ngủ đang diễn ra (nếu có), để `stop` không phải chờ hết giờ ngủ. */
  private wake: (() => void) | null = null;
  private loopDone: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: DeliveryLoopDeps,
    private readonly options: DeliveryLoopOptions,
  ) {}

  /** Bắt đầu vòng lặp (chạy nền, không chờ). */
  start(): void {
    this.loopDone = this.run();
  }

  /**
   * Dừng êm (WRK-04): ngừng quét, đánh thức giấc ngủ, chờ lượt giành quyền đang dở và mọi việc
   * đang chạy xong. Lô vừa giành được vẫn xử lý hết: bỏ rơi thì chúng kẹt `in_flight` tới hết
   * lease. Thời hạn tổng do `shutdownGracefully` (`SHUTDOWN_TIMEOUT`) lo.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loopDone;
    await Promise.all(this.running);
  }

  /** Mỗi lượt: đầy chỗ thì chờ một việc xong; không thì giành và chạy; thiếu việc thì ngủ. */
  private async run(): Promise<void> {
    while (!this.stopping) {
      const free = this.options.concurrency - this.running.size;
      if (free === 0) {
        await Promise.race(this.running);
        continue;
      }
      const claims = await this.claim(free);
      for (const claim of claims) this.track(claim);
      // Được ít hơn số chỗ trống nghĩa là tạm hết việc đến hạn: ngủ thay vì quét dồn dập.
      if (claims.length < free) await this.sleep(this.options.idleSleepMs);
    }
  }

  /** Giành tối đa `limit` delivery; DB lỗi thì log `error` và trả rỗng (vòng lặp ngủ rồi thử lại). */
  private async claim(limit: number): Promise<ClaimedDelivery[]> {
    const now = this.deps.clock.now();
    try {
      return await this.deps.store.claimDue({
        now,
        leaseUntil: new Date(now.getTime() + this.options.leaseMs),
        limit,
      });
    } catch (error) {
      this.deps.logger.error(
        { error: errorFields(error) },
        'claiming deliveries failed',
      );
      return [];
    }
  }

  /** Chạy một việc và giữ promise của nó trong `running` tới khi xong. */
  private track(claim: ClaimedDelivery): void {
    const job = this.process(claim).finally(() => this.running.delete(job));
    this.running.add(job);
  }

  /** Xử lý một delivery, log kết quả; không bao giờ ném lỗi (WRK-11). */
  private async process(claim: ClaimedDelivery): Promise<void> {
    const fields = { delivery_id: claim.id, endpoint_id: claim.endpointId };
    try {
      logResult(
        this.deps.logger,
        fields,
        await this.deps.deliver.execute(claim),
      );
    } catch (error) {
      this.deps.logger.error(
        { ...fields, error: errorFields(error) },
        'delivery failed unexpectedly, retried after the lease expires',
      );
    }
  }

  /** Ngủ `ms`; `stop` đánh thức sớm qua `wake`. */
  private sleep(ms: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
}

/**
 * Log kết quả một delivery (OBS-20, SEC-13): thành công ở `debug`, thất bại ở `info` chỉ kèm
 * nhãn kết quả (không URL, header, snippet), mất quyền ở `warn`.
 */
function logResult(
  logger: LoopLogger,
  fields: { delivery_id: string; endpoint_id: string },
  result: DeliverResult,
): void {
  switch (result.status) {
    case 'sent': {
      const { outcome, decision, attemptCount } = result;
      const label = errorLabel(outcome);
      if (label === null) {
        logger.debug(
          { ...fields, attempt_count: attemptCount },
          'attempt succeeded',
        );
        return;
      }
      logger.info(
        {
          ...fields,
          attempt_count: attemptCount,
          outcome: label,
          next: decision.status,
        },
        'attempt failed',
      );
      return;
    }
    case 'endpoint_gone':
      logger.info({ ...fields, reason: result.reason }, 'delivery failed');
      return;
    case 'lease_lost':
      logger.warn(fields, 'lease lost, result discarded');
      return;
  }
}
