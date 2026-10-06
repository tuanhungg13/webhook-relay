import { NestFactory } from '@nestjs/core';
import { loadApiConfig } from '../../platform/config.js';
import {
  exitOnFatalErrors,
  shutdownGracefully,
} from '../../platform/lifecycle.js';
import { createLogger } from '../../platform/logger.js';
import { NestLogger } from '../nest-logger.js';
import { ApiModule } from './api.module.js';

async function main(): Promise<void> {
  const config = loadApiConfig(process.env);
  const logger = createLogger({ mode: 'api', level: config.LOG_LEVEL });
  exitOnFatalErrors(logger);

  const app = await NestFactory.create(ApiModule, {
    logger: new NestLogger(logger),
  });
  shutdownGracefully(() => app.close(), {
    timeoutMs: config.SHUTDOWN_TIMEOUT,
    logger,
  });

  const { host, port } = config.API_ADDR;
  await app.listen(port, host);
  logger.info({ host, port }, 'api listening');
}

main().catch((error: unknown) => {
  // The logger may not exist yet (e.g. invalid configuration), so report on stderr.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
