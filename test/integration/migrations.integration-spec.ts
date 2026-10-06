import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from '../../src/adapters/postgres/migrator.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from './postgres-test-db.js';

const logger = createLogger({ mode: 'test', level: 'silent' });
const NOW = new Date('2026-10-06T12:00:00Z');
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';

describe('postgres migrations', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: pg.Pool;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new pg.Pool({ connectionString: db.url, max: 4 });
  });

  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  it('applies every migration once and is a no-op when run again', async () => {
    expect(await runMigrations(pool, logger)).toEqual(['0001_init.sql']);
    expect(await runMigrations(pool, logger)).toEqual([]);
  });

  it('is safe when two runners start at the same time', async () => {
    const fresh = await createTestDatabase();
    const freshPool = new pg.Pool({ connectionString: fresh.url, max: 4 });
    try {
      const results = await Promise.all([
        runMigrations(freshPool, logger),
        runMigrations(freshPool, logger),
      ]);
      expect(results.flat()).toEqual(['0001_init.sql']);
    } finally {
      await freshPool.end();
      await fresh.drop();
    }
  });

  describe('schema constraints', () => {
    let appId: string;
    let endpointId: string;
    let eventId: string;

    beforeAll(async () => {
      await runMigrations(pool, logger);
      appId = randomUUID();
      endpointId = randomUUID();
      eventId = randomUUID();
      await pool.query(
        `INSERT INTO apps (id, name, created_at) VALUES ($1, 'ShopX', $2)`,
        [appId, NOW],
      );
      await pool.query(
        `INSERT INTO endpoints (id, app_id, customer_id, url, event_types, secret,
           rate_limit_rps, max_concurrency, created_at, updated_at)
         VALUES ($1, $2, 'shop-01', 'https://example.com/hook', '{order.created}',
           'whsec_x', 50, 10, $3, $3)`,
        [endpointId, appId, NOW],
      );
      await insertEvent(eventId);
    });

    async function insertEvent(id: string): Promise<void> {
      await pool.query(
        `INSERT INTO events (id, app_id, customer_id, type, payload, created_at)
         VALUES ($1, $2, 'shop-01', 'order.created', '{}', $3)`,
        [id, appId, NOW],
      );
    }

    async function insertDelivery(
      columns: { status?: string; leaseToken?: string | null } = {},
    ): Promise<string> {
      const id = randomUUID();
      const leaseToken = columns.leaseToken ?? null;
      await pool.query(
        `INSERT INTO deliveries (id, event_id, endpoint_id, status, attempt_count,
           next_attempt_at, lease_until, lease_token, gate_blocked_count, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 0, $5, $6, $7, 0, $5, $5)`,
        [
          id,
          eventId,
          endpointId,
          columns.status ?? 'pending',
          NOW,
          leaseToken ? NOW : null,
          leaseToken,
        ],
      );
      return id;
    }

    it('allows one delivery per (event, endpoint) (DAT-10)', async () => {
      await insertDelivery();
      await expect(insertDelivery()).rejects.toMatchObject({
        code: UNIQUE_VIOLATION,
      });
    });

    it('rejects an in_flight delivery without a lease token (WRK-09)', async () => {
      await pool.query('DELETE FROM deliveries');
      await expect(
        insertDelivery({ status: 'in_flight' }),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it('rejects a duplicate attempt number for one delivery (DAT-11)', async () => {
      await pool.query('DELETE FROM deliveries');
      const deliveryId = await insertDelivery();
      const insertAttempt = () =>
        pool.query(
          `INSERT INTO attempts (id, delivery_id, attempt_number, started_at, duration_ms, http_status)
           VALUES ($1, $2, 1, $3, 12, 500)`,
          [randomUUID(), deliveryId, NOW],
        );
      await insertAttempt();
      await expect(insertAttempt()).rejects.toMatchObject({
        code: UNIQUE_VIOLATION,
      });
    });

    it('accepts an idempotency key written before its event in one transaction (ING-03.6)', async () => {
      const client = await pool.connect();
      const laterEventId = randomUUID();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO idempotency_keys (app_id, key, event_id, request_hash, created_at)
           VALUES ($1, 'k-1', $2, '\\x00', $3)`,
          [appId, laterEventId, NOW],
        );
        await client.query(
          `INSERT INTO events (id, app_id, customer_id, type, payload, created_at)
           VALUES ($1, $2, 'shop-01', 'order.created', '{}', $3)`,
          [laterEventId, appId, NOW],
        );
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    });

    it('rejects at commit an idempotency key whose event was never written', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO idempotency_keys (app_id, key, event_id, request_hash, created_at)
           VALUES ($1, 'k-2', $2, '\\x00', $3)`,
          [appId, randomUUID(), NOW],
        );
        await expect(client.query('COMMIT')).rejects.toMatchObject({
          code: FOREIGN_KEY_VIOLATION,
        });
      } finally {
        client.release();
      }
    });
  });
});
