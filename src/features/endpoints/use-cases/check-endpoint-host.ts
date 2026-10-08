import { checkHost } from '../../../core/host-check.js';
import type { Cidr } from '../../../core/ip-policy.js';
import type { HostResolver } from '../ports/host-resolver.port.js';

/** Thứ cần để kiểm host của endpoint: bộ phân giải DNS và `SSRF_ALLOWLIST` đã parse. */
export interface HostCheckDeps {
  resolver: HostResolver;
  allowlist: readonly Cidr[];
}

/**
 * Kiểm host của URL endpoint (đã qua luật tĩnh) theo SEC-01: không được trỏ vào IP nội bộ.
 * Trả `null` nếu hợp lệ, ngược lại trả mô tả lỗi cho `details` của 422; mô tả không chứa URL (SEC-13).
 */
export async function checkEndpointHost(
  url: string,
  deps: HostCheckDeps,
): Promise<string | null> {
  // Luật tĩnh đã đảm bảo URL parse được; `!` thể hiện điều đó.
  const { hostname } = URL.parse(url)!;
  const result = await checkHost(
    hostname,
    (host) => deps.resolver.resolve(host),
    deps.allowlist,
  );
  switch (result.status) {
    case 'ok':
      return null;
    case 'blocked':
      return 'host must not resolve to a private or reserved address';
    case 'unresolved':
      return 'host could not be resolved';
  }
}
