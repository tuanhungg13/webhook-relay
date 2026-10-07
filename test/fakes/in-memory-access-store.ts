import type { Id } from '../../src/core/id.js';
import type {
  AccessStore,
  ActiveApiKey,
} from '../../src/features/access/ports/access-store.port.js';

/** Một dòng key trong bộ nhớ: giống bảng `api_keys`, thêm `revokedAt` (null = còn hiệu lực). */
interface StoredKey extends ActiveApiKey {
  revokedAt: Date | null;
}

/**
 * Bản giả của `AccessStore` lưu trong bộ nhớ, dùng cho test không cần Postgres.
 * Phải chạy qua cùng bộ contract test với bản Postgres để hai bản không lệch nhau (ARCH-21).
 */
export class InMemoryAccessStore implements AccessStore {
  private readonly appIds = new Set<Id<'app'>>();
  /** Key lưu theo hash dạng hex (Buffer không dùng trực tiếp làm khóa Map được). */
  private readonly keysByHash = new Map<string, StoredKey>();

  /** Ghi nhớ ID của app (tên và giờ tạo không cần cho test). */
  insertApp(app: { id: Id<'app'> }): Promise<void> {
    this.appIds.add(app.id);
    return Promise.resolve();
  }

  /** Lưu key nếu app đã có; app lạ thì trả `app_not_found` và không lưu gì. */
  insertApiKey(key: {
    id: Id<'apiKey'>;
    appId: Id<'app'>;
    keyHash: Buffer;
    prefix: string;
  }): Promise<'inserted' | 'app_not_found'> {
    if (!this.appIds.has(key.appId)) return Promise.resolve('app_not_found');
    this.keysByHash.set(key.keyHash.toString('hex'), {
      keyId: key.id,
      appId: key.appId,
      prefix: key.prefix,
      revokedAt: null,
    });
    return Promise.resolve('inserted');
  }

  /** Thu hồi key theo ID; lần hai giữ thời điểm lần đầu, ID lạ trả null. */
  revokeApiKey(id: Id<'apiKey'>, at: Date): Promise<Date | null> {
    for (const key of this.keysByHash.values()) {
      if (key.keyId !== id) continue;
      key.revokedAt ??= at; // thu hồi lần hai giữ thời điểm lần đầu
      return Promise.resolve(key.revokedAt);
    }
    return Promise.resolve(null);
  }

  /** Tra key còn hiệu lực theo hash; đã thu hồi hoặc không có thì null. */
  findActiveKeyByHash(hash: Buffer): Promise<ActiveApiKey | null> {
    const key = this.keysByHash.get(hash.toString('hex'));
    if (!key || key.revokedAt) return Promise.resolve(null);
    const { keyId, appId, prefix } = key;
    return Promise.resolve({ keyId, appId, prefix });
  }
}
