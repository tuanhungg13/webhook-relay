import { createHash, randomBytes } from 'node:crypto';

/** Mọi API key đều bắt đầu bằng "sk_" (secret key), nhìn vào là biết đây là bí mật. */
const KEY_PREFIX = 'sk_';
/** Số byte ngẫu nhiên của key: 32 byte = 256 bit, không thể đoán (API-01). */
const KEY_RANDOM_BYTES = 32;
/** Bảng 62 ký tự dùng để viết key: chữ số, chữ hoa, chữ thường, không có ký tự đặc biệt. */
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/**
 * Độ dài phần base62 của key. Số 256 bit viết ở hệ 62 cần tối đa 43 ký tự
 * (ceil(256 / log2(62)) = 43); số nhỏ hơn thì được đệm '0' phía trước để key luôn dài bằng nhau.
 */
const ENCODED_LENGTH = 43;
/** Số ký tự đầu của key được phép lưu và ghi log: đủ để nhận ra key mà không làm lộ key. */
const LOG_PREFIX_LENGTH = 8;

/** Kết quả khi sinh một API key mới. */
export interface NewApiKey {
  /** Key thật (bí mật): chỉ đưa cho người vận hành đúng một lần, không bao giờ lưu hay ghi log. */
  key: string;
  /** Hash SHA-256 của `key`: dạng DUY NHẤT được lưu vào database (SEC-11). */
  hash: Buffer;
  /** Vài ký tự đầu của `key`, an toàn để lưu và ghi log nhằm nhận diện key (SEC-13). */
  prefix: string;
}

/**
 * Sinh một API key mới (API-01, SEC-10).
 *
 * Key có dạng `sk_` + 43 ký tự base62, tạo từ 32 byte ngẫu nhiên an toàn mật mã.
 * Trả về cả key thật, hash và prefix; bên gọi quyết định phần nào được lưu, phần nào đưa cho ai.
 */
export function generateApiKey(): NewApiKey {
  // randomBytes lấy byte ngẫu nhiên từ hệ điều hành, đủ an toàn để làm khóa bí mật
  // (khác Math.random(), thứ có thể bị đoán ra).
  const key = KEY_PREFIX + encodeBase62(randomBytes(KEY_RANDOM_BYTES));
  return {
    key,
    hash: hashApiKey(key),
    prefix: key.slice(0, LOG_PREFIX_LENGTH),
  };
}

/**
 * Băm key bằng SHA-256. Từ key tính ra hash thì dễ, từ hash không suy ngược ra key được.
 *
 * Cùng một key luôn cho cùng một hash, nên khi App gửi key lên, server chỉ cần băm lại rồi tìm
 * trong database. Dùng hàm băm nhanh là đủ (không cần bcrypt như mật khẩu) vì key có 256 bit
 * ngẫu nhiên, không thể dò, và phải được kiểm tra trên mọi request (SEC-11).
 */
export function hashApiKey(key: string): Buffer {
  return createHash('sha256').update(key).digest();
}

/**
 * Viết một dãy byte thành chuỗi base62 (hệ cơ số 62), luôn dài đúng ENCODED_LENGTH ký tự.
 * Cách làm giống đổi số thập phân sang nhị phân: chia liên tục cho 62, lấy số dư làm chữ số.
 */
function encodeBase62(bytes: Buffer): string {
  // Ghép cả dãy byte thành một số nguyên rất lớn. Dùng BigInt (hậu tố `n`, vd `62n`) vì số
  // 256 bit vượt xa giới hạn của kiểu number thường.
  let value = BigInt(`0x${bytes.toString('hex')}`);
  let encoded = '';
  while (value > 0n) {
    // Số dư khi chia 62 là chữ số cuối cùng: ghép vào đầu chuỗi, rồi chia 62 để bỏ chữ số đó.
    encoded = BASE62[Number(value % 62n)] + encoded;
    value /= 62n;
  }
  return encoded.padStart(ENCODED_LENGTH, BASE62[0]);
}
