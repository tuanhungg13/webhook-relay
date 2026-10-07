/** Độ dài tối đa của URL endpoint (spec 05, tạo endpoint). */
export const MAX_ENDPOINT_URL_LENGTH = 2048;
/** Cổng nhỏ nhất được phép ngoài 443/80: chặn dò dịch vụ ở cổng thấp như SMTP 25 (SEC-14). */
const MIN_HIGH_PORT = 1024;
/** Cổng mặc định của https. */
const HTTPS_PORT = 443;
/** Cổng mặc định của http (chỉ được dùng khi bật `ALLOW_INSECURE_HTTP`). */
const HTTP_PORT = 80;

/** Tùy chọn kiểm URL: `allowInsecureHttp` lấy từ cấu hình `ALLOW_INSECURE_HTTP` (chỉ dev/test). */
export interface EndpointUrlOptions {
  allowInsecureHttp: boolean;
}

/**
 * Kiểm luật TĨNH của URL endpoint, không phân giải DNS (SEC-01 phần tĩnh, SEC-14):
 * - scheme `https`; thêm `http` khi `allowInsecureHttp`;
 * - không có thông tin đăng nhập (`user:pass@`);
 * - cổng 443 hoặc ≥ 1024; thêm 80 khi `allowInsecureHttp`;
 * - tối đa 2048 ký tự.
 *
 * Trả `null` nếu hợp lệ, ngược lại trả mô tả lỗi bằng tiếng Anh để đưa vào `details` của
 * phản hồi 422. Mô tả không chứa lại URL vì URL có thể mang mật khẩu (SEC-13).
 * Chặn IP nội bộ (SSRF) là việc của lát SSRF, không nằm ở đây.
 */
export function validateEndpointUrl(
  url: string,
  options: EndpointUrlOptions,
): string | null {
  if (url.length > MAX_ENDPOINT_URL_LENGTH) {
    return `must be at most ${MAX_ENDPOINT_URL_LENGTH} characters`;
  }
  // `URL` có sẵn trong Node: chuỗi không phải URL tuyệt đối thì `parse` trả null.
  const parsed = URL.parse(url);
  if (!parsed) return 'must be a valid URL';

  const allowedSchemes = options.allowInsecureHttp
    ? ['https:', 'http:']
    : ['https:'];
  if (!allowedSchemes.includes(parsed.protocol)) {
    return options.allowInsecureHttp
      ? 'must use https or http'
      : 'must use https';
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return 'must not contain credentials';
  }
  if (!isAllowedPort(effectivePort(parsed), options)) {
    return options.allowInsecureHttp
      ? `port must be ${HTTPS_PORT}, ${HTTP_PORT} or at least ${MIN_HIGH_PORT}`
      : `port must be ${HTTPS_PORT} or at least ${MIN_HIGH_PORT}`;
  }
  return null;
}

/**
 * Cổng thật mà kết nối sẽ dùng. `URL` để `port` rỗng khi cổng trùng mặc định của scheme
 * (`https://a.com:443` → `''`), nên lúc đó lấy cổng mặc định.
 */
function effectivePort(url: URL): number {
  if (url.port !== '') return Number(url.port);
  return url.protocol === 'https:' ? HTTPS_PORT : HTTP_PORT;
}

/** Cổng có được phép không (SEC-14): 443, ≥ 1024, và 80 khi cho phép http. */
function isAllowedPort(port: number, options: EndpointUrlOptions): boolean {
  if (port === HTTPS_PORT || port >= MIN_HIGH_PORT) return true;
  return options.allowInsecureHttp && port === HTTP_PORT;
}
