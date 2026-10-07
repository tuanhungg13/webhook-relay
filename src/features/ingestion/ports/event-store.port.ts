import type { Id } from '../../../core/id.js';

/** Trạng thái của một delivery (khớp kiểu `delivery_status` ở database). */
export type DeliveryStatus = 'pending' | 'in_flight' | 'succeeded' | 'failed';

/** Một sự kiện mới sẵn sàng lưu; `id` và `createdAt` do use case sinh (DAT-22). */
export interface NewEvent {
  id: Id<'event'>;
  appId: Id<'app'>;
  customerId: string;
  type: string;
  /** Object JSON đã qua `checkEventPayload`. */
  payload: object;
  createdAt: Date;
}

/** Sự kiện không kèm payload: dùng cho danh sách (spec 05, nhẹ hơn). */
export interface EventSummary {
  id: Id<'event'>;
  customerId: string;
  type: string;
  createdAt: Date;
}

/** Delivery tóm tắt hiện trong chi tiết sự kiện. */
export interface DeliverySummary {
  id: Id<'delivery'>;
  endpointId: Id<'endpoint'>;
  status: DeliveryStatus;
  attemptCount: number;
}

/** Sự kiện đầy đủ kèm payload và delivery tóm tắt (cũ nhất trước). */
export interface EventDetail extends EventSummary {
  payload: unknown;
  deliveries: DeliverySummary[];
}

/**
 * Khóa idempotency kèm lần gửi này (ING-03): `requestHash` là dấu vân tay của nội dung;
 * khóa đã có từ trước `expiresBefore` thì coi như hết hạn và bị ghi đè (API-21).
 */
export interface IdempotencyClaim {
  key: string;
  requestHash: Buffer;
  expiresBefore: Date;
}

/**
 * Kết quả nhận một sự kiện:
 * - `'created'`: đã lưu sự kiện, `deliveryCount` delivery được tạo cho endpoint khớp;
 * - `'duplicate'`: khóa đã có với cùng nội dung; trả sự kiện cũ, không ghi gì thêm;
 * - `'conflict'`: khóa đã có nhưng nội dung khác; không ghi gì.
 */
export type IngestOutcome =
  | { status: 'created'; deliveryCount: number }
  | { status: 'duplicate'; eventId: Id<'event'>; createdAt: Date }
  | { status: 'conflict' };

/** Điều kiện lấy danh sách sự kiện: bắt buộc `customerId` để luôn dùng được chỉ mục. */
export interface EventListQuery {
  customerId: string;
  type?: string;
  afterId?: Id<'event'>;
  limit: number;
}

/**
 * Port nhận và đọc sự kiện. Bản thật: `PostgresEventStore`.
 *
 * Mọi hàm đọc nhận `appId` và chỉ thấy sự kiện của app đó: không tồn tại hay của app khác cho
 * cùng một kết quả (API-04).
 */
export interface EventStore {
  /**
   * Lưu sự kiện trong MỘT transaction: khóa idempotency (nếu có) → sự kiện → delivery `pending`
   * cho mỗi endpoint của (app, customer) chưa xóa, chưa vô hiệu hóa, có `type` trong
   * `event_types` (ING-02, DIS-03). Không có endpoint nào khớp vẫn lưu sự kiện (API-20).
   *
   * Phải đúng khi nhiều lời gọi cùng khóa chạy đồng thời: đúng một lời gọi được `'created'`,
   * các lời gọi còn lại `'duplicate'` hoặc `'conflict'`, không lời gọi nào lỗi (ING-03.5).
   */
  ingest(input: {
    event: NewEvent;
    idempotency: IdempotencyClaim | null;
  }): Promise<IngestOutcome>;

  /** Đọc sự kiện đầy đủ kèm delivery tóm tắt. */
  findById(appId: Id<'app'>, id: Id<'event'>): Promise<EventDetail | null>;

  /**
   * Danh sách mới nhất trước (thời gian tạo giảm dần, ID giảm dần). `afterId` phải là sự kiện
   * của đúng (app, customer) đang hỏi; không thì trả `'invalid_cursor'` thay vì trang rỗng, để
   * cursor của app khác không lộ sự tồn tại của sự kiện (API-04).
   */
  list(
    appId: Id<'app'>,
    query: EventListQuery,
  ): Promise<EventSummary[] | 'invalid_cursor'>;
}
