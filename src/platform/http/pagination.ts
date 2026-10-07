import { z } from 'zod';
import { validationFailed } from './validate.js';

/** Số phần tử mặc định của một trang khi App không gửi `limit` (API-10). */
const DEFAULT_PAGE_LIMIT = 20;
/** Số phần tử tối đa của một trang (API-10). */
const MAX_PAGE_LIMIT = 100;

/**
 * Các trường phân trang dùng chung cho query string của API danh sách (API-10), để ghép vào
 * schema của từng route: `z.object({ ...paginationQuery, customer_id: ... })`.
 * Query string luôn là chuỗi nên `limit` phải toàn chữ số rồi mới đổi sang số; chuỗi rỗng,
 * số thập phân hay `?limit=1&limit=2` (thành mảng) đều không hợp lệ.
 */
export const paginationQuery = {
  limit: z
    .string()
    .regex(/^\d+$/, 'must be an integer')
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_PAGE_LIMIT))
    .default(DEFAULT_PAGE_LIMIT),
  cursor: z.string().optional(),
};

/**
 * Tạo cursor từ ID phần tử cuối trang: base64url của JSON `{ id }`.
 * Với App, cursor là chuỗi mờ (opaque: không cần và không nên hiểu bên trong), nhờ vậy sau này
 * đổi cách phân trang mà không phá App.
 */
export function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id })).toString('base64url');
}

/**
 * Đọc cursor do `encodeCursor` tạo, rồi kiểm ID bên trong bằng `parseId` (vd chỉ nhận ID
 * endpoint). Cursor hỏng hoặc ID sai loại → ném `ApiError 422 validation_failed`.
 */
export function decodeCursor<T>(
  cursor: string,
  parseId: (id: string) => T | null,
): T {
  const id = readCursorId(cursor);
  const parsed = id === null ? null : parseId(id);
  if (parsed === null) {
    throw validationFailed([{ field: 'cursor', message: 'invalid cursor' }]);
  }
  return parsed;
}

/** Lấy trường `id` (chuỗi) trong cursor; cursor không giải mã được thì trả null. */
function readCursorId(cursor: string): string | null {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    const id = (value as { id?: unknown } | null)?.id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}
