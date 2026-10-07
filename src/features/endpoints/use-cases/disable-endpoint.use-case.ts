import type { Id } from '../../../core/id.js';
import type { Clock } from '../../../platform/clock.js';
import type { EndpointStore } from '../ports/endpoint-store.port.js';

/** Kết quả vô hiệu hóa endpoint: đã vô hiệu hóa, hoặc không tìm thấy. */
export type DisableEndpointResult =
  { status: 'disabled' } | { status: 'not_found' };

/**
 * Use case: App tạm dừng gửi webhook tới endpoint (lý do `manual`).
 * Idempotent: gọi lần hai giữ nguyên thời điểm và lý do của lần đầu.
 */
export class DisableEndpoint {
  constructor(
    private readonly store: EndpointStore,
    private readonly clock: Clock,
  ) {}

  /** Vô hiệu hóa endpoint `input.id` của app `input.appId` tại giờ hiện tại. */
  async execute(input: {
    appId: Id<'app'>;
    id: Id<'endpoint'>;
  }): Promise<DisableEndpointResult> {
    const found = await this.store.disable(
      input.appId,
      input.id,
      this.clock.now(),
    );
    return { status: found ? 'disabled' : 'not_found' };
  }
}
