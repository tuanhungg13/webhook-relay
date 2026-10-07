import type { Id } from '../../../core/id.js';
import type { Clock } from '../../../platform/clock.js';
import type { EndpointStore } from '../ports/endpoint-store.port.js';

/** Kết quả xóa endpoint: đã xóa, hoặc không tìm thấy (kể cả đã xóa trước đó, API-33). */
export type DeleteEndpointResult =
  { status: 'deleted' } | { status: 'not_found' };

/**
 * Use case: xóa mềm endpoint. Dòng vẫn còn trong database để delivery cũ tra được; với mọi
 * API endpoint thì nó coi như không tồn tại và không tính vào giới hạn (API-33).
 */
export class DeleteEndpoint {
  constructor(
    private readonly store: EndpointStore,
    private readonly clock: Clock,
  ) {}

  /** Xóa mềm endpoint `input.id` của app `input.appId` tại giờ hiện tại. */
  async execute(input: {
    appId: Id<'app'>;
    id: Id<'endpoint'>;
  }): Promise<DeleteEndpointResult> {
    const deleted = await this.store.softDelete(
      input.appId,
      input.id,
      this.clock.now(),
    );
    return { status: deleted ? 'deleted' : 'not_found' };
  }
}
