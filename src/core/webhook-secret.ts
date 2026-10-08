import { randomBytes } from 'node:crypto';

/** Tiền tố của mọi webhook secret: "whsec_" (webhook secret), nhìn vào là biết đây là bí mật. */
export const SECRET_PREFIX = 'whsec_';
/** Số byte ngẫu nhiên của secret: 32 byte = 256 bit (SEC-20). */
const SECRET_RANDOM_BYTES = 32;

/**
 * Sinh webhook secret mới cho một endpoint (SEC-20): `whsec_` + base64 chuẩn của 32 byte ngẫu
 * nhiên an toàn mật mã.
 *
 * Secret được lưu dạng rõ vì worker cần nó để ký webhook (SEC-21). Base64 chuẩn (có `+`, `/`,
 * `=`) để khớp quy ước Standard Webhooks mà người nhận dùng để kiểm chữ ký.
 */
export function generateWebhookSecret(): string {
  return SECRET_PREFIX + randomBytes(SECRET_RANDOM_BYTES).toString('base64');
}
