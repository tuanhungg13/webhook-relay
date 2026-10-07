import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import request from 'supertest';
import { PostgresAccessStore } from '../../src/adapters/postgres/access-store.js';
import { runMigrations } from '../../src/adapters/postgres/migrator.js';
import { createPool } from '../../src/adapters/postgres/pool.js';
import { CreateApp } from '../../src/features/access/create-app.use-case.js';
import { IssueApiKey } from '../../src/features/access/issue-api-key.use-case.js';
import { RevokeApiKey } from '../../src/features/access/revoke-api-key.use-case.js';
import { systemClock } from '../../src/platform/clock.js';
import { createLogger } from '../../src/platform/logger.js';
import { createApiTestApp, memoryLogger } from '../support/api-test-app.js';
import { createTestDatabase } from './postgres-test-db.js';

describe('api authentication on real Postgres', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: pg.Pool;
  let app: INestApplication;
  let log: ReturnType<typeof memoryLogger>;
  let appId: string;
  let issued: { keyId: string; apiKey: string };

  const server = () => app.getHttpServer() as Parameters<typeof request>[0];

  beforeAll(async () => {
    db = await createTestDatabase();
    log = memoryLogger();
    pool = createPool(
      {
        DATABASE_URL: db.url,
        DB_POOL_SIZE: 2,
        DB_STATEMENT_TIMEOUT: 5_000,
        DB_IDLE_TX_TIMEOUT: 30_000,
      },
      log.logger,
    );
    await runMigrations(pool, createLogger({ mode: 'test', level: 'silent' }));

    const store = new PostgresAccessStore(pool);
    ({ appId } = await new CreateApp(store, systemClock).execute({
      name: 'ShopX',
    }));
    const result = await new IssueApiKey(store, systemClock).execute({
      appId: appId as never,
    });
    if (result.status !== 'issued') throw new Error('could not issue a key');
    issued = result;
    app = await createApiTestApp(pool, log.logger);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await db.drop();
  });

  it('I2: a real key reaches the handler with @CurrentApp()', async () => {
    const response = await request(server())
      .get('/v1/whoami')
      .set('Authorization', `Bearer ${issued.apiKey}`)
      .expect(200);
    expect(response.body.appId).toBe(appId);
    expect(response.body.keyPrefix).toBe(issued.apiKey.slice(0, 8));
  });

  it('I3: revoked and unknown keys get byte-identical 401 bodies', async () => {
    const store = new PostgresAccessStore(pool);
    const other = await new IssueApiKey(store, systemClock).execute({
      appId: appId as never,
    });
    if (other.status !== 'issued') throw new Error('could not issue a key');
    await new RevokeApiKey(store, systemClock).execute({ keyId: other.keyId });

    const revoked = await request(server())
      .get('/v1/whoami')
      .set('Authorization', `Bearer ${other.apiKey}`)
      .expect(401);
    const unknown = await request(server())
      .get('/v1/whoami')
      .set('Authorization', `Bearer sk_${'A'.repeat(43)}`)
      .expect(401);
    expect(revoked.text).toBe(unknown.text);
  });

  it('I4: /readyz returns 200 when the database is up', async () => {
    await request(server()).get('/readyz').expect(200, { status: 'ok' });
  });

  it('I5: logs contain neither the raw key nor the word Bearer', async () => {
    await request(server())
      .get('/v1/whoami')
      .set('Authorization', `Bearer ${issued.apiKey}`);
    await request(server())
      .get('/v1/whoami')
      .set('Authorization', 'Bearer sk_nope');
    expect(log.raw()).not.toContain(issued.apiKey);
    expect(log.raw()).not.toMatch(/bearer/i);
  });
});
