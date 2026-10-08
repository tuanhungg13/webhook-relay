import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { DnsHostResolver } from '../../src/adapters/http-sender/dns-host-resolver.js';
import { SafeHttpSender } from '../../src/adapters/http-sender/safe-http-sender.js';
import { PostgresAccessStore } from '../../src/adapters/postgres/access-store.js';
import { PostgresDeliveryStore } from '../../src/adapters/postgres/delivery-store.js';
import { PostgresEndpointStore } from '../../src/adapters/postgres/endpoint-store.js';
import { PostgresEventStore } from '../../src/adapters/postgres/event-store.js';
import { runMigrations } from '../../src/adapters/postgres/migrator.js';
import { DeliveryLoop } from '../../src/apps/worker/delivery-loop.js';
import { type Id, idToUuid } from '../../src/core/id.js';
import { parseCidrList } from '../../src/core/ip-policy.js';
import { generateWebhookSecret } from '../../src/core/webhook-secret.js';
import { signWebhook } from '../../src/core/webhook-signature.js';
import { CreateApp } from '../../src/features/access/use-cases/create-app.use-case.js';
import { Deliver } from '../../src/features/delivery/use-cases/deliver.use-case.js';
import { systemClock } from '../../src/platform/clock.js';
import { createLogger } from '../../src/platform/logger.js';
import { buildEndpoint } from '../contract/endpoint-store.contract.js';
import { buildEvent } from '../contract/event-store.contract.js';
import { createTestDatabase } from './postgres-test-db.js';

/** Một request server cục bộ đã nhận. */
interface Received {
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** Logger im lặng dùng chung cho migration và worker trong test. */
const logger = createLogger({ mode: 'test', level: 'silent' });
/** Secret của mọi endpoint trong file này, để kiểm lại chữ ký. */
const SECRET = generateWebhookSecret();

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let pool: pg.Pool;
/** Việc dọn dẹp (dừng worker, đóng server) chạy ngược thứ tự sau mỗi ca. */
const cleanups: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 10 });
  await runMigrations(pool, logger);
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await pool.query('TRUNCATE apps CASCADE');
});

/** Server HTTP cục bộ; `respond(n)` trả lời request thứ n (từ 0). */
async function serve(respond: (n: number, res: http.ServerResponse) => void) {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks) });
      respond(received.length - 1, res);
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  cleanups.push(
    () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  );
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`,
    received,
  };
}

/** Tạo app + endpoint trỏ `url`, rồi nhận một sự kiện qua `ingest` thật; trả ID delivery. */
async function ingestFor(url: string) {
  const { appId } = await new CreateApp(
    new PostgresAccessStore(pool),
    systemClock,
  ).execute({ name: 'ShopX' });
  const endpoint = buildEndpoint(appId, { url, secret: SECRET });
  await new PostgresEndpointStore(pool).insertWithinLimit(endpoint, 100);
  const event = buildEvent(appId, { createdAt: new Date() });
  await new PostgresEventStore(pool).ingest({ event, idempotency: null });
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM deliveries WHERE event_id = $1',
    [idToUuid(event.id)],
  );
  return {
    appId,
    endpointId: endpoint.id,
    eventId: event.id,
    deliveryUuid: rows[0]!.id,
  };
}

/** Chạy worker thật trong tiến trình test: allowlist loopback, cho phép http (dev). */
function startWorker(retryDelaysMs: number[]) {
  const store = new PostgresDeliveryStore(pool);
  const sender = new SafeHttpSender({
    resolver: new DnsHostResolver(),
    allowlist: parseCidrList('127.0.0.0/8'),
    allowInsecureHttp: true,
  });
  const loop = new DeliveryLoop(
    {
      store,
      deliver: new Deliver(store, sender, systemClock, {
        userAgent: 'WebhookRelay/test',
        retryDelaysMs,
        logger,
      }),
      clock: systemClock,
      logger,
    },
    { concurrency: 10, idleSleepMs: 10, leaseMs: 30_000 },
  );
  loop.start();
  cleanups.push(async () => {
    await loop.stop();
    sender.close();
  });
}

/** Trạng thái delivery + endpoint + các attempt hiện tại. */
async function snapshot(deliveryUuid: string) {
  const { rows } = await pool.query<{
    status: string;
    failed_reason: string | null;
    first_failure_at: Date | null;
  }>(
    `SELECT d.status, d.failed_reason, p.first_failure_at
     FROM deliveries d JOIN endpoints p ON p.id = d.endpoint_id WHERE d.id = $1`,
    [deliveryUuid],
  );
  const attempts = await pool.query<{
    http_status: number | null;
    error: string | null;
    response_snippet: string | null;
  }>(
    `SELECT http_status, error, response_snippet FROM attempts
     WHERE delivery_id = $1 ORDER BY attempt_number`,
    [deliveryUuid],
  );
  return { ...rows[0]!, attempts: attempts.rows };
}

/** Chờ tới khi trạng thái thỏa `check` (tối đa 10 giây) rồi trả ảnh chụp đó. */
async function waitFor(
  deliveryUuid: string,
  check: (state: Awaited<ReturnType<typeof snapshot>>) => boolean,
) {
  for (let i = 0; i < 500; i++) {
    const state = await snapshot(deliveryUuid);
    if (check(state)) return state;
    await sleep(20);
  }
  throw new Error(
    `delivery never reached the expected state: ${JSON.stringify(await snapshot(deliveryUuid))}`,
  );
}

/** Chờ tới khi delivery đạt trạng thái `status`. */
const waitForStatus = (deliveryUuid: string, status: string) =>
  waitFor(deliveryUuid, (state) => state.status === status);

describe('worker end to end (in process)', () => {
  it('I5: delivers a signed webhook once and marks it succeeded', async () => {
    const server = await serve((_n, res) => res.end('ok'));
    const { eventId, deliveryUuid } = await ingestFor(server.url);
    startWorker([1_000]);

    const state = await waitForStatus(deliveryUuid, 'succeeded');

    expect(server.received).toHaveLength(1);
    const { headers, body } = server.received[0]!;
    expect(headers['user-agent']).toBe('WebhookRelay/test');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['webhook-id']).toBe(eventId);
    const expected = signWebhook({
      webhookId: eventId,
      sentAt: new Date(Number(headers['webhook-timestamp']) * 1000),
      body,
      secrets: [SECRET],
    });
    expect(headers['webhook-signature']).toBe(expected['webhook-signature']);
    expect(state.attempts).toEqual([
      { http_status: 200, error: null, response_snippet: 'ok' },
    ]);
  });

  it('I6: retries after a 500, then succeeds; first_failure_at set then cleared (KB2)', async () => {
    const server = await serve((n, res) => {
      res.statusCode = n === 0 ? 500 : 200;
      res.end();
    });
    const { deliveryUuid } = await ingestFor(server.url);
    // Delay phải trên 1s: câu giành quyền cho sớm 1 giây (lệch đồng hồ), delay ngắn hơn bị lấy ngay.
    startWorker([1_500]);

    const afterFailure = await waitFor(
      deliveryUuid,
      (state) => state.status === 'pending' && state.attempts.length === 1,
    );
    const done = await waitForStatus(deliveryUuid, 'succeeded');

    expect(afterFailure.first_failure_at).not.toBeNull();
    expect(done.attempts.map((a) => a.http_status)).toEqual([500, 200]);
    expect(done.first_failure_at).toBeNull();
  });

  it('I7: gives up as exhausted after MAX_ATTEMPTS (KB3)', async () => {
    const server = await serve((_n, res) => {
      res.statusCode = 500;
      res.end();
    });
    const { deliveryUuid } = await ingestFor(server.url);
    startWorker([10, 10]);

    const state = await waitForStatus(deliveryUuid, 'failed');

    expect(state.failed_reason).toBe('exhausted');
    expect(state.attempts).toHaveLength(3);
    expect(server.received).toHaveLength(3);
  });

  it('I8: reclaims a delivery left in_flight by a dead worker (KB5, WRK-01)', async () => {
    const server = await serve((_n, res) => res.end());
    const { deliveryUuid } = await ingestFor(server.url);
    await pool.query(
      `UPDATE deliveries SET status = 'in_flight', lease_token = $2,
         lease_until = now() - interval '1 second'
       WHERE id = $1`,
      [deliveryUuid, randomUUID()],
    );
    startWorker([1_000]);

    await waitForStatus(deliveryUuid, 'succeeded');
    expect(server.received).toHaveLength(1);
  });

  it('I9: fails a delivery whose endpoint was deleted, without sending (KB4)', async () => {
    const server = await serve((_n, res) => res.end());
    const { appId, endpointId, deliveryUuid } = await ingestFor(server.url);
    await new PostgresEndpointStore(pool).softDelete(
      appId,
      endpointId as Id<'endpoint'>,
      new Date(),
    );
    startWorker([1_000]);

    const state = await waitForStatus(deliveryUuid, 'failed');

    expect(state.failed_reason).toBe('endpoint_deleted');
    expect(state.attempts).toEqual([]);
    expect(server.received).toHaveLength(0);
  });

  it('I10: records a NUL-byte body and a 999 status instead of looping (fact #12)', async () => {
    const server = await serve((n, res) => {
      res.statusCode = n === 0 ? 500 : 999;
      res.end('bad\0body');
    });
    const { deliveryUuid } = await ingestFor(server.url);
    startWorker([10]);

    const state = await waitForStatus(deliveryUuid, 'failed');

    expect(state.failed_reason).toBe('exhausted');
    expect(state.attempts).toEqual([
      { http_status: 500, error: null, response_snippet: 'badbody' },
      { http_status: null, error: 'connection_error', response_snippet: null },
    ]);
  });
});
