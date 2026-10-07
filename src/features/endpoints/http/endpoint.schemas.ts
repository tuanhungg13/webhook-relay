import { z } from 'zod';
import { paginationQuery } from '../../../platform/http/pagination.js';

/** `customer_id`: 1–128 ký tự gồm chữ, số và `. _ : -` (spec 05, gửi sự kiện). */
const customerId = z
  .string()
  .regex(
    /^[A-Za-z0-9._:-]{1,128}$/,
    'must be 1-128 characters: letters, digits, . _ : -',
  );

/**
 * Một loại sự kiện, vd `order.created`: 1–128 ký tự, các đoạn chữ thường/số/gạch dưới nối bằng
 * dấu chấm (spec 05). Regex: một đoạn, rồi lặp lại "dấu chấm + một đoạn" 0 hay nhiều lần.
 */
const eventType = z
  .string()
  .max(128)
  .regex(
    /^[a-z0-9_]+(\.[a-z0-9_]+)*$/,
    'must be dot-separated segments of a-z, 0-9, _',
  );

/** URL endpoint: ở đây chỉ kiểm là chuỗi; luật chi tiết nằm ở `core/endpoint-url.ts`. */
const url = z.string();
/**
 * 1–50 loại sự kiện. Giới hạn tính trên mảng App gửi lên, TRƯỚC khi use case loại phần tử trùng.
 */
const eventTypes = z.array(eventType).min(1).max(50);
/** Số request mỗi giây tối đa gửi tới endpoint: 1–1000 (ràng buộc giống cột trong database). */
const rateLimitRps = z.int().min(1).max(1000);
/** Số request đồng thời tối đa tới endpoint: 1–100 (ràng buộc giống cột trong database). */
const maxConcurrency = z.int().min(1).max(100);

/** Body của `POST /v1/endpoints`. `rate_limit_rps`, `max_concurrency` không gửi thì use case lấy mặc định. */
export const createEndpointBody = z.object({
  customer_id: customerId,
  url,
  event_types: eventTypes,
  rate_limit_rps: rateLimitRps.optional(),
  max_concurrency: maxConcurrency.optional(),
});

/**
 * Body của `PATCH /v1/endpoints/{id}`: chỉ các trường được phép sửa, ít nhất một trường.
 * `.strict()` từ chối trường lạ (vd `customer_id`, `secret`) bằng 422 thay vì lờ đi: lờ đi thì
 * App tưởng đã đổi được (quyết định #3 của lát 2). Gửi `null` cũng là 422, không có nghĩa "xóa".
 */
export const updateEndpointBody = z
  .object({
    url: url.optional(),
    event_types: eventTypes.optional(),
    rate_limit_rps: rateLimitRps.optional(),
    max_concurrency: maxConcurrency.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one field is required',
  });

/** Query của `GET /v1/endpoints`: phân trang và lọc theo customer (tùy chọn). */
export const listEndpointsQuery = z.object({
  ...paginationQuery,
  customer_id: customerId.optional(),
});
