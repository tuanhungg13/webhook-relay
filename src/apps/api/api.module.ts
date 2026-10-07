import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import pg from 'pg';
import { PostgresAccessStore } from '../../adapters/postgres/access-store.js';
import { AuthenticateApiKey } from '../../features/access/authenticate-api-key.use-case.js';
import type { Logger } from '../../platform/logger.js';
import { ApiKeyGuard } from './http/api-key.guard.js';
import { HealthController } from './health.controller.js';
import { LOGGER } from './logger.token.js';
import { ReadinessController } from './readiness.controller.js';

/** Thứ module `api` cần từ bên ngoài: kết nối Postgres và logger, do `main` (hoặc test) tạo. */
export interface ApiModuleOptions {
  pool: pg.Pool;
  logger: Logger;
}

/**
 * Composition root của tiến trình `api`: lắp use case và guard vào adapter.
 *
 * Guard đăng ký toàn cục (`APP_GUARD`) và mặc định bắt xác thực: route mới tự được bảo vệ,
 * chỉ route có `@Public()` mới được bỏ qua.
 */
@Module({})
export class ApiModule {
  /** Tạo module với pool và logger cụ thể; mọi phụ thuộc ngoài được truyền vào đây. */
  static register(options: ApiModuleOptions): DynamicModule {
    return {
      module: ApiModule,
      controllers: [HealthController, ReadinessController],
      providers: [
        { provide: pg.Pool, useValue: options.pool },
        { provide: LOGGER, useValue: options.logger },
        {
          provide: AuthenticateApiKey,
          useFactory: () =>
            new AuthenticateApiKey(new PostgresAccessStore(options.pool)),
        },
        { provide: APP_GUARD, useClass: ApiKeyGuard },
      ],
    };
  }
}
