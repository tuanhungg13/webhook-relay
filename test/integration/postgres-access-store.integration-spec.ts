import pg from 'pg';
import { PostgresAccessStore } from '../../src/adapters/postgres/access-store.js';
import { runMigrations } from '../../src/adapters/postgres/migrator.js';
import { createLogger } from '../../src/platform/logger.js';
import { describeAccessStoreContract } from '../contract/access-store.contract.js';
import { createTestDatabase } from './postgres-test-db.js';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let pool: pg.Pool;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 2 });
  await runMigrations(pool, createLogger({ mode: 'test', level: 'silent' }));
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

// Mỗi ca cần store rỗng: xóa app kéo theo xóa key (CASCADE) thay vì tạo lại database.
describeAccessStoreContract('postgres', async () => {
  await pool.query('TRUNCATE apps CASCADE');
  return { store: new PostgresAccessStore(pool) };
});
