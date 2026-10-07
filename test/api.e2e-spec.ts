import type { INestApplication } from '@nestjs/common';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import request from 'supertest';
import { createPool } from '../src/adapters/postgres/pool.js';
import {
  createApiTestApp,
  memoryLogger,
  TEST_MAX_BODY_BYTES,
} from './support/api-test-app.js';

/** Cổng đóng: kết nối bị từ chối ngay, mô phỏng Postgres chết mà không cần Docker. */
const DEAD_DATABASE_URL = 'postgres://whr:whr@127.0.0.1:1/whr';

describe('api process (e2e, Postgres is down)', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let log: ReturnType<typeof memoryLogger>;

  beforeAll(async () => {
    log = memoryLogger();
    pool = createPool(
      {
        DATABASE_URL: DEAD_DATABASE_URL,
        DB_POOL_SIZE: 2,
        DB_STATEMENT_TIMEOUT: 5_000,
        DB_IDLE_TX_TIMEOUT: 30_000,
      },
      log.logger,
    );
    app = await createApiTestApp(pool, log.logger);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const server = () => app.getHttpServer() as Parameters<typeof request>[0];

  it('E1: /healthz returns 200 with an x-request-id', async () => {
    const response = await request(server()).get('/healthz').expect(200, {
      status: 'ok',
    });
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('E2: /readyz returns 503 when the database is down, within 6s', async () => {
    const started = Date.now();
    const response = await request(server()).get('/readyz').expect(503);
    expect(response.body.error.code).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(6_000);
  });

  it('E3: keeps a valid X-Request-Id and replaces a 129-char one', async () => {
    const kept = await request(server())
      .get('/healthz')
      .set('X-Request-Id', 'abc');
    expect(kept.headers['x-request-id']).toBe('abc');
    const long = 'a'.repeat(129);
    const replaced = await request(server())
      .get('/healthz')
      .set('X-Request-Id', long);
    expect(replaced.headers['x-request-id']).not.toBe(long);
  });

  it('E4: a protected route without Authorization returns 401', async () => {
    const response = await request(server()).get('/v1/whoami').expect(401);
    expect(response.body.error.code).toBe('unauthorized');
  });

  it('E5: a Bearer key while the database is down returns 503 and logs request_id', async () => {
    const response = await request(server())
      .get('/v1/whoami')
      .set('Authorization', 'Bearer sk_whatever')
      .expect(503);
    expect(response.body.error.code).toBe('unavailable');
    const entry = log
      .lines()
      .find((line) => line.level === 50 && line.request_id !== undefined);
    expect(entry?.request_id).toBe(response.headers['x-request-id']);
  });

  it('E6: a body of exactly MAX_BODY_BYTES is accepted, one byte more gets 413', async () => {
    // `"` + n × a + `"` là JSON hợp lệ dài n + 2 byte.
    const exact = JSON.stringify('a'.repeat(TEST_MAX_BODY_BYTES - 2));
    await request(server())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send(exact)
      .expect(201);
    const response = await request(server())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify('a'.repeat(TEST_MAX_BODY_BYTES - 1)))
      .expect(413);
    expect(response.body.error.code).toBe('payload_too_large');
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  describe('raw sockets (supertest always sends the full body)', () => {
    let port: number;

    beforeAll(async () => {
      await app.listen(0, '127.0.0.1');
      port = (app.getHttpServer().address() as AddressInfo).port;
    });

    /** Gửi `head` rồi `body` xuống socket thô, trả về phản hồi nhận được và thời gian chờ. */
    function sendRaw(
      head: string,
      body: string,
    ): Promise<{ text: string; ms: number; closed: boolean }> {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const socket = net.connect(port, '127.0.0.1');
        let text = '';
        socket.on('data', (chunk) => {
          text += chunk.toString('latin1');
        });
        socket.on('error', () => undefined);
        socket.on('close', () => {
          resolve({ text, ms: Date.now() - started, closed: true });
        });
        socket.on('connect', () => socket.write(head + body));
        setTimeout(() => {
          socket.destroy();
          reject(new Error(`no response within 1s; got: ${text}`));
        }, 1_000);
      });
    }

    it('E7: declared Content-Length of 10 MB but only 2 KB sent → 413, connection closed', async () => {
      const head =
        'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 10485760\r\n\r\n';
      const { text, ms } = await sendRaw(head, 'a'.repeat(2048));
      expect(text).toContain('413');
      expect(ms).toBeLessThan(1_000);
    });

    it('E8: chunked body over the limit that never ends → 413', async () => {
      const chunk = 'a'.repeat(TEST_MAX_BODY_BYTES + 100);
      const head =
        'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n';
      const { text } = await sendRaw(
        head,
        `${chunk.length.toString(16)}\r\n${chunk}\r\n`,
      );
      expect(text).toContain('413');
    });
  });

  it('E9: malformed JSON → 400 invalid_json; empty body → undefined', async () => {
    const bad = await request(server())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{nope')
      .expect(400);
    expect(bad.body.error.code).toBe('invalid_json');
    await request(server()).post('/echo').expect(201, { received: null });
  });

  it('E10: an unknown path returns the 404 envelope', async () => {
    const response = await request(server()).get('/nope').expect(404);
    expect(response.body.error.code).toBe('not_found');
  });

  it('E11: an unexpected error returns 500 internal without leaking details', async () => {
    const response = await request(server()).get('/boom').expect(500);
    expect(response.body.error.code).toBe('internal');
    expect(JSON.stringify(response.body)).not.toMatch(/secret detail|\bat \w/);
  });
});
