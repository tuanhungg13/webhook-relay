import { generateApiKey } from '../../src/core/api-key.js';
import { newId } from '../../src/core/id.js';
import type { AccessStore } from '../../src/features/access/access-store.port.js';

/** Bản `AccessStore` cần kiểm, kèm hàm dọn dẹp (đóng pool, xóa database...) nếu có. */
export interface AccessStoreHarness {
  store: AccessStore;
  cleanup?: () => Promise<void>;
}

/**
 * Bộ contract test của port `AccessStore` (ARCH-21): mọi bản hiện thực (Postgres, bản giả
 * in-memory) chạy đúng các ca này, nên hành vi của chúng không thể lệch nhau.
 *
 * `setup` được gọi trước mỗi ca và phải trả về store RỖNG.
 */
export function describeAccessStoreContract(
  name: string,
  setup: () => Promise<AccessStoreHarness>,
): void {
  describe(`AccessStore contract: ${name}`, () => {
    let store: AccessStore;
    let cleanup: (() => Promise<void>) | undefined;
    const now = new Date('2026-10-06T10:00:00Z');

    beforeEach(async () => {
      ({ store, cleanup } = await setup());
    });

    afterEach(async () => {
      await cleanup?.();
    });

    /** Tạo app và một key cho app đó, trả về mọi thứ test cần. */
    async function seedKey() {
      const appId = newId('app', now.getTime());
      await store.insertApp({ id: appId, name: 'ShopX', createdAt: now });
      const keyId = newId('apiKey', now.getTime());
      const { hash, prefix } = generateApiKey();
      const outcome = await store.insertApiKey({
        id: keyId,
        appId,
        keyHash: hash,
        prefix,
        createdAt: now,
      });
      return { appId, keyId, hash, prefix, outcome };
    }

    it('C1: inserts a key and finds it by hash', async () => {
      const { appId, keyId, hash, prefix, outcome } = await seedKey();
      expect(outcome).toBe('inserted');
      expect(await store.findActiveKeyByHash(hash)).toEqual({
        keyId,
        appId,
        prefix,
      });
    });

    it('C2: refuses a key for an unknown app and writes nothing', async () => {
      const { hash, prefix } = generateApiKey();
      const outcome = await store.insertApiKey({
        id: newId('apiKey', now.getTime()),
        appId: newId('app', now.getTime()),
        keyHash: hash,
        prefix,
        createdAt: now,
      });
      expect(outcome).toBe('app_not_found');
      expect(await store.findActiveKeyByHash(hash)).toBeNull();
    });

    it('C3: revoking an unknown key returns null', async () => {
      expect(
        await store.revokeApiKey(newId('apiKey', now.getTime()), now),
      ).toBeNull();
    });

    it('C4: revoking twice returns the first revocation time', async () => {
      const { keyId } = await seedKey();
      const first = new Date('2026-10-06T11:00:00Z');
      const second = new Date('2026-10-06T12:00:00Z');
      expect(await store.revokeApiKey(keyId, first)).toEqual(first);
      expect(await store.revokeApiKey(keyId, second)).toEqual(first);
    });

    it('C5: a revoked key is no longer found', async () => {
      const { keyId, hash } = await seedKey();
      await store.revokeApiKey(keyId, now);
      expect(await store.findActiveKeyByHash(hash)).toBeNull();
    });

    it('C6: an unknown hash returns null', async () => {
      await seedKey();
      expect(await store.findActiveKeyByHash(generateApiKey().hash)).toBeNull();
    });
  });
}
