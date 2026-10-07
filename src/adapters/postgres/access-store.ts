import type pg from 'pg';
import { type Id, idFromUuid, idToUuid } from '../../core/id.js';
import type {
  AccessStore,
  ActiveApiKey,
} from '../../features/access/ports/access-store.port.js';

/**
 * Hiện thực port `AccessStore` bằng Postgres: đọc/ghi bảng `apps` và `api_keys`.
 *
 * - TypeID (vd `app_01h4...`) được đổi sang UUID ở đây, trước khi đưa vào database (DAT-03).
 * - Câu SQL truyền giá trị qua tham số `$1, $2...` (thư viện `pg` gửi riêng giá trị, không ghép
 *   vào chuỗi SQL), nhờ vậy chống được SQL injection.
 */
export class PostgresAccessStore implements AccessStore {
  /** `pool` là nhóm kết nối tới Postgres, do tiến trình trong `apps` tạo rồi truyền vào. */
  constructor(private readonly pool: pg.Pool) {}

  /** Thêm một dòng vào bảng `apps`. */
  async insertApp(app: {
    id: Id<'app'>;
    name: string;
    createdAt: Date;
  }): Promise<void> {
    await this.pool.query(
      'INSERT INTO apps (id, name, created_at) VALUES ($1, $2, $3)',
      [idToUuid(app.id), app.name, app.createdAt],
    );
  }

  /**
   * Thêm một dòng vào bảng `api_keys`, nhưng chỉ khi app tồn tại.
   * Trả về `'inserted'` nếu thêm được, `'app_not_found'` nếu app không có.
   */
  async insertApiKey(key: {
    id: Id<'apiKey'>;
    appId: Id<'app'>;
    keyHash: Buffer;
    prefix: string;
    createdAt: Date;
  }): Promise<'inserted' | 'app_not_found'> {
    // Dạng INSERT ... SELECT ... WHERE EXISTS: app tồn tại thì chèn 1 dòng, không thì chèn 0 dòng.
    // Chỉ cần đếm số dòng đã chèn (rowCount) là biết app có tồn tại không, khỏi phải bắt
    // và phân tích lỗi khóa ngoại của Postgres.
    // `$1::uuid` là ép kiểu: tham số nằm trong SELECT nên Postgres không tự biết kiểu của nó.
    const { rowCount } = await this.pool.query(
      `INSERT INTO api_keys (id, app_id, key_hash, prefix, created_at)
       SELECT $1::uuid, $2::uuid, $3::bytea, $4::text, $5::timestamptz
       WHERE EXISTS (SELECT 1 FROM apps WHERE id = $2::uuid)`,
      [
        idToUuid(key.id),
        idToUuid(key.appId),
        key.keyHash,
        key.prefix,
        key.createdAt,
      ],
    );
    return rowCount === 1 ? 'inserted' : 'app_not_found';
  }

  /**
   * Đặt thời điểm thu hồi `revoked_at` cho key, rồi trả về giá trị `revoked_at` sau khi cập nhật.
   * Không có key nào mang ID này thì trả về null.
   */
  async revokeApiKey(id: Id<'apiKey'>, at: Date): Promise<Date | null> {
    // COALESCE(revoked_at, $2) lấy giá trị khác NULL đầu tiên: key đã bị thu hồi thì giữ
    // thời điểm cũ, chưa thì đặt bằng $2. Nhờ vậy thu hồi lần hai không ghi đè lần đầu.
    // RETURNING trả về giá trị sau khi cập nhật; không dòng nào khớp ID thì `rows` rỗng.
    const { rows } = await this.pool.query<{ revoked_at: Date }>(
      `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, $2)
       WHERE id = $1
       RETURNING revoked_at`,
      [idToUuid(id), at],
    );
    return rows[0]?.revoked_at ?? null;
  }

  /** Tìm key còn hiệu lực theo hash. Không có dòng nào khớp thì trả về null. */
  async findActiveKeyByHash(hash: Buffer): Promise<ActiveApiKey | null> {
    // key_hash có ràng buộc UNIQUE nên đã có chỉ mục: tra theo hash chỉ chạm một dòng.
    // `revoked_at IS NULL` loại key đã thu hồi (NULL nghĩa là chưa bị thu hồi).
    const { rows } = await this.pool.query<{
      id: string;
      app_id: string;
      prefix: string;
    }>(
      `SELECT id, app_id, prefix FROM api_keys
       WHERE key_hash = $1 AND revoked_at IS NULL`,
      [hash],
    );
    const row = rows[0];
    if (!row) return null;
    // Database lưu UUID; đổi sang TypeID trước khi đưa lên tầng trên (DAT-03).
    return {
      keyId: idFromUuid('apiKey', row.id),
      appId: idFromUuid('app', row.app_id),
      prefix: row.prefix,
    };
  }
}
