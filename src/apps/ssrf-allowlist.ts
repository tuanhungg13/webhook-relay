import { type Cidr, parseCidrList } from '../core/ip-policy.js';
import type { Logger } from '../platform/logger.js';

/**
 * Đọc `SSRF_ALLOWLIST` ra danh sách CIDR và log `warn` khi bật `ALLOW_INSECURE_HTTP` hoặc
 * allowlist khác rỗng (spec 13). Dùng chung cho api và worker.
 *
 * Production đã bị chặn ở bước đọc cấu hình (SEC-05), nên các cảnh báo chỉ gặp ở dev/test.
 * CIDR sai tinh vi hơn regex của config thì `parseCidrList` ném lỗi ở đây, trước khi tiến trình
 * nhận việc.
 */
export function loadSsrfAllowlist(
  config: {
    APP_ENV: string;
    ALLOW_INSECURE_HTTP: boolean;
    SSRF_ALLOWLIST: string;
  },
  logger: Logger,
): Cidr[] {
  if (config.ALLOW_INSECURE_HTTP) {
    logger.warn(
      { app_env: config.APP_ENV },
      'ALLOW_INSECURE_HTTP is enabled: endpoints may use plain http',
    );
  }
  const allowlist = parseCidrList(config.SSRF_ALLOWLIST);
  if (allowlist.length > 0) {
    logger.warn(
      { app_env: config.APP_ENV, ranges: allowlist.length },
      'SSRF_ALLOWLIST is enabled: internal address ranges may be used as endpoints',
    );
  }
  return allowlist;
}
