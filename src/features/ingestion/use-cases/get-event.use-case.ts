import type { Id } from '../../../core/id.js';
import type { EventDetail, EventStore } from '../ports/event-store.port.js';

/** Kết quả xem sự kiện: tìm thấy hoặc không (không tồn tại, của app khác: như nhau, API-04). */
export type GetEventResult =
  { status: 'found'; event: EventDetail } | { status: 'not_found' };

/** Use case: xem một sự kiện của app kèm delivery tóm tắt. */
export class GetEvent {
  constructor(private readonly store: EventStore) {}

  /** Đọc sự kiện `input.id` của app `input.appId`. */
  async execute(input: {
    appId: Id<'app'>;
    id: Id<'event'>;
  }): Promise<GetEventResult> {
    const event = await this.store.findById(input.appId, input.id);
    if (!event) return { status: 'not_found' };
    return { status: 'found', event };
  }
}
