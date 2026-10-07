import pg from 'pg';
import { PostgresAccessStore } from '../../src/adapters/postgres/access-store.js';
import { PostgresEndpointStore } from '../../src/adapters/postgres/endpoint-store.js';
import { runMigrations } from '../../src/adapters/postgres/migrator.js';
import { idToUuid } from '../../src/core/id.js';
import { CreateApp } from '../../src/features/access/use-cases/create-app.use-case.js';
import { systemClock } from '../../src/platform/clock.js';
import { createLogger } from '../../src/platform/logger.js';
import {
  buildEndpoint,
  describeEndpointStoreContract,
} from '../contract/endpoint-store.contract.js';
import { createTestDatabase } from './postgres-test-db.js';

/** Số request tạo song song trong ca EC9, giống thực nghiệm khi lập kế hoạch. */
const CONCURRENT_INSERTS = 40;
/** Giới hạn endpoint mỗi customer trong ca EC9. */
const LIMIT = 20;

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let pool: pg.Pool;

/** Tạo app thật trong database (endpoint có khóa ngoại tới `apps`). */
async function createApp() {
  const { appId } = await new CreateApp(
    new PostgresAccessStore(pool),
    systemClock,
  ).execute({ name: 'ShopX' });
  return appId;
}

beforeAll(async () => {
  db = await createTestDatabase();
  // Đủ kết nối để EC9 thật sự chạy song song nhiều transaction.
  pool = new pg.Pool({ connectionString: db.url, max: 20 });
  await runMigrations(pool, createLogger({ mode: 'test', level: 'silent' }));
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

// Mỗi ca cần store rỗng: xóa app kéo theo xóa endpoint (CASCADE).
describeEndpointStoreContract('postgres', async () => {
  await pool.query('TRUNCATE apps CASCADE');
  return { store: new PostgresEndpointStore(pool), createApp };
});

describe('PostgresEndpointStore concurrency', () => {
  it('EC9: 40 parallel inserts with max=20 → exactly 20 inserted, 20 rows (API-30)', async () => {
    const store = new PostgresEndpointStore(pool);
    const appId = await createApp();

    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENT_INSERTS }, () =>
        store.insertWithinLimit(buildEndpoint(appId), LIMIT),
      ),
    );

    expect(outcomes.filter((o) => o === 'inserted')).toHaveLength(LIMIT);
    expect(outcomes.filter((o) => o === 'limit_exceeded')).toHaveLength(
      CONCURRENT_INSERTS - LIMIT,
    );
    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM endpoints WHERE app_id = $1',
      [idToUuid(appId)],
    );
    expect(rows[0]?.count).toBe(LIMIT);
  });

  it('list uses endpoints_by_app without a customer filter and endpoints_by_customer with one', async () => {
    // Dữ liệu giống thực nghiệm D2 của kế hoạch: 100 app × 200 endpoint xen kẽ theo thời gian,
    // 10 endpoint mỗi customer. `uuidv7()` có sẵn từ Postgres 18; ANALYZE cập nhật thống kê.
    const apps = await Promise.all(Array.from({ length: 100 }, createApp));
    await pool.query(
      `INSERT INTO endpoints (id, app_id, customer_id, url, event_types, secret,
         rate_limit_rps, max_concurrency, created_at, updated_at)
       SELECT uuidv7(), app_id, 'cus_' || (n % 20), 'https://a.example/h',
              ARRAY['order.created'], 'whsec_x', 50, 10, now(), now()
       FROM generate_series(1, 200) AS n, unnest($1::uuid[]) AS app_id`,
      [apps.map(idToUuid)],
    );
    await pool.query('ANALYZE endpoints');

    // Cùng câu SQL với `PostgresEndpointStore.list`; EXPLAIN cho biết chỉ mục được chọn.
    const plan = async (customerId: string | null) => {
      const { rows } = await pool.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT * FROM endpoints
         WHERE app_id = $1 AND deleted_at IS NULL
           AND ($2::text IS NULL OR customer_id = $2)
           AND ($3::uuid IS NULL OR id < $3)
         ORDER BY id DESC LIMIT $4`,
        [idToUuid(apps[0]!), customerId, null, 51],
      );
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    };
    expect(await plan(null)).toContain('endpoints_by_app');
    expect(await plan('cus_1')).toContain('endpoints_by_customer');
  });
});
