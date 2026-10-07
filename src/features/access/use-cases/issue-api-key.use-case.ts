import { generateApiKey } from '../../../core/api-key.js';
import { type Id, newId } from '../../../core/id.js';
import type { Clock } from '../../../platform/clock.js';
import type { AccessStore } from '../ports/access-store.port.js';

/**
 * Kết quả cấp key, là một trong hai trường hợp, phân biệt bằng `status`:
 * - `'issued'`: cấp thành công, kèm ID của key, key thật và prefix.
 * - `'app_not_found'`: app không tồn tại, không có key nào được tạo.
 */
export type IssueApiKeyResult =
  | { status: 'issued'; keyId: Id<'apiKey'>; apiKey: string; prefix: string }
  | { status: 'app_not_found' };

/**
 * Use case: cấp một API key mới cho app (SEC-10, SEC-11).
 * Key thật chỉ được trả về cho bên gọi đúng một lần; kho dữ liệu chỉ giữ hash và prefix.
 */
export class IssueApiKey {
  constructor(
    private readonly store: AccessStore,
    private readonly clock: Clock,
  ) {}

  /** Cấp key mới cho app `input.appId`. App không tồn tại thì trả `app_not_found`, không ghi gì. */
  async execute(input: { appId: Id<'app'> }): Promise<IssueApiKeyResult> {
    // 1. Lấy giờ hiện tại và sinh ID cho key.
    const now = this.clock.now();
    const keyId = newId('apiKey', now.getTime());
    // 2. Sinh key ngẫu nhiên, kèm hash và prefix của nó.
    const { key, hash, prefix } = generateApiKey();

    // 3. Lưu key: chỉ truyền hash và prefix xuống kho, KHÔNG truyền key thật.
    const outcome = await this.store.insertApiKey({
      id: keyId,
      appId: input.appId,
      keyHash: hash,
      prefix,
      createdAt: now,
    });
    // 4. Trả key thật về cho bên gọi. Đây là lần duy nhất key thật rời khỏi hàm này.
    if (outcome === 'app_not_found') return { status: 'app_not_found' };
    return { status: 'issued', keyId, apiKey: key, prefix };
  }
}
