import { NestFactory } from '@nestjs/core';
import { DnsHostResolver } from '../../adapters/http-sender/dns-host-resolver.js';
import { createPool } from '../../adapters/postgres/pool.js';
import { parseCidrList } from '../../core/ip-policy.js';
import { loadApiConfig } from '../../platform/config.js';
import {
  exitOnFatalErrors,
  shutdownGracefully,
} from '../../platform/lifecycle.js';
import { createLogger } from '../../platform/logger.js';
import { NestLogger } from '../nest-logger.js';
import { ApiModule } from './api.module.js';
import { API_APP_OPTIONS, configureApiApp } from './configure-api-app.js';

async function main(): Promise<void> {
  const config = loadApiConfig(process.env);
  const logger = createLogger({ mode: 'api', level: config.LOG_LEVEL });
  exitOnFatalErrors(logger);
  // Chỉ dùng cho dev/test; production đã bị chặn ở bước đọc cấu hình (SEC-05).
  if (config.ALLOW_INSECURE_HTTP) {
    logger.warn(
      { app_env: config.APP_ENV },
      'ALLOW_INSECURE_HTTP is enabled: endpoints may use plain http',
    );
  }

  // CIDR sai tinh vi hơn regex của config thì lỗi ở đây, trước khi nhận request.
  const ssrfAllowlist = parseCidrList(config.SSRF_ALLOWLIST);
  // Chỉ dùng cho dev/test; production đã bị chặn ở bước đọc cấu hình (SEC-05).
  if (ssrfAllowlist.length > 0) {
    logger.warn(
      { app_env: config.APP_ENV, ranges: ssrfAllowlist.length },
      'SSRF_ALLOWLIST is enabled: internal address ranges may be used as endpoints',
    );
  }

  const pool = createPool(config, logger);
  const endpoints = {
    allowInsecureHttp: config.ALLOW_INSECURE_HTTP,
    maxPerCustomer: config.ENDPOINTS_PER_CUSTOMER_MAX,
    rotationGraceMs: config.SECRET_ROTATION_GRACE,
  };
  const ingestion = { idempotencyTtlMs: config.IDEMPOTENCY_TTL };
  const app = await NestFactory.create(
    ApiModule.register({
      pool,
      logger,
      endpoints,
      hostCheck: { resolver: new DnsHostResolver(), allowlist: ssrfAllowlist },
      ingestion,
    }),
    { ...API_APP_OPTIONS, logger: new NestLogger(logger) },
  );
  configureApiApp(app, { logger, maxBodyBytes: config.MAX_BODY_BYTES });
  // Đóng nhận request trước, rồi mới đóng pool: request đang chạy còn cần kết nối.
  shutdownGracefully(
    async () => {
      await app.close();
      await pool.end();
    },
    { timeoutMs: config.SHUTDOWN_TIMEOUT, logger },
  );

  const { host, port } = config.API_ADDR;
  await app.listen(port, host);
  logger.info({ host, port }, 'api listening');
}

main().catch((error: unknown) => {
  // The logger may not exist yet (e.g. invalid configuration), so report on stderr.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
