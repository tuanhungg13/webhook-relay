/** Số cấp lồng tối đa của payload; payload là cấp 1 (D-09). */
const MAX_DEPTH = 32;

/** Ký tự NUL: `jsonb` của Postgres không lưu được (lỗi 22P05). */
const NUL = '\u0000';

/** Lỗi đầu tiên tìm thấy: `path` chỉ vị trí (vd `payload.order.items[2]`), `message` không chép giá trị. */
export interface PayloadIssue {
  path: string;
  message: string;
}

/**
 * Kiểm payload của sự kiện trước khi lưu: là object, sâu ≤ 32 cấp, số hữu hạn và số nguyên nằm
 * trong khoảng an toàn ±(2^53 − 1), chuỗi và key hợp lệ cho `jsonb` (D-09).
 *
 * Trả `null` nếu hợp lệ, ngược lại trả lỗi đầu tiên. Duyệt dừng ngay ở cấp 33 nên payload lồng
 * hàng chục nghìn cấp không làm tràn stack. Message chỉ nêu luật, không chép giá trị (SEC-13).
 */
export function checkEventPayload(payload: unknown): PayloadIssue | null {
  if (!isPlainContainer(payload) || Array.isArray(payload)) {
    return { path: 'payload', message: 'must be a JSON object' };
  }
  return checkValue(payload, 'payload', 1);
}

/** Kiểm một giá trị JSON ở cấp `depth`; `path` là vị trí của nó để báo lỗi. */
function checkValue(
  value: unknown,
  path: string,
  depth: number,
): PayloadIssue | null {
  if (typeof value === 'string') return checkString(value, path, 'string');
  if (typeof value === 'number') return checkNumber(value, path);
  if (!isPlainContainer(value)) return null; // true/false/null
  if (depth > MAX_DEPTH) {
    return { path, message: `must be nested at most ${MAX_DEPTH} levels deep` };
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const issue = checkValue(item, `${path}[${index}]`, depth + 1);
      if (issue) return issue;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    const issue =
      checkString(key, childPath, 'key') ??
      checkValue(item, childPath, depth + 1);
    if (issue) return issue;
  }
  return null;
}

/** Object hoặc mảng (null không tính, dù `typeof null === 'object'`). */
function isPlainContainer(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** Số phải hữu hạn (`1e400` thành `Infinity` sau `JSON.parse`) và, nếu nguyên, nằm trong khoảng an toàn. */
function checkNumber(value: number, path: string): PayloadIssue | null {
  if (!Number.isFinite(value)) {
    return { path, message: 'must be a finite number' };
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return {
      path,
      message:
        'integer must be within ±(2^53 - 1); send larger values as strings',
    };
  }
  return null;
}

/**
 * Chuỗi (giá trị hoặc key) phải lưu được vào `jsonb`: không có NUL và không có surrogate lẻ
 * (nửa cặp ký tự UTF-16, vd `\ud800` đứng một mình). `isWellFormed` kiểm điều thứ hai.
 */
function checkString(
  text: string,
  path: string,
  what: 'string' | 'key',
): PayloadIssue | null {
  if (text.includes(NUL)) {
    return { path, message: `${what} must not contain the NUL character` };
  }
  if (!text.isWellFormed()) {
    return { path, message: `${what} must be well-formed Unicode` };
  }
  return null;
}
