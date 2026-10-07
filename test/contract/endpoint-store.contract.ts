import { type Id, newId } from '../../src/core/id.js';
import type {
  Endpoint,
  EndpointStore,
} from '../../src/features/endpoints/ports/endpoint-store.port.js';

/**
 * Bản `EndpointStore` cần kiểm, kèm hàm tạo app (bản Postgres cần app có thật vì khóa ngoại)
 * và hàm dọn dẹp nếu có.
 */
export interface EndpointStoreHarness {
  store: EndpointStore;
  createApp: () => Promise<Id<'app'>>;
  cleanup?: () => Promise<void>;
}

/** Giờ gốc của các ca test; endpoint thứ n được tạo sau đó n giây để thứ tự ID rõ ràng. */
const BASE_TIME = Date.parse('2026-10-06T10:00:00Z');

/** Dựng một endpoint đầy đủ trường cho `appId`, tạo ở giây thứ `second` sau giờ gốc. */
export function buildEndpoint(
  appId: Id<'app'>,
  overrides: Partial<Endpoint> & { second?: number } = {},
): Endpoint {
  const { second = 0, ...fields } = overrides;
  const createdAt = new Date(BASE_TIME + second * 1000);
  return {
    id: newId('endpoint', createdAt.getTime()),
    appId,
    customerId: 'cus_1',
    url: 'https://shop.example/hook',
    eventTypes: ['order.created'],
    secret: 'whsec_current',
    previousSecret: null,
    previousSecretExpiresAt: null,
    rateLimitRps: 50,
    maxConcurrency: 10,
    firstFailureAt: null,
    disabledAt: null,
    disabledReason: null,
    createdAt,
    updatedAt: createdAt,
    ...fields,
  };
}

/**
 * Bộ contract test của port `EndpointStore` (ARCH-21): bản Postgres và bản giả in-memory chạy
 * đúng các ca này. Ca đồng thời (EC9) chỉ có ở bản Postgres vì bản giả chạy một luồng.
 *
 * `setup` được gọi trước mỗi ca và phải trả về store RỖNG.
 */
export function describeEndpointStoreContract(
  name: string,
  setup: () => Promise<EndpointStoreHarness>,
): void {
  describe(`EndpointStore contract: ${name}`, () => {
    let store: EndpointStore;
    let appId: Id<'app'>;
    let otherAppId: Id<'app'>;
    let cleanup: (() => Promise<void>) | undefined;
    const later = new Date(BASE_TIME + 3_600_000);

    beforeEach(async () => {
      const harness = await setup();
      ({ store, cleanup } = harness);
      appId = await harness.createApp();
      otherAppId = await harness.createApp();
    });

    afterEach(async () => {
      await cleanup?.();
    });

    /** Chèn endpoint với giới hạn rộng, ném lỗi nếu không chèn được. */
    async function insert(endpoint: Endpoint): Promise<Endpoint> {
      expect(await store.insertWithinLimit(endpoint, 100)).toBe('inserted');
      return endpoint;
    }

    it('EC1: inserts and finds by id only within the owning app', async () => {
      const endpoint = await insert(
        buildEndpoint(appId, {
          eventTypes: ['order.created', 'order.paid'],
          previousSecret: 'whsec_old',
          previousSecretExpiresAt: later,
        }),
      );
      expect(await store.findById(appId, endpoint.id)).toEqual(endpoint);
      expect(await store.findById(otherAppId, endpoint.id)).toBeNull();
      expect(
        await store.findById(appId, newId('endpoint', BASE_TIME)),
      ).toBeNull();
    });

    it('EC2: refuses to insert past the limit and writes nothing', async () => {
      await insert(buildEndpoint(appId, { second: 1 }));
      await insert(buildEndpoint(appId, { second: 2 }));
      const third = buildEndpoint(appId, { second: 3 });

      expect(await store.insertWithinLimit(third, 2)).toBe('limit_exceeded');
      expect(await store.findById(appId, third.id)).toBeNull();
      // Giới hạn tính theo (app, customer): customer khác và app khác không bị ảnh hưởng.
      expect(
        await store.insertWithinLimit(
          buildEndpoint(appId, { customerId: 'cus_2' }),
          2,
        ),
      ).toBe('inserted');
      expect(await store.insertWithinLimit(buildEndpoint(otherAppId), 2)).toBe(
        'inserted',
      );
    });

    it('EC3: soft-deleted endpoints are gone and free a slot; disabled ones still count', async () => {
      const deleted = await insert(buildEndpoint(appId, { second: 1 }));
      const disabled = await insert(buildEndpoint(appId, { second: 2 }));
      await store.softDelete(appId, deleted.id, later);
      await store.disable(appId, disabled.id, later);

      expect(await store.findById(appId, deleted.id)).toBeNull();
      expect(await store.insertWithinLimit(buildEndpoint(appId), 2)).toBe(
        'inserted',
      );
      expect(await store.insertWithinLimit(buildEndpoint(appId), 2)).toBe(
        'limit_exceeded',
      );
    });

    it('EC4: update changes only the given fields and updatedAt', async () => {
      const endpoint = await insert(buildEndpoint(appId));

      const updated = await store.update(
        appId,
        endpoint.id,
        { url: 'https://new.example/hook', maxConcurrency: 3 },
        later,
      );
      expect(updated).toEqual({
        ...endpoint,
        url: 'https://new.example/hook',
        maxConcurrency: 3,
        updatedAt: later,
      });
      expect(await store.findById(appId, endpoint.id)).toEqual(updated);

      const again = await store.update(
        appId,
        endpoint.id,
        { url: undefined, eventTypes: ['a.b', 'c.d'], rateLimitRps: 7 },
        later,
      );
      expect(again).toMatchObject({
        url: 'https://new.example/hook',
        eventTypes: ['a.b', 'c.d'],
        rateLimitRps: 7,
        maxConcurrency: 3,
      });
    });

    it('EC4: update of an unknown, foreign or deleted endpoint returns null', async () => {
      const endpoint = await insert(buildEndpoint(appId));
      const patch = { rateLimitRps: 1 };
      expect(
        await store.update(otherAppId, endpoint.id, patch, later),
      ).toBeNull();
      expect(
        await store.update(appId, newId('endpoint', BASE_TIME), patch, later),
      ).toBeNull();
      await store.softDelete(appId, endpoint.id, later);
      expect(await store.update(appId, endpoint.id, patch, later)).toBeNull();
    });

    it('EC5: disable keeps the first time and reason; enable clears failure fields', async () => {
      const endpoint = await insert(
        buildEndpoint(appId, { firstFailureAt: new Date(BASE_TIME) }),
      );
      const first = new Date(BASE_TIME + 1000);
      const second = new Date(BASE_TIME + 2000);

      expect(await store.disable(appId, endpoint.id, first)).toBe(true);
      expect(await store.disable(appId, endpoint.id, second)).toBe(true);
      expect(await store.findById(appId, endpoint.id)).toMatchObject({
        disabledAt: first,
        disabledReason: 'manual',
      });

      expect(await store.enable(appId, endpoint.id, second)).toBe(true);
      expect(await store.findById(appId, endpoint.id)).toMatchObject({
        firstFailureAt: null,
        disabledAt: null,
        disabledReason: null,
      });
      // Kích hoạt khi đang hoạt động vẫn thành công.
      expect(await store.enable(appId, endpoint.id, second)).toBe(true);
    });

    it('EC5: disable/enable of a foreign or unknown endpoint returns false', async () => {
      const endpoint = await insert(buildEndpoint(appId));
      expect(await store.disable(otherAppId, endpoint.id, later)).toBe(false);
      expect(await store.enable(otherAppId, endpoint.id, later)).toBe(false);
      const unknown = newId('endpoint', BASE_TIME);
      expect(await store.disable(appId, unknown, later)).toBe(false);
      expect(await store.enable(appId, unknown, later)).toBe(false);
    });

    it('EC6: softDelete returns true once, then false', async () => {
      const endpoint = await insert(buildEndpoint(appId));
      expect(await store.softDelete(otherAppId, endpoint.id, later)).toBe(
        false,
      );
      expect(await store.softDelete(appId, endpoint.id, later)).toBe(true);
      expect(await store.softDelete(appId, endpoint.id, later)).toBe(false);
    });

    it('EC7: rotateSecret keeps only the current and the previous secret (API-35)', async () => {
      const endpoint = await insert(buildEndpoint(appId));
      const graceUntil = new Date(BASE_TIME + 86_400_000);

      const once = await store.rotateSecret(appId, endpoint.id, {
        newSecret: 'whsec_second',
        graceUntil,
        at: later,
      });
      expect(once).toEqual({
        ...endpoint,
        secret: 'whsec_second',
        previousSecret: 'whsec_current',
        previousSecretExpiresAt: graceUntil,
        updatedAt: later,
      });

      const twice = await store.rotateSecret(appId, endpoint.id, {
        newSecret: 'whsec_third',
        graceUntil: later,
        at: later,
      });
      expect(twice).toMatchObject({
        secret: 'whsec_third',
        previousSecret: 'whsec_second',
        previousSecretExpiresAt: later,
      });
      expect(
        await store.rotateSecret(otherAppId, endpoint.id, {
          newSecret: 'whsec_x',
          graceUntil,
          at: later,
        }),
      ).toBeNull();
    });

    it('EC8: list is newest first, paginates with afterId, filters by customer', async () => {
      const oldest = await insert(buildEndpoint(appId, { second: 1 }));
      const middle = await insert(
        buildEndpoint(appId, { second: 2, customerId: 'cus_2' }),
      );
      const newest = await insert(buildEndpoint(appId, { second: 3 }));
      const deleted = await insert(buildEndpoint(appId, { second: 4 }));
      await store.softDelete(appId, deleted.id, later);
      await insert(buildEndpoint(otherAppId, { second: 5 }));

      expect(await store.list(appId, { limit: 10 })).toEqual([
        newest,
        middle,
        oldest,
      ]);
      expect(await store.list(appId, { limit: 2 })).toEqual([newest, middle]);
      expect(
        await store.list(appId, { afterId: middle.id, limit: 10 }),
      ).toEqual([oldest]);
      expect(
        await store.list(appId, { customerId: 'cus_1', limit: 10 }),
      ).toEqual([newest, oldest]);
      expect(
        await store.list(appId, {
          customerId: 'cus_1',
          afterId: newest.id,
          limit: 10,
        }),
      ).toEqual([oldest]);
    });
  });
}
