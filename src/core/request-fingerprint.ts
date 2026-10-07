import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';

/** Phần nội dung của một request gửi sự kiện, thứ quyết định "hai request có cùng nghĩa không". */
export interface EventContent {
  customerId: string;
  type: string;
  payload: unknown;
}

/**
 * Dấu vân tay của request gửi sự kiện: SHA-256 của JCS(`[customer_id, type, payload]`).
 *
 * Hash là phép băm một chiều: cùng đầu vào luôn ra cùng 32 byte, khác dù một ký tự thì khác hẳn.
 * Lưu cạnh khóa idempotency để biết lần gửi lại có cùng nội dung hay không (ING-03.1). Gói ba
 * phần vào một mảng nên `("a","bc")` và `("ab","c")` không thể ra cùng chuỗi.
 */
export function eventFingerprint(content: EventContent): Buffer {
  const canonical = canonicalJson([
    content.customerId,
    content.type,
    content.payload,
  ]);
  return createHash('sha256').update(canonical).digest();
}
