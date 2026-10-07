import type { Id } from '../../../core/id.js';
import type { Clock } from '../../../platform/clock.js';
import type { AccessStore } from '../ports/access-store.port.js';

/** Kết quả thu hồi key: đã thu hồi (kèm thời điểm thu hồi), hoặc không tìm thấy key. */
export type RevokeApiKeyResult =
  { status: 'revoked'; revokedAt: Date } | { status: 'key_not_found' };

/**
 * Use case: thu hồi (vô hiệu hóa) một API key.
 *
 * Gọi nhiều lần vẫn an toàn (idempotent, nghĩa là làm lại cho cùng kết quả): lần thu hồi sau
 * giữ nguyên thời điểm thu hồi của lần đầu.
 */
export class RevokeApiKey {
  constructor(
    private readonly store: AccessStore,
    private readonly clock: Clock,
  ) {}

  /** Thu hồi key `input.keyId` tại giờ hiện tại. Key không tồn tại thì trả `key_not_found`. */
  async execute(input: { keyId: Id<'apiKey'> }): Promise<RevokeApiKeyResult> {
    const revokedAt = await this.store.revokeApiKey(
      input.keyId,
      this.clock.now(),
    );
    if (!revokedAt) return { status: 'key_not_found' };
    return { status: 'revoked', revokedAt };
  }
}
