import {
  Body,
  Controller,
  Get,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type pg from 'pg';
import { pino } from 'pino';
import type { Logger } from '../../src/platform/logger.js';
import {
  ApiModule,
  type EndpointsConfig,
} from '../../src/apps/api/api.module.js';
import {
  API_APP_OPTIONS,
  configureApiApp,
} from '../../src/apps/api/configure-api-app.js';
import { Public } from '../../src/apps/api/http/public.js';
import {
  type AuthenticatedApp,
  CurrentApp,
} from '../../src/platform/http/current-app.js';

/** Giới hạn body dùng trong test: nhỏ để test vượt giới hạn chạy nhanh. */
export const TEST_MAX_BODY_BYTES = 1024;

/** Route chỉ có trong test: `/v1/whoami` cần key; `/echo` và `/boom` công khai. */
@Controller()
class TestRoutesController {
  @Get('v1/whoami')
  /** Trả lại app đã xác thực để test kiểm `@CurrentApp()`. */
  whoami(@CurrentApp() app: AuthenticatedApp): AuthenticatedApp {
    return app;
  }

  @Public()
  @Post('echo')
  /** Trả lại body đã parse (null nếu không có body). */
  echo(@Body() body: unknown): { received: unknown } {
    return { received: body === undefined ? null : body };
  }

  @Public()
  @Get('boom')
  /** Ném lỗi lạ để test 500 không lộ chi tiết. */
  boom(): never {
    throw new Error('secret detail');
  }
}

/** Đọc log vào bộ nhớ để test kiểm tra nội dung log. */
export function memoryLogger(): {
  logger: Logger;
  lines: () => Record<string, unknown>[];
  raw: () => string;
} {
  let text = '';
  const logger = pino(
    { level: 'debug' },
    {
      write: (chunk: string) => {
        text += chunk;
      },
    },
  );
  return {
    logger,
    raw: () => text,
    lines: () =>
      text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** Cấu hình endpoint dùng trong test: giống mặc định của `loadApiConfig`, chỉ dùng https. */
export const TEST_ENDPOINTS_CONFIG: EndpointsConfig = {
  allowInsecureHttp: false,
  maxPerCustomer: 20,
  rotationGraceMs: 86_400_000,
};

/**
 * Dựng app `api` giống `main` (cùng `configureApiApp`) cùng vài route chỉ dùng cho test.
 * `pool` do bên gọi tạo và đóng.
 */
export async function createApiTestApp(
  pool: pg.Pool,
  logger: Logger,
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ApiModule.register({ pool, logger, endpoints: TEST_ENDPOINTS_CONFIG }),
    ],
    controllers: [TestRoutesController],
  }).compile();
  const app = moduleRef.createNestApplication({
    ...API_APP_OPTIONS,
    logger: false,
  });
  configureApiApp(app, { logger, maxBodyBytes: TEST_MAX_BODY_BYTES });
  await app.init();
  return app;
}
