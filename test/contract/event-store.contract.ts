import { type Id, newId } from '../../src/core/id.js';
import type {
  EventStore,
  IdempotencyClaim,
  NewEvent,
} from '../../src/features/ingestion/ports/event-store.port.js';

/** Endpoint test cần dựng để thử fan-out. */
export interface EndpointSeed {
  customerId: string;
  eventTypes: string[];
  deleted?: boolean;
  disabled?: boolean;
}

/**
 * Bản `EventStore` cần kiểm, kèm hàm tạo app và hàm dựng endpoint (bản Postgres cần dòng thật
 * vì khóa ngoại; bản giả chỉ ghi nhớ) và hàm dọn dẹp nếu có.
 */
export interface EventStoreHarness {
  store: EventStore;
  createApp: () => Promise<Id<'app'>>;
  addEndpoint: (
    appId: Id<'app'>,
    seed: EndpointSeed,
  ) => Promise<Id<'endpoint'>>;
  cleanup?: () => Promise<void>;
}

/** Giờ gốc của các ca test; sự kiện thứ n được tạo sau đó n giây. */
export const BASE_TIME = Date.parse('2026-10-07T10:00:00Z');
/** Thời hạn khóa idempotency dùng trong test: 24 giờ như mặc định. */
export const TTL_MS = 24 * 3_600_000;

/** Dựng một sự kiện cho `appId`, tạo ở giây thứ `second` sau giờ gốc. */
export function buildEvent(
  appId: Id<'app'>,
  overrides: Partial<NewEvent> & { second?: number } = {},
): NewEvent {
  const { second = 0, ...fields } = overrides;
  const createdAt = new Date(BASE_TIME + second * 1000);
  return {
    id: newId('event', createdAt.getTime()),
    appId,
    customerId: 'cus_1',
    type: 'order.created',
    payload: { order_id: 'o1' },
    createdAt,
    ...fields,
  };
}

/** Khóa idempotency gửi lúc `at`: khóa cũ hơn `at - TTL` bị coi là hết hạn. */
export function buildClaim(
  key: string,
  hash: string,
  at: Date,
): IdempotencyClaim {
  return {
    key,
    requestHash: Buffer.from(hash.padEnd(32, '.')),
    expiresBefore: new Date(at.getTime() - TTL_MS),
  };
}

/**
 * Bộ contract test của port `EventStore` (ARCH-21): bản Postgres và bản giả in-memory chạy đúng
 * các ca này. Các ca đồng thời (EC6–EC8) chỉ có ở bản Postgres vì bản giả chạy một luồng.
 *
 * `setup` được gọi trước mỗi ca và phải trả về store RỖNG.
 */
export function describeEventStoreContract(
  name: string,
  setup: () => Promise<EventStoreHarness>,
): void {
  describe(`EventStore contract: ${name}`, () => {
    let harness: EventStoreHarness;
    let store: EventStore;
    let appId: Id<'app'>;
    let otherAppId: Id<'app'>;

    beforeEach(async () => {
      harness = await setup();
      store = harness.store;
      appId = await harness.createApp();
      otherAppId = await harness.createApp();
    });

    afterEach(async () => {
      await harness.cleanup?.();
    });

    it('EC1: ingest without a key creates the event; findById returns every field', async () => {
      const event = buildEvent(appId, {
        payload: {
          order_id: 'o1',
          items: [1, 2.5, null, true],
          nested: { a: 'é' },
        },
      });

      expect(await store.ingest({ event, idempotency: null })).toEqual({
        status: 'created',
        deliveryCount: 0,
      });
      expect(await store.findById(appId, event.id)).toEqual({
        id: event.id,
        customerId: 'cus_1',
        type: 'order.created',
        createdAt: event.createdAt,
        payload: event.payload,
        deliveries: [],
      });
    });

    it('EC2: fans out to exactly the active endpoints of the customer that want the type', async () => {
      const match1 = await harness.addEndpoint(appId, {
        customerId: 'cus_1',
        eventTypes: ['order.created', 'order.paid'],
      });
      const match2 = await harness.addEndpoint(appId, {
        customerId: 'cus_1',
        eventTypes: ['order.created'],
      });
      await harness.addEndpoint(appId, {
        customerId: 'cus_1',
        eventTypes: ['order.paid'],
      });
      await harness.addEndpoint(appId, {
        customerId: 'cus_1',
        eventTypes: ['order.created'],
        deleted: true,
      });
      await harness.addEndpoint(appId, {
        customerId: 'cus_1',
        eventTypes: ['order.created'],
        disabled: true,
      });
      await harness.addEndpoint(appId, {
        customerId: 'cus_2',
        eventTypes: ['order.created'],
      });
      await harness.addEndpoint(otherAppId, {
        customerId: 'cus_1',
        eventTypes: ['order.created'],
      });
      const event = buildEvent(appId);

      expect(await store.ingest({ event, idempotency: null })).toEqual({
        status: 'created',
        deliveryCount: 2,
      });
      const detail = await store.findById(appId, event.id);
      expect(detail?.deliveries.map((d) => d.endpointId).sort()).toEqual(
        [match1, match2].sort(),
      );
      for (const delivery of detail?.deliveries ?? []) {
        expect(delivery).toMatchObject({ status: 'pending', attemptCount: 0 });
        expect(delivery.id).toMatch(/^del_/);
      }
    });

    it('EC3: same key and hash → duplicate of the first event, nothing written; other hash → conflict', async () => {
      await harness.addEndpoint(appId, {
        customerId: 'cus_1',
        eventTypes: ['order.created'],
      });
      const first = buildEvent(appId);
      const claim = buildClaim('k1', 'hash-a', first.createdAt);
      await store.ingest({ event: first, idempotency: claim });

      const retry = buildEvent(appId, { second: 5 });
      expect(
        await store.ingest({
          event: retry,
          idempotency: buildClaim('k1', 'hash-a', retry.createdAt),
        }),
      ).toEqual({
        status: 'duplicate',
        eventId: first.id,
        createdAt: first.createdAt,
      });
      expect(
        await store.ingest({
          event: buildEvent(appId, { second: 6 }),
          idempotency: buildClaim('k1', 'hash-b', retry.createdAt),
        }),
      ).toEqual({ status: 'conflict' });

      expect(await store.findById(appId, retry.id)).toBeNull();
      expect((await store.findById(appId, first.id))?.deliveries).toHaveLength(
        1,
      );
      expect(
        await store.list(appId, { customerId: 'cus_1', limit: 10 }),
      ).toHaveLength(1);
    });

    it('EC3b: the same key in another app is independent', async () => {
      const mine = buildEvent(appId);
      const theirs = buildEvent(otherAppId);
      const hash = 'hash-a';
      await store.ingest({
        event: mine,
        idempotency: buildClaim('k1', hash, mine.createdAt),
      });
      expect(
        await store.ingest({
          event: theirs,
          idempotency: buildClaim('k1', hash, theirs.createdAt),
        }),
      ).toMatchObject({ status: 'created' });
    });

    it('EC4: an expired key creates a new event, and the very next retry is a duplicate of it', async () => {
      const first = buildEvent(appId);
      await store.ingest({
        event: first,
        idempotency: buildClaim('k1', 'hash-a', first.createdAt),
      });

      const afterExpiry = buildEvent(appId, { second: 25 * 3600 });
      expect(
        await store.ingest({
          event: afterExpiry,
          idempotency: buildClaim('k1', 'hash-a', afterExpiry.createdAt),
        }),
      ).toMatchObject({ status: 'created' });

      // Hồi quy: quên đặt lại created_at của khóa thì lần này lại tạo sự kiện thứ ba.
      const retry = buildEvent(appId, { second: 25 * 3600 + 1 });
      expect(
        await store.ingest({
          event: retry,
          idempotency: buildClaim('k1', 'hash-a', retry.createdAt),
        }),
      ).toEqual({
        status: 'duplicate',
        eventId: afterExpiry.id,
        createdAt: afterExpiry.createdAt,
      });
    });

    it('EC5: reads are scoped to the app; list filters, orders newest first and pages by cursor', async () => {
      const events = [
        buildEvent(appId, { second: 1, type: 'order.created' }),
        buildEvent(appId, { second: 2, type: 'order.paid' }),
        buildEvent(appId, { second: 3, type: 'order.created' }),
        buildEvent(appId, { second: 4, customerId: 'cus_2' }),
      ];
      for (const event of events) {
        await store.ingest({ event, idempotency: null });
      }
      const [e1, e2, e3, e4] = events as [
        NewEvent,
        NewEvent,
        NewEvent,
        NewEvent,
      ];

      expect(await store.findById(otherAppId, e1.id)).toBeNull();
      expect(await store.findById(appId, newId('event', BASE_TIME))).toBeNull();

      const all = await store.list(appId, { customerId: 'cus_1', limit: 10 });
      expect(all).toEqual([
        expect.objectContaining({ id: e3.id }),
        expect.objectContaining({ id: e2.id }),
        expect.objectContaining({ id: e1.id }),
      ]);
      expect(all[0]).not.toHaveProperty('payload');
      expect(
        await store.list(appId, {
          customerId: 'cus_1',
          type: 'order.created',
          limit: 10,
        }),
      ).toEqual([
        expect.objectContaining({ id: e3.id }),
        expect.objectContaining({ id: e1.id }),
      ]);
      expect(
        await store.list(appId, {
          customerId: 'cus_1',
          afterId: e3.id,
          limit: 1,
        }),
      ).toEqual([expect.objectContaining({ id: e2.id })]);
      expect(
        await store.list(otherAppId, { customerId: 'cus_1', limit: 10 }),
      ).toEqual([]);

      // Cursor phải thuộc đúng (app, customer): của app khác, customer khác hay không tồn tại
      // đều là cursor hỏng, không phải trang rỗng (lộ sự tồn tại, API-04).
      for (const [query, cursorOwner] of [
        [{ customerId: 'cus_1', afterId: e1.id }, otherAppId],
        [{ customerId: 'cus_1', afterId: e4.id }, appId],
        [{ customerId: 'cus_1', afterId: newId('event', BASE_TIME) }, appId],
      ] as const) {
        expect(await store.list(cursorOwner, { ...query, limit: 10 })).toBe(
          'invalid_cursor',
        );
      }
    });
  });
}
