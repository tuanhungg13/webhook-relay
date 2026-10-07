import type { Id } from '../../core/id.js';

/**
 * Các thao tác đọc/ghi dữ liệu mà use case quản lý app và API key cần.
 *
 * Đây là một "port": chỉ mô tả CẦN LÀM GÌ, không nói làm bằng cách nào. Bản chạy thật là
 * `PostgresAccessStore` (thư mục adapters/postgres). Use case chỉ biết interface này, nên đổi
 * cách lưu trữ hoặc dùng bản giả khi test thì không phải sửa use case.
 */
export interface AccessStore {
  /** Lưu một app mới. */
  insertApp(app: {
    id: Id<'app'>;
    name: string;
    createdAt: Date;
  }): Promise<void>;

  /**
   * Lưu một API key mới cho app `appId`.
   * Trả về `'inserted'` nếu lưu được; `'app_not_found'` nếu app không tồn tại (khi đó không ghi gì).
   */
  insertApiKey(key: {
    id: Id<'apiKey'>;
    appId: Id<'app'>;
    keyHash: Buffer;
    prefix: string;
    createdAt: Date;
  }): Promise<'inserted' | 'app_not_found'>;

  /**
   * Đánh dấu key đã bị thu hồi tại thời điểm `at`, rồi trả về thời điểm thu hồi có hiệu lực.
   * Key đã bị thu hồi từ trước thì giữ nguyên và trả về thời điểm thu hồi LẦN ĐẦU.
   * Key không tồn tại thì trả về null.
   */
  revokeApiKey(id: Id<'apiKey'>, at: Date): Promise<Date | null>;

  /**
   * Tìm key CÒN HIỆU LỰC theo hash SHA-256 của nó (API-02).
   * Key đã thu hồi hoặc không có thì đều trả về null: bên gọi không được phân biệt hai trường hợp (API-03).
   */
  findActiveKeyByHash(hash: Buffer): Promise<ActiveApiKey | null>;
}

/** Thông tin của một key còn hiệu lực: ID key, app sở hữu nó và prefix (8 ký tự đầu, dùng khi log). */
export interface ActiveApiKey {
  keyId: Id<'apiKey'>;
  appId: Id<'app'>;
  prefix: string;
}
