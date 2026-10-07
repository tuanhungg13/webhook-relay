import type { Id } from '../../../core/id.js';
import type { EventStore, EventSummary } from '../ports/event-store.port.js';

/**
 * Kết quả danh sách: một trang (`nextAfterId` là ID cuối trang để lấy trang sau, null khi hết)
 * hoặc `'invalid_cursor'` khi cursor không trỏ tới sự kiện của (app, customer) này.
 */
export type ListEventsResult =
  | { status: 'ok'; events: EventSummary[]; nextAfterId: Id<'event'> | null }
  | { status: 'invalid_cursor' };

/** Use case: danh sách sự kiện của một customer, mới nhất trước, phân trang (API-10). */
export class ListEvents {
  constructor(private readonly store: EventStore) {}

  /**
   * Lấy tối đa `limit` sự kiện cũ hơn `afterId` (nếu có). Xin thêm một phần tử (`limit + 1`) để
   * biết còn trang sau hay không mà không cần đếm: có phần tử thừa nghĩa là còn.
   */
  async execute(input: {
    appId: Id<'app'>;
    customerId: string;
    type?: string;
    afterId?: Id<'event'>;
    limit: number;
  }): Promise<ListEventsResult> {
    const { appId, limit, ...filter } = input;
    const found = await this.store.list(appId, { ...filter, limit: limit + 1 });
    if (found === 'invalid_cursor') return { status: 'invalid_cursor' };
    const events = found.slice(0, limit);
    const hasMore = found.length > limit;
    return {
      status: 'ok',
      events,
      nextAfterId: hasMore ? (events.at(-1)?.id ?? null) : null,
    };
  }
}
