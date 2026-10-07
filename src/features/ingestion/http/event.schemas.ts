import { z } from 'zod';
import {
  CUSTOMER_ID_PATTERN,
  EVENT_TYPE_MAX_LENGTH,
  EVENT_TYPE_PATTERN,
} from '../../../core/event-fields.js';
import { paginationQuery } from '../../../platform/http/pagination.js';

/** Ký tự NUL: cột `text` của Postgres không lưu được. */
const NUL = String.fromCharCode(0);

/** Số ký tự tối đa của `idempotency_key` (spec 05, khớp ràng buộc của cột `key`). */
const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/** `customer_id`: luật dùng chung với endpoint, xem `core/event-fields.ts` (spec 05). */
const customerId = z
  .string()
  .regex(
    CUSTOMER_ID_PATTERN,
    'must be 1-128 characters: letters, digits, . _ : -',
  );

/** Loại sự kiện, vd `order.created`: luật dùng chung với endpoint, xem `core/event-fields.ts`. */
const eventType = z
  .string()
  .max(EVENT_TYPE_MAX_LENGTH)
  .regex(EVENT_TYPE_PATTERN, 'must be dot-separated segments of a-z, 0-9, _');

/**
 * Payload: chỉ kiểm "là object, không phải mảng". Dùng `z.custom` thay vì `z.record` vì zod làm
 * mất key `__proto__` (dữ liệu hợp lệ của App); `z.custom` giữ nguyên chính object App gửi.
 * Các luật còn lại (độ sâu, số, chuỗi) do `checkEventPayload` kiểm, vì cần báo đường dẫn.
 */
const payload = z.custom<object>(
  (value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value),
  'must be a JSON object',
);

/**
 * `idempotency_key`: 1–255 ký tự, và phải lưu được vào cột `text` của Postgres: không có NUL
 * (Postgres báo lỗi) và không có surrogate lẻ (Postgres âm thầm đổi ký tự, hai khóa khác nhau
 * có thể thành một).
 */
const idempotencyKey = z
  .string()
  .min(1)
  .max(IDEMPOTENCY_KEY_MAX_LENGTH)
  .refine((key) => !key.includes(NUL) && key.isWellFormed(), {
    message: 'must not contain NUL or unpaired surrogates',
  });

/** Body của `POST /v1/events`. `idempotency_key` khuyến nghị mạnh nhưng không bắt buộc (ING-05). */
export const ingestEventBody = z.object({
  customer_id: customerId,
  type: eventType,
  payload,
  idempotency_key: idempotencyKey.optional(),
});

/** Query của `GET /v1/events`: phân trang, `customer_id` bắt buộc, lọc `type` tùy chọn. */
export const listEventsQuery = z.object({
  ...paginationQuery,
  customer_id: customerId,
  type: eventType.optional(),
});
