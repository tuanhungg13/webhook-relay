import type { Id } from '../../../core/id.js';
import type { Endpoint, EndpointStore } from '../ports/endpoint-store.port.js';

/** Kết quả xem endpoint: tìm thấy hoặc không (không tồn tại, của app khác, đã xóa: như nhau). */
export type GetEndpointResult =
  { status: 'found'; endpoint: Endpoint } | { status: 'not_found' };

/** Use case: xem một endpoint của app. */
export class GetEndpoint {
  constructor(private readonly store: EndpointStore) {}

  /** Đọc endpoint `input.id` của app `input.appId`. */
  async execute(input: {
    appId: Id<'app'>;
    id: Id<'endpoint'>;
  }): Promise<GetEndpointResult> {
    const endpoint = await this.store.findById(input.appId, input.id);
    if (!endpoint) return { status: 'not_found' };
    return { status: 'found', endpoint };
  }
}
