import { randomBytes } from 'node:crypto';

/**
 * Tiền tố ID của từng loại đối tượng: loại → tiền tố.
 *
 * Toàn bộ quy ước ID của hệ thống (DAT-01..03, D-17):
 * - Trong Postgres: lưu dạng UUIDv7 (kiểu `uuid`, 16 byte). UUIDv7 bắt đầu bằng thời gian nên ID
 *   sinh sau luôn "lớn hơn", giúp chỉ mục của database không bị phân mảnh.
 * - Mọi nơi khác (API, log, CLI): dùng dạng TypeID `<tiền tố>_<26 ký tự base32>`,
 *   vd `evt_01h455vb4pex5vsknk084sn02q`. Nhìn tiền tố là biết loại đối tượng.
 *   Xem https://github.com/jetify-com/typeid.
 * - Việc đổi qua lại giữa hai dạng chỉ nằm ở file này và adapter Postgres.
 */
const ID_PREFIXES = {
  app: 'app',
  apiKey: 'key',
  endpoint: 'ep',
  event: 'evt',
  delivery: 'del',
  attempt: 'att',
} as const;

/** Tên các loại đối tượng có ID: 'app' | 'apiKey' | 'endpoint' | 'event' | ... */
export type IdKind = keyof typeof ID_PREFIXES;

/** Danh sách mọi loại ID, dùng khi cần duyệt qua tất cả (vd CLI đoán loại của một ID). */
export const ID_KINDS = Object.keys(ID_PREFIXES) as readonly IdKind[];

declare const idKind: unique symbol;
/**
 * Một chuỗi TypeID đã được kiểm tra là đúng loại `K`, vd `Id<'app'>` là ID của app.
 *
 * Lúc chạy vẫn chỉ là string, nhưng TypeScript gắn thêm "nhãn" loại: không cho truyền nhầm
 * `Id<'event'>` vào chỗ cần `Id<'app'>`, cũng không cho truyền một string chưa kiểm tra.
 * Chỉ các hàm trong file này mới tạo ra được giá trị kiểu này.
 */
export type Id<K extends IdKind> = string & { readonly [idKind]: K };

/** Bảng chữ cái base32 Crockford viết thường (bỏ i, l, o, u để khỏi đọc nhầm với 1, 0, v). */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
/** Phần sau dấu `_` của TypeID luôn dài 26 ký tự. */
const SUFFIX_LENGTH = 26;
/**
 * Dạng hợp lệ của phần sau dấu `_`. 26 ký tự × 5 bit = 130 bit, chứa một số 128 bit,
 * nên ký tự đầu chỉ mang tối đa 3 bit (chỉ được là 0..7).
 */
const SUFFIX_PATTERN = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;
/** Dạng chuẩn của UUID: 8-4-4-4-12 ký tự hex. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** UUIDv7 dành 48 bit cho thời gian (mili giây), nên thời gian lớn nhất là 2^48 - 1. */
const MAX_UUID_V7_TIMESTAMP_MS = 2 ** 48 - 1;
/** UUID dài 16 byte. */
const UUID_BYTES = 16;
/** 6 byte đầu của UUIDv7 chứa thời gian. */
const TIMESTAMP_BYTES = 6;

/**
 * Sinh ID mới loại `kind` (vd 'app' → `app_01h4...`) theo chuẩn UUIDv7 (RFC 9562).
 *
 * `nowMs` là giờ hiện tại tính bằng mili giây, do bên gọi lấy từ đồng hồ ứng dụng (DAT-22).
 * Hàm không tự đọc giờ để test truyền được giờ cố định.
 * Ném RangeError nếu `nowMs` không phải số nguyên trong khoảng UUIDv7 cho phép.
 */
export function newId<K extends IdKind>(kind: K, nowMs: number): Id<K> {
  if (
    !Number.isInteger(nowMs) ||
    nowMs < 0 ||
    nowMs > MAX_UUID_V7_TIMESTAMP_MS
  ) {
    throw new RangeError(
      `UUIDv7 timestamp must be an integer in [0, 2^48): ${nowMs}`,
    );
  }
  // Bắt đầu từ 16 byte ngẫu nhiên, rồi ghi đè các phần có ý nghĩa theo chuẩn UUIDv7.
  const bytes = randomBytes(UUID_BYTES);
  bytes.writeUIntBE(nowMs, 0, TIMESTAMP_BYTES); // 6 byte đầu = thời gian
  bytes[6] = 0x70 | (bytes[6] & 0x0f); // 4 bit cao của byte 6 = 0111: phiên bản 7
  bytes[8] = 0x80 | (bytes[8] & 0x3f); // 2 bit cao của byte 8 = 10: biến thể chuẩn RFC
  return withPrefix(kind, encodeSuffix(BigInt(`0x${bytes.toString('hex')}`)));
}

/**
 * Kiểm tra chuỗi từ bên ngoài (đường dẫn API, tham số CLI...) có phải ID loại `kind` không.
 *
 * Đúng thì trả về chính chuỗi đó với kiểu `Id<K>`. Sai định dạng hoặc sai tiền tố thì trả về
 * null (không ném lỗi), để bên gọi trả lời y như khi không tìm thấy đối tượng (DAT-04).
 */
export function parseId<K extends IdKind>(kind: K, text: string): Id<K> | null {
  const prefix = `${ID_PREFIXES[kind]}_`;
  if (!text.startsWith(prefix)) return null;
  return SUFFIX_PATTERN.test(text.slice(prefix.length))
    ? (text as Id<K>)
    : null;
}

/**
 * Đổi UUID (thường đọc từ Postgres) sang TypeID loại `kind`.
 * UUID trong database mà sai định dạng thì là bug, nên ném lỗi thay vì trả null.
 */
export function idFromUuid<K extends IdKind>(kind: K, uuid: string): Id<K> {
  if (!UUID_PATTERN.test(uuid))
    throw new Error(`invalid uuid: ${JSON.stringify(uuid)}`);
  return withPrefix(
    kind,
    encodeSuffix(BigInt(`0x${uuid.replaceAll('-', '')}`)),
  );
}

/** Đổi TypeID sang UUID dạng `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` để dùng với Postgres. */
export function idToUuid(id: Id<IdKind>): string {
  // Lấy phần sau dấu `_`, giải mã ra số 128 bit, viết lại thành đủ 32 ký tự hex.
  const suffix = id.slice(id.lastIndexOf('_') + 1);
  const hex = decodeSuffix(suffix)
    .toString(16)
    .padStart(UUID_BYTES * 2, '0');
  // Chèn dấu gạch ngang theo nhóm 8-4-4-4-12.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Ghép tiền tố của loại `kind` với phần đã mã hóa, vd `app` + `_` + `01h4...`. */
function withPrefix<K extends IdKind>(kind: K, suffix: string): Id<K> {
  return `${ID_PREFIXES[kind]}_${suffix}` as Id<K>;
}

/** Viết số 128 bit thành 26 ký tự base32: mỗi lần lấy 5 bit cuối làm một ký tự, đi từ phải sang. */
function encodeSuffix(value: bigint): string {
  let remaining = value;
  let suffix = '';
  for (let i = 0; i < SUFFIX_LENGTH; i++) {
    suffix = ALPHABET[Number(remaining & 31n)] + suffix; // 31 = 0b11111: lấy 5 bit cuối
    remaining >>= 5n; // bỏ 5 bit vừa lấy
  }
  return suffix;
}

/** Ngược lại với encodeSuffix: đọc từng ký tự từ trái sang, mỗi ký tự góp thêm 5 bit vào số. */
function decodeSuffix(suffix: string): bigint {
  let value = 0n;
  for (const char of suffix)
    value = (value << 5n) | BigInt(ALPHABET.indexOf(char));
  return value;
}
