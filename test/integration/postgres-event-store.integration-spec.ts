import pg from 'pg';
import { PostgresAccessStore } from '../../src/adapters/postgres/access-store.js';
import { PostgresEndpointStore } from '../../src/adapters/postgres/endpoint-store.js';
import { PostgresEventStore } from '../../src/adapters/postgres/event-store.js';
import { runMigrations } from '../../src/adapters/postgres/migrator.js';
import { type Id, idToUuid } from '../../src/core/id.js';
import { CreateApp } from '../../src/features/access/use-cases/create-app.use-case.js';
import { systemClock } from '../../src/platform/clock.js';
import { createLogger } from '../../src/platform/logger.js';
import {
  buildClaim,
  buildEvent,
  describeEventStoreContract,
  TTL_MS,
} from '../contract/event-store.contract.js';
import { buildEndpoint } from '../contract/endpoint-store.contract.js';
import { createTestDatabase } from './postgres-test-db.js';

/** Số request song song trong các ca đồng thời, giống thực nghiệm khi lập kế hoạch. */
const CONCURRENT_REQUESTS = 50;

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let pool: pg.Pool;

/** Tạo app thật trong database (sự kiện có khóa ngoại tới `apps`). */
async function createApp() {
  const { appId } = await new CreateApp(
    new PostgresAccessStore(pool),
    systemClock,
  ).execute({ name: 'ShopX' });
  return appId;
}

/** Đếm dòng của `table` thuộc app (qua cột `app_id`). */
async function countRows(
  table: 'events' | 'idempotency_keys',
  appId: Id<'app'>,
) {
  const { rows } = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${table} WHERE app_id = $1`,
    [idToUuid(appId)],
  );
  return rows[0]?.count ?? 0;
}

beforeAll(async () => {
  db = await createTestDatabase();
  // Đủ kết nối để các ca đồng thời thật sự chạy song song nhiều transaction.
  pool = new pg.Pool({ connectionString: db.url, max: 60 });
  await runMigrations(pool, createLogger({ mode: 'test', level: 'silent' }));
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

// Mỗi ca cần store rỗng: xóa app kéo theo xóa sự kiện, endpoint (CASCADE).
describeEventStoreContract('postgres', async () => {
  await pool.query('TRUNCATE apps CASCADE');
  const endpoints = new PostgresEndpointStore(pool);
  return {
    store: new PostgresEventStore(pool),
    createApp,
    addEndpoint: async (appId, seed) => {
      const endpoint = buildEndpoint(appId, {
        customerId: seed.customerId,
        eventTypes: seed.eventTypes,
      });
      await endpoints.insertWithinLimit(endpoint, 100);
      const at = new Date();
      if (seed.deleted) await endpoints.softDelete(appId, endpoint.id, at);
      if (seed.disabled) await endpoints.disable(appId, endpoint.id, at);
      return endpoint.id;
    },
  };
});

describe('PostgresEventStore idempotency under concurrency', () => {
  it('EC6: 50 parallel ingests with the same key and hash → 1 created, 49 duplicate, 1 event', async () => {
    const store = new PostgresEventStore(pool);
    const appId = await createApp();

    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, () => {
        const event = buildEvent(appId);
        return store.ingest({
          event,
          idempotency: buildClaim('k-same', 'hash-a', event.createdAt),
        });
      }),
    );

    expect(outcomes.filter((o) => o.status === 'created')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'duplicate')).toHaveLength(
      CONCURRENT_REQUESTS - 1,
    );
    expect(await countRows('events', appId)).toBe(1);
    expect(await countRows('idempotency_keys', appId)).toBe(1);
  });

  it('EC7: 50 parallel ingests, half with another hash → 1 created, the rest duplicate or conflict, 0 errors', async () => {
    const store = new PostgresEventStore(pool);
    const appId = await createApp();

    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, (_, i) => {
        const event = buildEvent(appId);
        const hash = i % 2 === 0 ? 'hash-a' : 'hash-b';
        return store.ingest({
          event,
          idempotency: buildClaim('k-mixed', hash, event.createdAt),
        });
      }),
    );

    const count = (status: string) =>
      outcomes.filter((o) => o.status === status).length;
    expect(count('created')).toBe(1);
    expect(count('duplicate') + count('conflict')).toBe(
      CONCURRENT_REQUESTS - 1,
    );
    expect(count('conflict')).toBeGreaterThan(0);
    expect(await countRows('events', appId)).toBe(1);
  });

  it('EC8: 50 parallel ingests on an expired key → exactly 1 new event, the rest duplicate it', async () => {
    const store = new PostgresEventStore(pool);
    const appId = await createApp();
    const old = buildEvent(appId);
    await store.ingest({
      event: old,
      idempotency: buildClaim('k-old', 'hash-a', old.createdAt),
    });

    const later = new Date(old.createdAt.getTime() + TTL_MS + 3_600_000);
    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, () => {
        const event = buildEvent(appId, { createdAt: later });
        return store.ingest({
          event,
          idempotency: buildClaim('k-old', 'hash-a', later),
        });
      }),
    );

    const created = outcomes.filter((o) => o.status === 'created');
    expect(created).toHaveLength(1);
    const duplicates = outcomes.filter((o) => o.status === 'duplicate');
    expect(duplicates).toHaveLength(CONCURRENT_REQUESTS - 1);
    // Mọi bản trùng trỏ về sự kiện MỚI, không phải sự kiện cũ đã hết hạn.
    for (const outcome of duplicates) {
      expect(outcome).toMatchObject({ createdAt: later });
    }
    expect(await countRows('events', appId)).toBe(2);
  });
});
