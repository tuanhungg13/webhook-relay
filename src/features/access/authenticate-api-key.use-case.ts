import { hashApiKey } from '../../core/api-key.js';
import type { AuthenticatedApp } from '../../platform/http/current-app.js';
import type { AccessStore } from './access-store.port.js';

/**
 * Use case: xác thực một API key mà App gửi lên (API-02).
 *
 * Chưa có cache: mỗi lần gọi là một truy vấn Postgres (cache là việc của giai đoạn 3).
 */
export class AuthenticateApiKey {
  constructor(private readonly store: AccessStore) {}

  /**
   * Trả về app sở hữu key nếu key còn hiệu lực, ngược lại trả null.
   * Key không tồn tại và key đã thu hồi cho cùng kết quả null để không lộ khác biệt (API-03).
   * Lỗi database được ném tiếp, bên gọi quyết định trả 503.
   */
  async execute(input: { apiKey: string }): Promise<AuthenticatedApp | null> {
    // Server chỉ lưu hash của key, nên băm key nhận được rồi tra theo hash.
    const found = await this.store.findActiveKeyByHash(
      hashApiKey(input.apiKey),
    );
    if (!found) return null;
    return { appId: found.appId, keyPrefix: found.prefix };
  }
}
