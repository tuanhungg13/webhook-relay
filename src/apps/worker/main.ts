import { readFileSync } from 'node:fs';
import { DnsHostResolver } from '../../adapters/http-sender/dns-host-resolver.js';
import { SafeHttpSender } from '../../adapters/http-sender/safe-http-sender.js';
import { PostgresDeliveryStore } from '../../adapters/postgres/delivery-store.js';
import { createPool } from '../../adapters/postgres/pool.js';
import { Deliver } from '../../features/delivery/use-cases/deliver.use-case.js';
import { systemClock } from '../../platform/clock.js';
import { loadWorkerConfig } from '../../platform/config.js';
import {
  exitOnFatalErrors,
  shutdownGracefully,
} from '../../platform/lifecycle.js';
import { createLogger } from '../../platform/logger.js';
import { loadSsrfAllowlist } from '../ssrf-allowlist.js';
import { DeliveryLoop } from './delivery-loop.js';

/**
 * `package.json` ở gốc repo, tính từ file này: `src/apps/worker/` khi chạy test và
 * `dist/apps/worker/` sau `nest build` đều cách gốc ba cấp.
 */
const PACKAGE_JSON_URL = new URL('../../../package.json', import.meta.url);

/** Đọc `User-Agent` = `WebhookRelay/<version>` (spec 07); thiếu `version` thì từ chối khởi động. */
function readUserAgent(): string {
  const { version } = JSON.parse(readFileSync(PACKAGE_JSON_URL, 'utf8')) as {
    version?: unknown;
  };
  if (typeof version !== 'string') {
    throw new Error('package.json has no version for the User-Agent');
  }
  return `WebhookRelay/${version}`;
}

/**
 * Tiến trình `worker` giai đoạn 1: quét Postgres lấy delivery đến hạn, ký, gửi qua bộ gửi chống
 * SSRF, ghi attempt và hẹn retry (D-23). Dừng êm khi nhận SIGTERM/SIGINT (WRK-04).
 */
async function main(): Promise<void> {
  // 1. Cấu hình, logger, allowlist, User-Agent: sai thì dừng trước khi nhận việc
  const config = loadWorkerConfig(process.env);
  const logger = createLogger({ mode: 'worker', level: config.LOG_LEVEL });
  exitOnFatalErrors(logger);
  const allowlist = loadSsrfAllowlist(config, logger);
  const userAgent = readUserAgent();

  // 2. Ghép adapter vào use case và vòng lặp
  const pool = createPool(config, logger);
  const store = new PostgresDeliveryStore(pool);
  const sender = new SafeHttpSender({
    resolver: new DnsHostResolver(),
    allowlist,
    allowInsecureHttp: config.ALLOW_INSECURE_HTTP,
    connectTimeoutMs: config.CONNECT_TIMEOUT,
    requestTimeoutMs: config.REQUEST_TIMEOUT,
  });
  const deliver = new Deliver(store, sender, systemClock, {
    userAgent,
    retryDelaysMs: config.RETRY_DELAYS,
    logger,
  });
  const loop = new DeliveryLoop(
    { store, deliver, clock: systemClock, logger },
    {
      concurrency: config.WORKER_CONCURRENCY,
      idleSleepMs: config.WORKER_IDLE_SLEEP,
      leaseMs: config.LEASE_DURATION,
    },
  );
  // 3. Dừng êm: chờ việc đang gửi xong trước, rồi mới đóng kết nối HTTP và pool mà chúng
  //    đang dùng.
  shutdownGracefully(
    async () => {
      await loop.stop();
      sender.close();
      await pool.end();
    },
    { timeoutMs: config.SHUTDOWN_TIMEOUT, logger },
  );

  // 4. Bắt đầu lấy việc
  loop.start();
  logger.info(
    { concurrency: config.WORKER_CONCURRENCY, user_agent: userAgent },
    'worker started',
  );
}

main().catch((error: unknown) => {
  // Lúc lỗi, logger có thể chưa kịp tạo (vd cấu hình sai), nên in thẳng ra stderr.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
