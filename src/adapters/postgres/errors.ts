/**
 * Mã SQLSTATE (mã lỗi chuẩn của Postgres) nghĩa là "database không dùng được lúc này":
 * 53300 quá nhiều kết nối, 57P01/02/03 server đang tắt hoặc khởi động, 57014 quá
 * `statement_timeout`, 25P03 quá `idle_in_transaction_session_timeout`.
 * Cả lớp `08` (lỗi kết nối) cũng tính, xem `CONNECTION_EXCEPTION_CLASS`.
 */
const UNAVAILABLE_SQLSTATES = new Set([
  '53300',
  '57P01',
  '57P02',
  '57P03',
  '57014',
  '25P03',
]);

/** Hai ký tự đầu của SQLSTATE thuộc lớp "connection exception". */
const CONNECTION_EXCEPTION_CLASS = '08';

/** Mã lỗi mạng của Node khi không nối được hoặc nối bị đứt. */
const UNAVAILABLE_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/**
 * Phần đầu thông báo lỗi mà `pg` 8.23 ném ra mà không kèm `code`, đã đo khi Postgres treo.
 * ponytail: so chuỗi thông báo là chỗ dễ vỡ khi nâng `pg`; test errors.spec.ts ghim lại.
 */
const UNAVAILABLE_MESSAGE_PREFIXES = [
  'Connection terminated',
  'timeout exceeded when trying to connect',
  'Client has encountered a connection error',
];

/**
 * Lỗi này có nghĩa là Postgres không dùng được (tắt, treo, quá thời gian, hết kết nối) không?
 *
 * Dùng để API trả `503 unavailable` thay vì `500` (ING-05). Lỗi do câu lệnh hoặc dữ liệu
 * sai (vd vi phạm ràng buộc) trả false: đó là lỗi của mã, không phải của hạ tầng.
 * Nhận `unknown` vì `catch` có thể bắt được bất cứ giá trị nào.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const { code } = error as Error & { code?: unknown };
  if (typeof code === 'string') {
    if (
      UNAVAILABLE_SQLSTATES.has(code) ||
      UNAVAILABLE_NETWORK_CODES.has(code) ||
      code.startsWith(CONNECTION_EXCEPTION_CLASS)
    ) {
      return true;
    }
  }
  return UNAVAILABLE_MESSAGE_PREFIXES.some((prefix) =>
    error.message.startsWith(prefix),
  );
}
