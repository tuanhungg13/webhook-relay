import { randomUUID } from 'node:crypto';
import { type Id, newId } from '../../src/core/id.js';
import type { DeliveryDecision } from '../../src/core/retry-policy.js';
import type {
  ClaimedDelivery,
  DeliveryStore,
  NewAttempt,
} from '../../src/features/delivery/ports/delivery-store.port.js';

/** "Bây giờ" của các ca test; mọi mốc khác tính từ đây. */
export const NOW = new Date('2026-10-08T10:00:00Z');
/** Lease dùng trong test: 30 giây như mặc định. */
export const LEASE_MS = 30_000;
/** Sự kiện mà harness phải dựng cho mọi delivery (để kiểm `loadTarget`). */
export const SEED_EVENT = {
  type: 'order.created',
  createdAt: new Date('2026-10-08T09:00:00Z'),
  payload: { order_id: 'o1' },
};
/** Endpoint mà harness phải dựng cho mọi delivery; xóa/tắt thì mốc là `SEED_GONE_AT`. */
export const SEED_ENDPOINT = {
  url: 'https://shop.example/hook',
  secret: 'whsec_current',
  previousSecret: 'whsec_previous',
  previousSecretExpiresAt: new Date('2026-10-09T09:00:00Z'),
};
/** Mốc xóa / vô hiệu hóa endpoint của harness. */
export const SEED_GONE_AT = new Date('2026-10-08T09:30:00Z');

/** Trạng thái ban đầu của một delivery mà test cần dựng. */
export interface DeliverySeed {
  /** Mặc định `pending`. */
  status?: 'pending' | 'in_flight';
  /** Mặc định 1 phút trước `NOW` (đã đến hạn). */
  nextAttemptAt?: Date;
  /** Bắt buộc khi `in_flight`. */
  leaseUntil?: Date;
  /** Mã giữ quyền khi `in_flight`; mặc định một UUID mới. */
  leaseToken?: string;
  attemptCount?: number;
  /** Số attempt đã có sẵn trong lịch sử (đánh số 1..n). */
  priorAttempts?: number;
  lastError?: string | null;
  gateBlockedCount?: number;
  /** Trạng thái endpoint của delivery; mặc định `active`. */
  endpoint?: 'active' | 'deleted' | 'disabled';
}

/** Ảnh chụp một delivery để test so sánh. */
export interface DeliveryView {
  status: 'pending' | 'in_flight' | 'succeeded' | 'failed';
  failedReason: string | null;
  attemptCount: number;
  nextAttemptAt: Date;
  leaseUntil: Date | null;
  leaseToken: string | null;
  lastError: string | null;
  gateBlockedCount: number;
}

/** Ảnh chụp một attempt đã ghi. */
export interface AttemptView {
  attemptNumber: number;
  httpStatus: number | null;
  error: string | null;
  responseSnippet: string | null;
  durationMs: number;
}

/** Bản `DeliveryStore` cần kiểm, kèm hàm dựng dữ liệu và hàm đọc lại trạng thái. */
export interface DeliveryStoreHarness {
  store: DeliveryStore;
  addDelivery: (seed?: DeliverySeed) => Promise<Id<'delivery'>>;
  readDelivery: (id: Id<'delivery'>) => Promise<DeliveryView>;
  readAttempts: (id: Id<'delivery'>) => Promise<AttemptView[]>;
  /** `first_failure_at` của endpoint mà delivery `id` trỏ tới. */
  firstFailureAt: (id: Id<'delivery'>) => Promise<Date | null>;
  cleanup?: () => Promise<void>;
}

/** Mốc cách `NOW` một khoảng `ms` (âm là quá khứ). */
export const at = (ms: number) => new Date(NOW.getTime() + ms);

/** Một attempt lỗi HTTP `status` bắt đầu lúc `startedAt`. */
export function httpAttempt(status: number, startedAt = NOW): NewAttempt {
  return {
    id: newId('attempt', startedAt.getTime()),
    startedAt,
    durationMs: 120,
    httpStatus: status,
    responseSnippet: `body ${status}`,
    error: null,
  };
}

/** Quyết định "hẹn lại sau 5 giây". */
export const RETRY_IN_5S: DeliveryDecision = {
  status: 'pending',
  nextAttemptAt: at(5_000),
};

/**
 * Bộ contract test của port `DeliveryStore` (ARCH-21): bản Postgres và bản giả in-memory chạy
 * đúng các ca này. Ca tranh chấp nhiều kết nối (I1, I2) chỉ có ở bản Postgres.
 *
 * `setup` được gọi trước mỗi ca và phải trả về store RỖNG.
 */
export function describeDeliveryStoreContract(
  name: string,
  setup: () => Promise<DeliveryStoreHarness>,
): void {
  describe(`DeliveryStore contract: ${name}`, () => {
    let h: DeliveryStoreHarness;
    /** Giành quyền ở `now` với lease 30s, tối đa `limit` delivery. */
    const claim = (now = NOW, limit = 10) =>
      h.store.claimDue({
        now,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        limit,
      });
    /** Giành quyền đúng một delivery, ném lỗi nếu không ra đúng một. */
    const claimOne = async (now = NOW): Promise<ClaimedDelivery> => {
      const claims = await claim(now);
      if (claims.length !== 1) throw new Error(`claimed ${claims.length}`);
      return claims[0]!;
    };
    /** Ghi attempt lỗi `status` với quyết định `decision`. */
    const recordFailure = (
      c: ClaimedDelivery,
      decision: DeliveryDecision = RETRY_IN_5S,
      now = NOW,
    ) =>
      h.store.recordAttempt(c, {
        attempt: httpAttempt(503, now),
        decision,
        lastError: 'http 503',
        now,
      });

    beforeEach(async () => {
      h = await setup();
    });
    afterEach(async () => {
      await h.cleanup?.();
    });

    it('claims only pending deliveries that are due, with 1s of clock skew (C1)', async () => {
      const due = await h.addDelivery({ nextAttemptAt: at(-60_000) });
      const almostDue = await h.addDelivery({ nextAttemptAt: at(500) });
      await h.addDelivery({ nextAttemptAt: at(2_000) });

      const claims = await claim();

      expect(claims.map((c) => c.id).sort()).toEqual([due, almostDue].sort());
      for (const c of claims) {
        expect(c.attemptCount).toBe(0);
        const view = await h.readDelivery(c.id);
        expect(view).toMatchObject({
          status: 'in_flight',
          leaseUntil: at(LEASE_MS),
          leaseToken: c.leaseToken,
        });
      }
      expect(claims[0]!.leaseToken).not.toBe(claims[1]!.leaseToken);
    });

    it('reclaims an in_flight delivery whose lease expired, with a new token (C2)', async () => {
      const oldToken = randomUUID();
      const expired = await h.addDelivery({
        status: 'in_flight',
        leaseUntil: at(-1_000),
        leaseToken: oldToken,
        attemptCount: 2,
      });
      await h.addDelivery({ status: 'in_flight', leaseUntil: at(10_000) });

      const claims = await claim();

      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({ id: expired, attemptCount: 2 });
      expect(claims[0]!.leaseToken).not.toBe(oldToken);
      expect((await h.readDelivery(expired)).leaseUntil).toEqual(at(LEASE_MS));
    });

    it('gives expired leases at most half of the batch (C8)', async () => {
      // `attemptCount` đánh dấu nguồn: 5 = hết lease, 0 = đến hạn.
      for (let i = 0; i < 3; i++) {
        await h.addDelivery({
          status: 'in_flight',
          leaseUntil: at(-1_000 - i),
          attemptCount: 5,
        });
        await h.addDelivery();
      }

      const sources = (claims: ClaimedDelivery[]) =>
        claims.map((c) => c.attemptCount).sort((a, b) => a - b);
      expect(sources(await claim(NOW, 4))).toEqual([0, 0, 5, 5]);
      // Lượt sau (lease vừa giành còn hạn) chỉ còn 1 hết lease + 1 đến hạn.
      expect(sources(await claim(NOW, 10))).toEqual([0, 5]);
    });

    it('fills the batch with due deliveries when no lease expired (C8)', async () => {
      for (let i = 0; i < 4; i++) await h.addDelivery();
      expect(await claim(NOW, 4)).toHaveLength(4);
    });

    it('loads the event and the current endpoint (WRK-06)', async () => {
      await h.addDelivery({ endpoint: 'disabled' });
      const c = await claimOne();

      const target = await h.store.loadTarget(c);

      expect(target.event).toEqual({ id: c.eventId, ...SEED_EVENT });
      expect(target.endpoint).toEqual({
        ...SEED_ENDPOINT,
        deletedAt: null,
        disabledAt: SEED_GONE_AT,
      });
    });

    it('numbers attempts 1, 2, 3 and applies each decision (C3)', async () => {
      const id = await h.addDelivery({ gateBlockedCount: 2 });

      const first = await claimOne();
      expect(await recordFailure(first)).toBe('done');
      expect(await h.readDelivery(id)).toEqual({
        status: 'pending',
        failedReason: null,
        attemptCount: 1,
        nextAttemptAt: at(5_000),
        leaseUntil: null,
        leaseToken: null,
        lastError: 'http 503',
        gateBlockedCount: 0,
      });

      const second = await claimOne(at(5_000));
      await recordFailure(
        second,
        { status: 'failed', reason: 'exhausted' },
        at(5_000),
      );
      expect(await h.readDelivery(id)).toMatchObject({
        status: 'failed',
        failedReason: 'exhausted',
        attemptCount: 2,
        nextAttemptAt: at(5_000),
        leaseToken: null,
      });

      const attempts = await h.readAttempts(id);
      expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2]);
      expect(attempts[0]).toEqual({
        attemptNumber: 1,
        httpStatus: 503,
        error: null,
        responseSnippet: 'body 503',
        durationMs: 120,
      });
    });

    it('marks a success, clears last_error and keeps next_attempt_at (C3)', async () => {
      const id = await h.addDelivery({
        lastError: 'timeout',
        nextAttemptAt: at(-60_000),
      });
      const c = await claimOne();

      await h.store.recordAttempt(c, {
        attempt: httpAttempt(200),
        decision: { status: 'succeeded' },
        lastError: null,
        now: NOW,
      });

      expect(await h.readDelivery(id)).toMatchObject({
        status: 'succeeded',
        attemptCount: 1,
        nextAttemptAt: at(-60_000),
        lastError: null,
        leaseUntil: null,
        leaseToken: null,
      });
    });

    it('records an attempt without HTTP status as an error label', async () => {
      const id = await h.addDelivery();
      const c = await claimOne();

      await h.store.recordAttempt(c, {
        attempt: {
          ...httpAttempt(0),
          httpStatus: null,
          responseSnippet: null,
          error: 'connection_error',
        },
        decision: RETRY_IN_5S,
        lastError: 'connection_error',
        now: NOW,
      });

      expect(await h.readAttempts(id)).toEqual([
        expect.objectContaining({
          httpStatus: null,
          error: 'connection_error',
        }),
      ]);
    });

    it('rejects a write with a stale token and records nothing (C3, WRK-09)', async () => {
      const id = await h.addDelivery();
      const c = await claimOne();

      expect(await recordFailure({ ...c, leaseToken: randomUUID() })).toBe(
        'lease_lost',
      );

      expect(await h.readAttempts(id)).toEqual([]);
      expect(await h.readDelivery(id)).toMatchObject({
        status: 'in_flight',
        attemptCount: 0,
        leaseToken: c.leaseToken,
      });
    });

    it('keeps the result of the worker that reclaimed the lease (KB6, I3)', async () => {
      const id = await h.addDelivery();
      const slow = await claimOne();
      const fast = await claimOne(at(LEASE_MS + 1));

      await h.store.recordAttempt(fast, {
        attempt: httpAttempt(200, at(LEASE_MS + 1)),
        decision: { status: 'succeeded' },
        lastError: null,
        now: at(LEASE_MS + 2),
      });
      expect(await recordFailure(slow)).toBe('lease_lost');

      expect((await h.readDelivery(id)).status).toBe('succeeded');
      expect(await h.readAttempts(id)).toHaveLength(1);
    });

    it('continues attempt numbers after a replay reset attempt_count (C4, WRK-08)', async () => {
      const id = await h.addDelivery({ priorAttempts: 3, attemptCount: 0 });
      const c = await claimOne();

      await recordFailure(c);

      expect((await h.readAttempts(id)).map((a) => a.attemptNumber)).toEqual([
        1, 2, 3, 4,
      ]);
      expect((await h.readDelivery(id)).attemptCount).toBe(1);
    });

    it('fails a delivery for a gone endpoint without an attempt (C5, C7)', async () => {
      const id = await h.addDelivery({
        lastError: 'http 500',
        attemptCount: 2,
      });
      const c = await claimOne();

      expect(
        await h.store.failForEndpoint(c, {
          reason: 'endpoint_deleted',
          now: NOW,
        }),
      ).toBe('done');

      expect(await h.readDelivery(id)).toMatchObject({
        status: 'failed',
        failedReason: 'endpoint_deleted',
        attemptCount: 2,
        lastError: 'http 500',
        leaseUntil: null,
        leaseToken: null,
      });
      expect(await h.readAttempts(id)).toEqual([]);
    });

    it('refuses failForEndpoint with a stale token (C5)', async () => {
      const id = await h.addDelivery();
      const c = await claimOne();

      expect(
        await h.store.failForEndpoint(
          { ...c, leaseToken: randomUUID() },
          { reason: 'endpoint_disabled', now: NOW },
        ),
      ).toBe('lease_lost');
      expect((await h.readDelivery(id)).status).toBe('in_flight');
    });

    it('sets first_failure_at once and clears it on success (C6, RTY-10)', async () => {
      const id = await h.addDelivery();

      await recordFailure(await claimOne());
      expect(await h.firstFailureAt(id)).toEqual(NOW);

      await recordFailure(await claimOne(at(5_000)), RETRY_IN_5S, at(5_000));
      expect(await h.firstFailureAt(id)).toEqual(NOW);

      const last = await claimOne(at(10_000));
      await h.store.recordAttempt(last, {
        attempt: httpAttempt(200, at(10_000)),
        decision: { status: 'succeeded' },
        lastError: null,
        now: at(10_000),
      });
      expect(await h.firstFailureAt(id)).toBeNull();
    });
  });
}
