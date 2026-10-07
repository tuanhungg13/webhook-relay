import type { Id } from '../../../core/id.js';
import type { Endpoint, EndpointStore } from '../ports/endpoint-store.port.js';

/** Một trang endpoint; `nextAfterId` là ID cuối trang để lấy trang sau, null khi đã hết. */
export interface EndpointPage {
  endpoints: Endpoint[];
  nextAfterId: Id<'endpoint'> | null;
}

/** Use case: danh sách endpoint của app, mới nhất trước, phân trang (API-10). */
export class ListEndpoints {
  constructor(private readonly store: EndpointStore) {}

  /**
   * Lấy tối đa `limit` endpoint cũ hơn `afterId` (nếu có), lọc theo `customerId` (nếu có).
   *
   * Xin thêm một phần tử (`limit + 1`) để biết còn trang sau hay không mà không cần đếm:
   * có phần tử thừa nghĩa là còn.
   */
  async execute(input: {
    appId: Id<'app'>;
    customerId?: string;
    afterId?: Id<'endpoint'>;
    limit: number;
  }): Promise<EndpointPage> {
    const { appId, limit, ...filter } = input;
    const found = await this.store.list(appId, { ...filter, limit: limit + 1 });
    const endpoints = found.slice(0, limit);
    const hasMore = found.length > limit;
    return {
      endpoints,
      nextAfterId: hasMore ? (endpoints.at(-1)?.id ?? null) : null,
    };
  }
}
