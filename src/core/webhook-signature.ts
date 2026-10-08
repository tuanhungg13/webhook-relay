import { createHmac } from 'node:crypto';
import { SECRET_PREFIX } from './webhook-secret.js';

/** Phiên bản thuật toán ký của Standard Webhooks: `v1` = HMAC-SHA256. */
const SIGNATURE_VERSION = 'v1';
/** Độ dài khóa tối thiểu (byte) mà Standard Webhooks cho phép. */
const MIN_KEY_BYTES = 24;
/** Độ dài khóa tối đa (byte) mà Standard Webhooks cho phép. */
const MAX_KEY_BYTES = 64;
/** Số mili giây trong một giây, để đổi `Date` sang giây Unix. */
const MS_PER_SECOND = 1000;
/** Chữ ký nối nhau bằng một dấu cách khi đang xoay secret (SEC-22). */
const SIGNATURE_SEPARATOR = ' ';

/** Ba header chữ ký của Standard Webhooks; tên viết thường để trải thẳng vào request. */
export interface WebhookSignatureHeaders {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
}

/** Phần của endpoint mà việc chọn secret cần; khai báo theo cấu trúc để core không import feature. */
export interface EndpointSecrets {
  secret: string;
  previousSecret: string | null;
  previousSecretExpiresAt: Date | null;
}

/** Ném lỗi nếu `date` là "Invalid Date" (vd `new Date(NaN)`), tránh ký âm thầm với giờ hỏng. */
function assertValidDate(date: Date, name: string): void {
  if (Number.isNaN(date.getTime()))
    throw new Error(`${name} is not a valid date`);
}

/**
 * Dựng body webhook thành `Buffer`: `{"type","timestamp","data"}` theo đúng thứ tự đó.
 *
 * Chỉ serialize một lần; worker gửi chính `Buffer` này và hàm ký cũng nhận nó, nên chữ ký
 * luôn tính trên đúng các byte được gửi đi (SIG-01). `timestamp` là giờ tạo sự kiện (RFC 3339).
 * Ném lỗi nếu `payload` là `undefined` (JSON.stringify sẽ lặng lẽ bỏ mất trường `data`).
 */
export function serializeWebhookBody(event: {
  type: string;
  createdAt: Date;
  payload: unknown;
}): Buffer {
  if (event.payload === undefined)
    throw new Error('event payload is undefined');
  return Buffer.from(
    JSON.stringify({
      type: event.type,
      timestamp: event.createdAt.toISOString(), // tự ném RangeError nếu ngày hỏng
      data: event.payload,
    }),
  );
}

/**
 * Chọn danh sách secret dùng để ký tại thời điểm `now`: secret hiện tại đứng trước, thêm
 * secret cũ nếu đang trong thời gian ân hạn khi xoay (SEC-22).
 *
 * Secret cũ chỉ dùng khi có cả secret lẫn hạn và `now < hạn` (hết hạn là từ đúng thời điểm
 * đó trở đi không dùng). Ném lỗi nếu `now` hoặc hạn không hợp lệ, vì phép so sánh sẽ luôn sai và lặng
 * lẽ bỏ secret cũ.
 */
export function signingSecrets(endpoint: EndpointSecrets, now: Date): string[] {
  assertValidDate(now, 'now');
  const { secret, previousSecret, previousSecretExpiresAt } = endpoint;
  if (previousSecretExpiresAt !== null) {
    assertValidDate(previousSecretExpiresAt, 'previousSecretExpiresAt');
  }
  const previousStillValid =
    previousSecret !== null &&
    previousSecretExpiresAt !== null &&
    now.getTime() < previousSecretExpiresAt.getTime();
  return previousStillValid ? [secret, previousSecret] : [secret];
}

/**
 * Đổi secret `whsec_<base64>` thành khóa HMAC (byte).
 *
 * `Buffer.from(x, 'base64')` của Node bỏ qua ký tự sai mà không báo lỗi, nên kiểm chặt bằng
 * cách giải mã rồi mã hóa lại, phải ra đúng chuỗi cũ. Ném lỗi với message cố định, không
 * kèm `cause` và không chép secret để không lộ qua log/stack (SEC-13).
 */
function decodeSecret(secret: string): Buffer {
  if (!secret.startsWith(SECRET_PREFIX))
    throw new Error('invalid webhook secret');
  const encoded = secret.slice(SECRET_PREFIX.length);
  const key = Buffer.from(encoded, 'base64');
  const roundTrips = key.toString('base64') === encoded;
  if (!roundTrips || key.length < MIN_KEY_BYTES || key.length > MAX_KEY_BYTES) {
    throw new Error('invalid webhook secret');
  }
  return key;
}

/**
 * Tính ba header chữ ký cho một lần gửi webhook (Standard Webhooks).
 *
 * Mỗi chữ ký = `v1,` + base64(HMAC-SHA256(khóa, `id.timestamp.` + body)). Nhiều secret cho
 * nhiều chữ ký cách nhau một dấu cách, thứ tự theo `secrets`. `sentAt` là giờ gửi attempt này
 * (không phải giờ tạo sự kiện) vì người nhận từ chối timestamp lệch quá 5 phút, nên worker
 * phải gọi hàm này ngay trước khi gửi HTTP. Ném lỗi nếu `secrets` rỗng, `sentAt` hỏng hoặc
 * secret sai dạng.
 */
export function signWebhook(input: {
  webhookId: string;
  sentAt: Date;
  body: Buffer;
  secrets: readonly string[];
}): WebhookSignatureHeaders {
  const { webhookId, sentAt, body, secrets } = input;
  // 1. Kiểm đầu vào: không ký khi thiếu secret hoặc giờ hỏng
  if (secrets.length === 0) throw new Error('no webhook secrets to sign with');
  assertValidDate(sentAt, 'sentAt');
  // 2. Timestamp = giây Unix (làm tròn xuống) của giờ gửi attempt này
  const timestamp = String(Math.floor(sentAt.getTime() / MS_PER_SECOND));
  // 3. Nội dung ký: `id.timestamp.` nối với đúng các byte của body
  const signedContent = Buffer.concat([
    Buffer.from(`${webhookId}.${timestamp}.`),
    body,
  ]);
  // 4. Mỗi secret một chữ ký (HMAC = mã xác thực tính từ khóa bí mật + nội dung)
  const signatures = secrets.map((secret) => {
    const digest = createHmac('sha256', decodeSecret(secret))
      .update(signedContent)
      .digest('base64');
    return `${SIGNATURE_VERSION},${digest}`;
  });
  return {
    'webhook-id': webhookId,
    'webhook-timestamp': timestamp,
    'webhook-signature': signatures.join(SIGNATURE_SEPARATOR),
  };
}
