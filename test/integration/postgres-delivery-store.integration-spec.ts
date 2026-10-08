import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresAccessStore } from '../../src/adapters/postgres/access-store.js';
import { PostgresDeliveryStore } from '../../src/adapters/postgres/delivery-store.js';
import { PostgresEndpointStore } from '../../src/adapters/postgres/endpoint-store.js';
import { runMigrations } from '../../src/adapters/postgres/migrator.js';
import { type Id, idFromUuid, idToUuid, newId } from '../../src/core/id.js';
import { CreateApp } from '../../src/features/access/use-cases/create-app.use-case.js';
import { systemClock } from '../../src/platform/clock.js';
import { createLogger } from '../../src/platform/logger.js';
import {
  at,
  type DeliverySeed,
  type DeliveryView,
  describeDeliveryStoreContract,
  LEASE_MS,
  NOW,
  SEED_ENDPOINT,
  SEED_EVENT,
  SEED_GONE_AT,
} from '../contract/delivery-store.contract.js';
import { buildEndpoint } from '../contract/endpoint-store.contract.js';
import { createTestDatabase } from './postgres-test-db.js';

/** Số lời gọi `claimDue` song song trong ca tranh chấp, như thực nghiệm khi lập kế hoạch. */
const CONCURRENT_CLAIMS = 20;

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let pool: pg.Pool;
let appId: Id<'app'>;

beforeAll(async () => {
  db = await createTestDatabase();
  // Đủ kết nối để các lời gọi song song thật sự chạy trên các session khác nhau.
  pool = new pg.Pool({ connectionString: db.url, max: 30 });
  await runMigrations(pool, createLogger({ mode: 'test', level: 'silent' }));
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

/** Xóa sạch dữ liệu (CASCADE kéo theo endpoint, sự kiện, delivery, attempt) rồi tạo app mới. */
async function resetDatabase(): Promise<void> {
  await pool.query('TRUNCATE apps CASCADE');
  ({ appId } = await new CreateApp(
    new PostgresAccessStore(pool),
    systemClock,
  ).execute({ name: 'ShopX' }));
}

/** Dựng endpoint (theo `seed.endpoint`) + sự kiện + delivery + attempt cũ bằng dòng thật. */
async function addDelivery(seed: DeliverySeed = {}): Promise<Id<'delivery'>> {
  const endpoints = new PostgresEndpointStore(pool);
  const endpoint = buildEndpoint(appId, { ...SEED_ENDPOINT });
  await endpoints.insertWithinLimit(endpoint, 1_000);
  if (seed.endpoint === 'deleted') {
    await endpoints.softDelete(appId, endpoint.id, SEED_GONE_AT);
  }
  if (seed.endpoint === 'disabled') {
    await endpoints.disable(appId, endpoint.id, SEED_GONE_AT);
  }
  const eventId = newId('event', SEED_EVENT.createdAt.getTime());
  await pool.query(
    `INSERT INTO events (id, app_id, customer_id, type, payload, created_at, dispatched_at)
     VALUES ($1, $2, 'cus_1', $3, $4::jsonb, $5, $5)`,
    [
      idToUuid(eventId),
      idToUuid(appId),
      SEED_EVENT.type,
      JSON.stringify(SEED_EVENT.payload),
      SEED_EVENT.createdAt,
    ],
  );
  const id = newId('delivery', NOW.getTime());
  const inFlight = seed.status === 'in_flight';
  await pool.query(
    `INSERT INTO deliveries (id, event_id, endpoint_id, status, attempt_count, next_attempt_at,
       lease_until, lease_token, gate_blocked_count, last_error, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
    [
      idToUuid(id),
      idToUuid(eventId),
      idToUuid(endpoint.id),
      seed.status ?? 'pending',
      seed.attemptCount ?? 0,
      seed.nextAttemptAt ?? at(-60_000),
      inFlight ? seed.leaseUntil : null,
      inFlight ? (seed.leaseToken ?? randomUUID()) : null,
      seed.gateBlockedCount ?? 0,
      seed.lastError ?? null,
      NOW,
    ],
  );
  for (let n = 1; n <= (seed.priorAttempts ?? 0); n++) {
    await pool.query(
      `INSERT INTO attempts (id, delivery_id, attempt_number, started_at, duration_ms, http_status)
       VALUES ($1, $2, $3, $4, 10, 500)`,
      [idToUuid(newId('attempt', NOW.getTime())), idToUuid(id), n, NOW],
    );
  }
  return id;
}

/** Đọc lại một delivery thành `DeliveryView`. */
async function readDelivery(id: Id<'delivery'>): Promise<DeliveryView> {
  const { rows } = await pool.query<DeliveryView>(
    `SELECT status, failed_reason AS "failedReason", attempt_count AS "attemptCount",
       next_attempt_at AS "nextAttemptAt", lease_until AS "leaseUntil",
       lease_token AS "leaseToken", last_error AS "lastError",
       gate_blocked_count AS "gateBlockedCount"
     FROM deliveries WHERE id = $1`,
    [idToUuid(id)],
  );
  return rows[0]!;
}

describeDeliveryStoreContract('postgres', async () => {
  await resetDatabase();
  return {
    store: new PostgresDeliveryStore(pool),
    addDelivery,
    readDelivery,
    readAttempts: async (id) => {
      const { rows } = await pool.query(
        `SELECT attempt_number AS "attemptNumber", http_status AS "httpStatus", error,
           response_snippet AS "responseSnippet", duration_ms AS "durationMs"
         FROM attempts WHERE delivery_id = $1 ORDER BY attempt_number`,
        [idToUuid(id)],
      );
      return rows;
    },
    firstFailureAt: async (id) => {
      const { rows } = await pool.query<{ first_failure_at: Date | null }>(
        `SELECT p.first_failure_at FROM deliveries d
         JOIN endpoints p ON p.id = d.endpoint_id WHERE d.id = $1`,
        [idToUuid(id)],
      );
      return rows[0]!.first_failure_at;
    },
  };
});

describe('PostgresDeliveryStore under concurrency', () => {
  const store = () => new PostgresDeliveryStore(pool);
  /** Gọi `claimDue` `count` lần song song, mỗi lần tối đa `limit`. */
  const claimInParallel = (count: number, limit: number, now = NOW) =>
    Promise.all(
      Array.from({ length: count }, () =>
        store().claimDue({ now, leaseUntil: at(LEASE_MS), limit }),
      ),
    );

  beforeEach(resetDatabase);

  it('I1: 20 parallel claims on one due delivery → exactly one wins (WRK-02)', async () => {
    await addDelivery();
    const results = await claimInParallel(CONCURRENT_CLAIMS, 1);
    expect(results.flat()).toHaveLength(1);
  });

  it('I1b: 20 parallel claims on one expired lease → exactly one wins', async () => {
    await addDelivery({ status: 'in_flight', leaseUntil: at(-1_000) });
    const results = await claimInParallel(CONCURRENT_CLAIMS, 1);
    expect(results.flat()).toHaveLength(1);
  });

  it('I1c: a row locked by an in-progress write is skipped, even past its lease', async () => {
    const id = await addDelivery({
      status: 'in_flight',
      leaseUntil: at(-1_000),
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM deliveries WHERE id = $1 FOR UPDATE', [
        idToUuid(id),
      ]);
      expect(
        await store().claimDue({
          now: NOW,
          leaseUntil: at(LEASE_MS),
          limit: 5,
        }),
      ).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('I2: 100 deliveries, 5 parallel claims of 30 → all 100 claimed once (SKIP LOCKED)', async () => {
    for (let i = 0; i < 100; i++) await addDelivery();
    const ids = (await claimInParallel(5, 30)).flat().map((c) => c.id);
    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100);
  });

  it('I4: every write leaves lease_token ⇔ in_flight consistent (schema CHECKs)', async () => {
    // Các CHECK của schema sẽ làm câu lệnh lỗi nếu sai; ca này kiểm thêm trên toàn bảng.
    await addDelivery();
    await addDelivery();
    const [first, second] = await store().claimDue({
      now: NOW,
      leaseUntil: at(LEASE_MS),
      limit: 2,
    });
    await store().failForEndpoint(first!, {
      reason: 'endpoint_disabled',
      now: NOW,
    });
    await store().recordAttempt(second!, {
      attempt: {
        id: newId('attempt', NOW.getTime()),
        startedAt: NOW,
        durationMs: 5,
        httpStatus: null,
        responseSnippet: null,
        error: 'timeout',
      },
      decision: { status: 'pending', nextAttemptAt: at(5_000) },
      lastError: 'timeout',
      now: NOW,
    });
    const { rows } = await pool.query<{ id: string; ok: boolean }>(
      `SELECT id, (status = 'in_flight') = (lease_token IS NOT NULL)
         AND (lease_token IS NULL) = (lease_until IS NULL) AS ok
       FROM deliveries`,
    );
    expect(rows.map((row) => row.ok)).toEqual([true, true]);
    expect(rows.map((row) => idFromUuid('delivery', row.id)).sort()).toEqual(
      [first!.id, second!.id].sort(),
    );
  });
});
