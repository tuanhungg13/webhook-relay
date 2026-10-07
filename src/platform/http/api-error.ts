/**
 * Mã lỗi máy đọc được của API, đúng bảng lỗi ở spec 05. Mỗi mã đi kèm một HTTP status
 * cố định, xem `ApiError`.
 */
export type ApiErrorCode =
  | 'invalid_json'
  | 'unauthorized'
  | 'not_found'
  | 'idempotency_conflict'
  | 'invalid_state'
  | 'payload_too_large'
  | 'validation_failed'
  | 'limit_exceeded'
  | 'internal'
  | 'unavailable';

/**
 * Lỗi mà feature ném ra khi muốn trả một lỗi API có chủ đích. Filter toàn cục đổi nó thành
 * `{ error: { code, message, details } }` với HTTP `status` tương ứng.
 *
 * `details` tùy chọn, vd tên trường sai.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
