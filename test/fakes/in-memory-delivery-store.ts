import { randomUUID } from 'node:crypto';
import type { Id } from '../../src/core/id.js';
import {
  type ClaimDueInput,
  type ClaimedDelivery,
  type DeliveryStore,
  type DeliveryTarget,
  type FailForEndpointInput,
  type GuardedWriteResult,
  maxExpiredInBatch,
  type NewAttempt,
  type RecordAttemptInput,
} from '../../src/features/delivery/ports/delivery-store.port.js';

/** Dung sai lệch đồng hồ khi xét "đến hạn" (spec 07 bước 1). */
const CLOCK_SKEW_MS = 1_000;

/** Một delivery trong bản giả: đủ các cột mà worker đọc/ghi. */
export interface FakeDelivery {
  id: Id<'delivery'>;
  eventId: Id<'event'>;
  endpointId: Id<'endpoint'>;
  status: 'pending' | 'in_flight' | 'succeeded' | 'failed';
  failedReason: string | null;
  attemptCount: number;
  nextAttemptAt: Date;
  leaseUntil: Date | null;
  leaseToken: string | null;
  lastError: string | null;
  gateBlockedCount: number;
  updatedAt: Date;
}

/** Endpoint trong bản giả: phần worker đọc, cộng `firstFailureAt` mà worker ghi. */
export type FakeEndpoint = DeliveryTarget['endpoint'] & {
  firstFailureAt: Date | null;
};

/** Một attempt đã ghi trong bản giả. */
export type FakeAttempt = NewAttempt & {
  deliveryId: Id<'delivery'>;
  attemptNumber: number;
};

/**
 * Bản giả của `DeliveryStore` lưu trong bộ nhớ, dùng cho test không cần Postgres. Chạy qua cùng
 * bộ contract test với bản Postgres (ARCH-21). Test dựng dữ liệu bằng `events`, `endpoints`,
 * `deliveries` và đọc lại trực tiếp từ đó.
 */
export class InMemoryDeliveryStore implements DeliveryStore {
  readonly events = new Map<Id<'event'>, DeliveryTarget['event']>();
  readonly endpoints = new Map<Id<'endpoint'>, FakeEndpoint>();
  readonly deliveries = new Map<Id<'delivery'>, FakeDelivery>();
  readonly attempts: FakeAttempt[] = [];

  /** Hết lease trước (tối đa nửa lô), rồi đến hạn; giống câu SQL của bản Postgres. */
  claimDue(input: ClaimDueInput): Promise<ClaimedDelivery[]> {
    const { now, leaseUntil, limit } = input;
    const all = [...this.deliveries.values()];
    // 1. Hết lease, cũ nhất trước, tối đa phần dành cho chúng
    const expired = all
      .filter((d) => d.status === 'in_flight' && d.leaseUntil! < now)
      .sort((a, b) => a.leaseUntil!.getTime() - b.leaseUntil!.getTime())
      .slice(0, maxExpiredInBatch(limit));
    // 2. Đến hạn (cho sớm 1 giây), sớm nhất trước
    const due = all
      .filter(
        (d) =>
          d.status === 'pending' &&
          d.nextAttemptAt.getTime() <= now.getTime() + CLOCK_SKEW_MS,
      )
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime());
    // 3. Ghép, cắt theo `limit`, rồi đổi sang in_flight với mã giữ quyền mới
    const picked = [...expired, ...due].slice(0, limit);
    return Promise.resolve(
      picked.map((d) => {
        Object.assign(d, {
          status: 'in_flight',
          leaseUntil,
          leaseToken: randomUUID(),
          updatedAt: now,
        });
        return {
          id: d.id,
          eventId: d.eventId,
          endpointId: d.endpointId,
          leaseToken: d.leaseToken!,
          attemptCount: d.attemptCount,
        };
      }),
    );
  }

  /** Trả bản sao sự kiện + endpoint; thiếu thì ném lỗi như bản Postgres. */
  loadTarget(claim: ClaimedDelivery): Promise<DeliveryTarget> {
    const event = this.events.get(claim.eventId);
    const endpoint = this.endpoints.get(claim.endpointId);
    if (!event || !endpoint) {
      return Promise.reject(new Error(`delivery ${claim.id} has no target`));
    }
    const { firstFailureAt: _ignored, ...current } = endpoint;
    return Promise.resolve(structuredClone({ event, endpoint: current }));
  }

  /** Kết thúc `failed` nếu còn giữ quyền; không đụng attempt, `attemptCount`, `lastError`. */
  failForEndpoint(
    claim: ClaimedDelivery,
    input: FailForEndpointInput,
  ): Promise<GuardedWriteResult> {
    const delivery = this.leased(claim);
    if (!delivery) return Promise.resolve('lease_lost');
    Object.assign(delivery, {
      status: 'failed',
      failedReason: input.reason,
      leaseUntil: null,
      leaseToken: null,
      updatedAt: input.now,
    });
    return Promise.resolve('done');
  }

  /** Ghi attempt + cập nhật delivery + `firstFailureAt`, chỉ khi còn giữ quyền. */
  recordAttempt(
    claim: ClaimedDelivery,
    input: RecordAttemptInput,
  ): Promise<GuardedWriteResult> {
    const delivery = this.leased(claim);
    if (!delivery) return Promise.resolve('lease_lost');
    const { attempt, decision, lastError, now } = input;
    const history = this.attempts.filter((a) => a.deliveryId === delivery.id);
    this.attempts.push({
      ...attempt,
      deliveryId: delivery.id,
      attemptNumber: Math.max(0, ...history.map((a) => a.attemptNumber)) + 1,
    });
    Object.assign(delivery, {
      status: decision.status,
      failedReason: decision.status === 'failed' ? decision.reason : null,
      attemptCount: delivery.attemptCount + 1,
      nextAttemptAt:
        decision.status === 'pending'
          ? decision.nextAttemptAt
          : delivery.nextAttemptAt,
      leaseUntil: null,
      leaseToken: null,
      lastError,
      gateBlockedCount: 0,
      updatedAt: now,
    });
    const endpoint = this.endpoints.get(delivery.endpointId);
    if (endpoint) {
      endpoint.firstFailureAt =
        decision.status === 'succeeded'
          ? null
          : (endpoint.firstFailureAt ?? now);
    }
    return Promise.resolve('done');
  }

  /** Delivery còn `in_flight` với đúng mã của `claim`, hoặc `undefined` nếu đã mất quyền. */
  private leased(claim: ClaimedDelivery): FakeDelivery | undefined {
    const delivery = this.deliveries.get(claim.id);
    return delivery?.status === 'in_flight' &&
      delivery.leaseToken === claim.leaseToken
      ? delivery
      : undefined;
  }
}
