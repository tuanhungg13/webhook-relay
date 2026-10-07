import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import pg from 'pg';
import { PostgresAccessStore } from '../../adapters/postgres/access-store.js';
import { PostgresEndpointStore } from '../../adapters/postgres/endpoint-store.js';
import { AuthenticateApiKey } from '../../features/access/use-cases/authenticate-api-key.use-case.js';
import { CreateEndpoint } from '../../features/endpoints/use-cases/create-endpoint.use-case.js';
import { DeleteEndpoint } from '../../features/endpoints/use-cases/delete-endpoint.use-case.js';
import { DisableEndpoint } from '../../features/endpoints/use-cases/disable-endpoint.use-case.js';
import { EnableEndpoint } from '../../features/endpoints/use-cases/enable-endpoint.use-case.js';
import { GetEndpoint } from '../../features/endpoints/use-cases/get-endpoint.use-case.js';
import {
  ENDPOINT_USE_CASES,
  type EndpointUseCases,
  EndpointsController,
} from '../../features/endpoints/http/endpoints.controller.js';
import { ListEndpoints } from '../../features/endpoints/use-cases/list-endpoints.use-case.js';
import { RotateEndpointSecret } from '../../features/endpoints/use-cases/rotate-endpoint-secret.use-case.js';
import { UpdateEndpoint } from '../../features/endpoints/use-cases/update-endpoint.use-case.js';
import { systemClock } from '../../platform/clock.js';
import type { Logger } from '../../platform/logger.js';
import { ApiKeyGuard } from './http/api-key.guard.js';
import { HealthController } from './health.controller.js';
import { LOGGER } from './logger.token.js';
import { ReadinessController } from './readiness.controller.js';

/**
 * Cấu hình của các use case endpoint, lấy từ `ALLOW_INSECURE_HTTP`,
 * `ENDPOINTS_PER_CUSTOMER_MAX` và `SECRET_ROTATION_GRACE` (đã đổi ra mili giây).
 */
export interface EndpointsConfig {
  allowInsecureHttp: boolean;
  maxPerCustomer: number;
  rotationGraceMs: number;
}

/** Thứ module `api` cần từ bên ngoài: kết nối Postgres, logger và cấu hình, do `main` (hoặc test) tạo. */
export interface ApiModuleOptions {
  pool: pg.Pool;
  logger: Logger;
  endpoints: EndpointsConfig;
}

/**
 * Composition root của tiến trình `api`: lắp use case và guard vào adapter.
 *
 * Guard đăng ký toàn cục (`APP_GUARD`) và mặc định bắt xác thực: route mới tự được bảo vệ,
 * chỉ route có `@Public()` mới được bỏ qua.
 */
@Module({})
export class ApiModule {
  /** Tạo module với pool, logger và cấu hình cụ thể; mọi phụ thuộc ngoài được truyền vào đây. */
  static register(options: ApiModuleOptions): DynamicModule {
    return {
      module: ApiModule,
      controllers: [HealthController, ReadinessController, EndpointsController],
      providers: [
        { provide: pg.Pool, useValue: options.pool },
        { provide: LOGGER, useValue: options.logger },
        {
          provide: AuthenticateApiKey,
          useFactory: () =>
            new AuthenticateApiKey(new PostgresAccessStore(options.pool)),
        },
        {
          provide: ENDPOINT_USE_CASES,
          useFactory: () => endpointUseCases(options.pool, options.endpoints),
        },
        { provide: APP_GUARD, useClass: ApiKeyGuard },
      ],
    };
  }
}

/** Lắp tám use case endpoint vào cùng một `PostgresEndpointStore` và đồng hồ thật. */
function endpointUseCases(
  pool: pg.Pool,
  config: EndpointsConfig,
): EndpointUseCases {
  const store = new PostgresEndpointStore(pool);
  return {
    create: new CreateEndpoint(store, systemClock, config),
    get: new GetEndpoint(store),
    list: new ListEndpoints(store),
    update: new UpdateEndpoint(store, systemClock, config),
    delete: new DeleteEndpoint(store, systemClock),
    disable: new DisableEndpoint(store, systemClock),
    enable: new EnableEndpoint(store, systemClock),
    rotateSecret: new RotateEndpointSecret(store, systemClock, config),
  };
}
