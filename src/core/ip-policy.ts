import ipaddr from 'ipaddr.js';

/** Một dải CIDR đã parse, dùng cho `SSRF_ALLOWLIST`. */
export type Cidr = [ipaddr.IPv4 | ipaddr.IPv6, number];

/** Loại duy nhất được phép khi gửi webhook: địa chỉ unicast công cộng (SEC-07). */
const PUBLIC_RANGE = 'unicast';
/** Vị trí nhóm 16 bit đầu của phần IPv4 nhúng trong `2002::/16` (6to4). */
const SIXTOFOUR_PART = 1;
/** Vị trí hai nhóm 16 bit cuối, nơi IPv4 nhúng nằm trong `::ffff:0:0/96`, `64:ff9b::/96`, `::/96`. */
const TAIL_PART = 6;
/** Tiền tố `64:ff9b::/96` (NAT64, RFC 6052) viết theo 6 nhóm 16 bit đầu. */
const RFC6052_PREFIX = [0x64, 0xff9b, 0, 0, 0, 0];

/**
 * Đọc danh sách CIDR phân cách bằng dấu phẩy (giá trị `SSRF_ALLOWLIST`). Chuỗi rỗng → `[]`.
 * Phần tử sai dạng thì ném lỗi nêu đúng phần tử đó (CIDR không phải bí mật).
 */
export function parseCidrList(text: string): Cidr[] {
  return text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .map((item) => {
      try {
        return ipaddr.parseCIDR(item);
      } catch {
        throw new Error(`invalid CIDR "${item}"`);
      }
    });
}

/**
 * IP này có được phép làm đích gửi webhook không (SEC-01, SEC-02, SEC-07, SEC-08).
 * Danh sách trắng: IP nằm trong `allowlist` thì qua; ngược lại sau khi tách IPv4 nhúng
 * trong IPv6, chỉ địa chỉ unicast công cộng được qua. Mọi thứ không parse được đều bị chặn.
 */
export function isAllowedAddress(
  ip: string,
  allowlist: readonly Cidr[],
): boolean {
  // Zone id (`fe80::1%eth0`) có thể được thư viện nhận nhưng không có nghĩa với đích công cộng.
  if (ip.includes('%') || !ipaddr.isValid(ip)) return false;
  const address = ipaddr.parse(ip);
  if (
    allowlist.some(
      (cidr) => address.kind() === cidr[0].kind() && address.match(cidr),
    )
  ) {
    return true;
  }
  return unwrapEmbeddedIpv4(address).range() === PUBLIC_RANGE;
}

/**
 * Nếu IPv6 chỉ là vỏ của một IPv4 (`::ffff:0:0/96`, `64:ff9b::/96`, `2002::/16`, `::/96`)
 * thì trả IPv4 bên trong để kiểm theo luật IPv4; còn lại trả nguyên (SEC-08).
 * Thư viện không tự xử lý các dải này (`::7f00:1` vẫn bị coi là unicast).
 */
function unwrapEmbeddedIpv4(
  address: ipaddr.IPv4 | ipaddr.IPv6,
): ipaddr.IPv4 | ipaddr.IPv6 {
  if (address.kind() === 'ipv4') return address;
  const parts = (address as ipaddr.IPv6).parts;
  const fromParts = (high: number, low: number) =>
    new ipaddr.IPv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  const zeros = (from: number, to: number) =>
    parts.slice(from, to).every((part) => part === 0);

  if (parts[0] === 0x2002)
    return fromParts(parts[SIXTOFOUR_PART]!, parts[SIXTOFOUR_PART + 1]!);
  const embedsInTail =
    (zeros(0, 5) && parts[5] === 0xffff) ||
    RFC6052_PREFIX.every((part, i) => parts[i] === part) ||
    (zeros(0, TAIL_PART) && !(parts[TAIL_PART] === 0 && parts[7]! <= 1));
  return embedsInTail ? fromParts(parts[TAIL_PART]!, parts[7]!) : address;
}

/**
 * `host` (dạng `URL.hostname`, IPv6 có ngoặc vuông) có phải IP viết thẳng không.
 * Hostname của `URL` đã chuẩn hóa dạng thập phân/hex/bát phân về dạng chấm nên không cần parse thêm.
 */
export function isIpLiteral(host: string): boolean {
  return ipaddr.isValid(stripBrackets(host));
}

/** Bỏ cặp ngoặc vuông quanh IPv6 trong `URL.hostname` (`[::1]` → `::1`). */
export function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}
