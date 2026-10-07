import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import request from 'supertest';
import { PostgresAccessStore } from '../../src/adapters/postgres/access-store.js';
import { runMigrations } from '../../src/adapters/postgres/migrator.js';
import { createPool } from '../../src/adapters/postgres/pool.js';
import { CreateApp } from '../../src/features/access/use-cases/create-app.use-case.js';
import { IssueApiKey } from '../../src/features/access/use-cases/issue-api-key.use-case.js';
import { systemClock } from '../../src/platform/clock.js';
import { createLogger } from '../../src/platform/logger.js';
import { createApiTestApp, memoryLogger } from '../support/api-test-app.js';
import { createTestDatabase } from './postgres-test-db.js';

/** Body tạo endpoint hợp lệ cho `customer`. */
export function validBody(customer: string) {
  return {
    customer_id: customer,
    url: 'https://shop.example/hook',
    event_types: ['order.created'],
  };
}

/** Header xác thực bằng API key `key`. */
export function auth(key: string): { Authorization: string } {
  return { Authorization: `Bearer ${key}` };
}

/** Những gì test endpoint API dùng; các trường được gán trong `beforeAll`. */
export interface EndpointApi {
  /** HTTP server của app Nest, để truyền cho supertest. */
  server: () => Parameters<typeof request>[0];
  /** Key của app A (app chính) và app B (app khác, để kiểm API-04). */
  keyA: string;
  keyB: string;
  /** Log của tiến trình api trong suite, để kiểm không lộ secret. */
  log: ReturnType<typeof memoryLogger>;
  /** Mọi secret API trả ra trong suite, để H11 kiểm log không chứa chúng. */
  secretsSeen: string[];
  /** Tạo endpoint (mặc định bằng key A), trả body phản hồi 201 và ghi nhớ secret. */
  create: (
    customer: string,
    key?: string,
  ) => Promise<{ id: string; secret: string }>;
}

/**
 * Dựng app `api` trên một database Postgres riêng cho suite gọi hàm này (đặt trong `describe`),
 * kèm hai app có key. Tự đăng ký `beforeAll`/`afterAll` để mở và dọn mọi tài nguyên.
 */
export function useEndpointApi(): EndpointApi {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: pg.Pool;
  let app: INestApplication;

  const api: EndpointApi = {
    server: () => app.getHttpServer() as Parameters<typeof request>[0],
    keyA: '',
    keyB: '',
    log: memoryLogger(),
    secretsSeen: [],
    create: async (customer, key = api.keyA) => {
      const response = await request(api.server())
        .post('/v1/endpoints')
        .set(auth(key))
        .send(validBody(customer))
        .expect(201);
      api.secretsSeen.push(response.body.secret);
      return response.body as { id: string; secret: string };
    },
  };

  /** Tạo app mới và cấp một key cho nó. */
  async function appWithKey(): Promise<string> {
    const store = new PostgresAccessStore(pool);
    const { appId } = await new CreateApp(store, systemClock).execute({
      name: 'ShopX',
    });
    const issued = await new IssueApiKey(store, systemClock).execute({ appId });
    if (issued.status !== 'issued') throw new Error('could not issue a key');
    return issued.apiKey;
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = createPool(
      {
        DATABASE_URL: db.url,
        DB_POOL_SIZE: 5,
        DB_STATEMENT_TIMEOUT: 5_000,
        DB_IDLE_TX_TIMEOUT: 30_000,
      },
      api.log.logger,
    );
    await runMigrations(pool, createLogger({ mode: 'test', level: 'silent' }));
    api.keyA = await appWithKey();
    api.keyB = await appWithKey();
    app = await createApiTestApp(pool, api.log.logger);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await db.drop();
  });

  return api;
}

/** H11: log của suite không chứa secret nào API đã trả ra, cũng không có chuỗi `whsec_` (SEC-13). */
export function expectNoSecretsLogged(api: EndpointApi): void {
  expect(api.secretsSeen.length).toBeGreaterThan(0);
  for (const secret of api.secretsSeen)
    expect(api.log.raw()).not.toContain(secret);
  expect(api.log.raw()).not.toContain('whsec_');
}
