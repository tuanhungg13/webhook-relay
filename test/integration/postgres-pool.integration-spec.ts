import { isDatabaseUnavailable } from '../../src/adapters/postgres/errors.js';
import { createPool } from '../../src/adapters/postgres/pool.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from './postgres-test-db.js';

describe('createPool on real Postgres', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  it('I1: applies server-side timeouts and a slow query is classed as unavailable', async () => {
    const pool = createPool(
      {
        DATABASE_URL: db.url,
        DB_POOL_SIZE: 1,
        DB_STATEMENT_TIMEOUT: 5_000,
        DB_IDLE_TX_TIMEOUT: 30_000,
      },
      createLogger({ mode: 'test', level: 'silent' }),
    );
    try {
      const statement = await pool.query('SHOW statement_timeout');
      const idle = await pool.query('SHOW idle_in_transaction_session_timeout');
      expect(statement.rows[0].statement_timeout).toBe('5s');
      expect(idle.rows[0].idle_in_transaction_session_timeout).toBe('30s');
    } finally {
      await pool.end();
    }

    const shortPool = createPool(
      {
        DATABASE_URL: db.url,
        DB_POOL_SIZE: 1,
        DB_STATEMENT_TIMEOUT: 200,
        DB_IDLE_TX_TIMEOUT: 30_000,
      },
      createLogger({ mode: 'test', level: 'silent' }),
    );
    try {
      const error = await shortPool
        .query('SELECT pg_sleep(2)')
        .catch((e: unknown) => e);
      expect(isDatabaseUnavailable(error)).toBe(true);
    } finally {
      await shortPool.end();
    }
  });
});
