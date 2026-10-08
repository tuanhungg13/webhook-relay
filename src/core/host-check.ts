import {
  type Cidr,
  isAllowedAddress,
  isIpLiteral,
  stripBrackets,
} from './ip-policy.js';

/** Hàm phân giải tên miền ra mọi IP; ném lỗi khi không phân giải được. */
export type ResolveHost = (host: string) => Promise<string[]>;

/**
 * Kết quả kiểm host: `ok` kèm IP đầu tiên (để bộ gửi ghim), `blocked` khi có IP không được
 * phép, `unresolved` khi không phân giải được hoặc không có IP nào.
 */
export type HostCheck =
  | { status: 'ok'; address: string }
  | { status: 'blocked' }
  | { status: 'unresolved' };

/**
 * Kiểm host của URL theo SEC-01/SEC-02: host là IP viết thẳng thì kiểm luôn (không gọi DNS);
 * ngược lại phân giải và **mọi** IP trả về phải được phép. Dùng chung cho lúc đăng ký và lúc gửi.
 */
export async function checkHost(
  host: string,
  resolve: ResolveHost,
  allowlist: readonly Cidr[],
): Promise<HostCheck> {
  if (isIpLiteral(host)) {
    const address = stripBrackets(host);
    return isAllowedAddress(address, allowlist)
      ? { status: 'ok', address }
      : { status: 'blocked' };
  }
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return { status: 'unresolved' };
  }
  const [first] = addresses;
  if (first === undefined) return { status: 'unresolved' };
  return addresses.every((ip) => isAllowedAddress(ip, allowlist))
    ? { status: 'ok', address: first }
    : { status: 'blocked' };
}
