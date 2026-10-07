import type {
  DeliveryStatus,
  EventDetail,
  EventSummary,
} from '../ports/event-store.port.js';

/** Phản hồi nhận sự kiện (`202` mới, `200` trùng): chỉ ID và thời gian tạo của sự kiện. */
export interface IngestedEventView {
  id: string;
  created_at: string;
}

/** Sự kiện trong danh sách: không kèm payload cho nhẹ (spec 05). */
export interface EventSummaryView {
  id: string;
  customer_id: string;
  type: string;
  created_at: string;
}

/** Delivery tóm tắt trong chi tiết sự kiện. */
export interface DeliverySummaryView {
  id: string;
  endpoint_id: string;
  status: DeliveryStatus;
  attempt_count: number;
}

/** Chi tiết sự kiện: đủ trường kèm payload và delivery tóm tắt. */
export interface EventDetailView extends EventSummaryView {
  payload: unknown;
  deliveries: DeliverySummaryView[];
}

/** Đổi kết quả nhận sự kiện sang JSON công khai; thời gian dạng RFC 3339 UTC. */
export function toIngestedEventView(event: {
  id: string;
  createdAt: Date;
}): IngestedEventView {
  return { id: event.id, created_at: event.createdAt.toISOString() };
}

/** Đổi `EventSummary` sang JSON công khai. */
export function toEventSummaryView(event: EventSummary): EventSummaryView {
  return {
    id: event.id,
    customer_id: event.customerId,
    type: event.type,
    created_at: event.createdAt.toISOString(),
  };
}

/** Đổi `EventDetail` sang JSON công khai. */
export function toEventDetailView(event: EventDetail): EventDetailView {
  return {
    ...toEventSummaryView(event),
    payload: event.payload,
    deliveries: event.deliveries.map((delivery) => ({
      id: delivery.id,
      endpoint_id: delivery.endpointId,
      status: delivery.status,
      attempt_count: delivery.attemptCount,
    })),
  };
}
