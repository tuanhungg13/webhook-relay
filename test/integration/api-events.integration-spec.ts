import type { Server } from 'node:http';
import request from 'supertest';
import { auth, useEndpointApi } from './endpoint-api-harness.js';

/** Body gửi sự kiện hợp lệ cho `customer`, ghi đè được từng trường. */
function eventBody(customer: string, overrides: Record<string, unknown> = {}) {
  return {
    customer_id: customer,
    type: 'order.created',
    payload: { order_id: 'o1' },
    ...overrides,
  };
}

describe('events API on real Postgres', () => {
  const api = useEndpointApi();

  /** `POST /v1/events` bằng key `key` (mặc định app A) với `body` đã là object. */
  function post(body: unknown, key = api.keyA) {
    return request(api.server())
      .post('/v1/events')
      .set(auth(key))
      .send(body as object);
  }

  /** `POST /v1/events` với body là chuỗi JSON thô, để gửi những thứ `JSON.stringify` không viết ra được. */
  function postRaw(text: string, key = api.keyA) {
    return request(api.server())
      .post('/v1/events')
      .set(auth(key))
      .set('Content-Type', 'application/json')
      .send(text);
  }

  /** Tạo endpoint nhận `eventTypes` cho `customer` bằng key A, trả ID. */
  async function createEndpoint(customer: string, eventTypes: string[]) {
    const response = await request(api.server())
      .post('/v1/endpoints')
      .set(auth(api.keyA))
      .send({
        customer_id: customer,
        url: 'https://shop.example/hook',
        event_types: eventTypes,
      })
      .expect(201);
    return response.body.id as string;
  }

  it('H1: 202 {id, created_at} and exactly one pending delivery per matching endpoint', async () => {
    const ep1 = await createEndpoint('cus_h1', ['order.created']);
    const ep2 = await createEndpoint('cus_h1', ['order.created', 'order.paid']);
    await createEndpoint('cus_h1', ['order.paid']);

    const response = await post(eventBody('cus_h1')).expect(202);
    expect(Object.keys(response.body).sort()).toEqual(['created_at', 'id']);
    expect(response.body.id).toMatch(/^evt_/);
    expect(new Date(response.body.created_at).toISOString()).toBe(
      response.body.created_at,
    );
    expect(response.headers['x-request-id']).toBeTruthy();

    const detail = await request(api.server())
      .get(`/v1/events/${response.body.id}`)
      .set(auth(api.keyA))
      .expect(200);
    expect(detail.body).toMatchObject({
      id: response.body.id,
      customer_id: 'cus_h1',
      type: 'order.created',
      payload: { order_id: 'o1' },
      created_at: response.body.created_at,
    });
    expect(
      detail.body.deliveries
        .map((d: { endpoint_id: string }) => d.endpoint_id)
        .sort(),
    ).toEqual([ep1, ep2].sort());
    for (const delivery of detail.body.deliveries) {
      expect(delivery).toMatchObject({ status: 'pending', attempt_count: 0 });
      expect(delivery.id).toMatch(/^del_/);
    }
  });

  it('H2: same key and content → 200 with the first body; other content → 409 idempotency_conflict', async () => {
    const body = eventBody('cus_h2', { idempotency_key: 'order-1-created' });
    const first = await post(body).expect(202);
    const retry = await post(body).expect(200);
    expect(retry.body).toEqual(first.body);

    const conflict = await post({
      ...body,
      payload: { order_id: 'other' },
    }).expect(409);
    expect(conflict.body.error.code).toBe('idempotency_conflict');
  });

  it('H2b: the same key from another app is independent', async () => {
    const body = eventBody('cus_h2b', { idempotency_key: 'shared-key' });
    await post(body).expect(202);
    await post(body, api.keyB).expect(202);
  });

  it.each([
    ['missing customer_id', { customer_id: undefined }, 'customer_id'],
    ['bad customer_id', { customer_id: 'cus 1/x' }, 'customer_id'],
    ['missing type', { type: undefined }, 'type'],
    ['bad type', { type: 'Order Created' }, 'type'],
    ['missing payload', { payload: undefined }, 'payload'],
    ['array payload', { payload: [1] }, 'payload'],
    ['null payload', { payload: null }, 'payload'],
    ['string payload', { payload: 'text' }, 'payload'],
    ['empty idempotency_key', { idempotency_key: '' }, 'idempotency_key'],
    [
      '256-char idempotency_key',
      { idempotency_key: 'k'.repeat(256) },
      'idempotency_key',
    ],
    [
      'payload nested 33 levels',
      { payload: JSON.parse('{"n":'.repeat(32) + '{}' + '}'.repeat(32)) },
      `payload${'.n'.repeat(32)}`,
    ],
  ])(
    'H3: %s → 422 validation_failed naming the field',
    async (_case, override, field) => {
      const response = await post(eventBody('cus_h3', override)).expect(422);
      expect(response.body.error.code).toBe('validation_failed');
      expect(response.body.error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ field })]),
      );
    },
  );

  it.each([
    ['unsafe integer', '{"order_id":12345678901234567890}', 'payload.order_id'],
    ['1e400', '{"a":[1,1e400]}', 'payload.a[1]'],
    ['NUL in a value', String.raw`{"a":"x\u0000y"}`, 'payload.a'],
    ['NUL in a key', String.raw`{"a\u0000":1}`, 'payload.a\u0000'],
    ['lone surrogate', String.raw`{"a":"\ud800"}`, 'payload.a'],
  ])(
    'H3: payload with %s → 422 pointing at the position, never echoing the value',
    async (_case, payload, field) => {
      const response = await postRaw(
        `{"customer_id":"cus_h3","type":"order.created","payload":${payload}}`,
      ).expect(422);
      expect(response.body.error.details).toEqual([
        expect.objectContaining({ field }),
      ]);
      expect(response.text).not.toContain('12345678901234567890');
    },
  );

  it.each([
    ['NUL', JSON.stringify('k' + String.fromCharCode(0) + 'x')],
    ['lone surrogate', JSON.stringify('k' + String.fromCharCode(0xd800))],
  ])('H3: idempotency_key with %s → 422, not 500', async (_case, key) => {
    const response = await postRaw(
      `{"customer_id":"cus_h3","type":"order.created","payload":{},"idempotency_key":${key}}`,
    ).expect(422);
    expect(response.body.error.details).toEqual([
      expect.objectContaining({ field: 'idempotency_key' }),
    ]);
  });

  it('H4: GET returns the list without payload, newest first, pages without gaps or repeats', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const type = i % 2 === 0 ? 'order.created' : 'order.paid';
      const response = await post(eventBody('cus_h4', { type })).expect(202);
      ids.push(response.body.id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: Record<string, string> = {
        customer_id: 'cus_h4',
        limit: '2',
      };
      if (cursor) query.cursor = cursor;
      const page = await request(api.server())
        .get('/v1/events')
        .query(query)
        .set(auth(api.keyA))
        .expect(200);
      for (const event of page.body.data) {
        expect(event).not.toHaveProperty('payload');
        expect(event).toEqual({
          id: event.id,
          customer_id: 'cus_h4',
          type: expect.any(String),
          created_at: expect.any(String),
        });
        seen.push(event.id);
      }
      cursor = page.body.next_cursor;
    } while (cursor);
    expect(seen).toEqual([...ids].reverse());

    const filtered = await request(api.server())
      .get('/v1/events')
      .query({ customer_id: 'cus_h4', type: 'order.paid' })
      .set(auth(api.keyA))
      .expect(200);
    expect(filtered.body.data.map((e: { id: string }) => e.id)).toEqual([
      ids[3],
      ids[1],
    ]);
    expect(filtered.body.next_cursor).toBeNull();
  });

  it('H4b: listing without customer_id → 422', async () => {
    const response = await request(api.server())
      .get('/v1/events')
      .set(auth(api.keyA))
      .expect(422);
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'customer_id' }),
      ]),
    );
  });

  it('H5: another app, an unknown ID and a malformed ID all give the same 404 bytes', async () => {
    const created = await post(eventBody('cus_h5')).expect(202);
    const get = (id: string, key: string) =>
      request(api.server()).get(`/v1/events/${id}`).set(auth(key));

    const foreign = await get(created.body.id, api.keyB).expect(404);
    const unknown = await get(
      'evt_01h455vb4pex5vsknk084sn02q',
      api.keyB,
    ).expect(404);
    const malformed = await get('not-an-id', api.keyA).expect(404);
    expect(foreign.text).toBe(unknown.text);
    expect(foreign.text).toBe(malformed.text);
  });

  it('H6: a customer without endpoints still gets 202 and no deliveries', async () => {
    const response = await post(eventBody('cus_h6_nobody')).expect(202);
    const detail = await request(api.server())
      .get(`/v1/events/${response.body.id}`)
      .set(auth(api.keyA))
      .expect(200);
    expect(detail.body.deliveries).toEqual([]);
  });

  it('H7: a __proto__ key in the payload is accepted and returned unchanged', async () => {
    const response = await postRaw(
      '{"customer_id":"cus_h7","type":"order.created","payload":{"__proto__":{"x":1},"a":2}}',
    ).expect(202);
    const detail = await request(api.server())
      .get(`/v1/events/${response.body.id}`)
      .set(auth(api.keyA))
      .expect(200);
    expect(Object.keys(detail.body.payload).sort()).toEqual(['__proto__', 'a']);
    expect(detail.text).toContain('"__proto__":{"x":1}');
  });

  it('H8: a cursor from another app is a 422 identical to a broken cursor', async () => {
    const other = await post(eventBody('cus_h8'), api.keyB).expect(202);
    await post(eventBody('cus_h8')).expect(202);
    const cursor = Buffer.from(JSON.stringify({ id: other.body.id })).toString(
      'base64url',
    );

    const list = (cursorValue: string) =>
      request(api.server())
        .get('/v1/events')
        .query({ customer_id: 'cus_h8', cursor: cursorValue })
        .set(auth(api.keyA));
    const foreign = await list(cursor).expect(422);
    const broken = await list('garbage').expect(422);
    expect(foreign.body.error).toEqual(broken.body.error);
  });

  it('H9: 50 parallel requests with the same key → one 202, 49 × 200, no 5xx (ING-03.5)', async () => {
    const body = eventBody('cus_h9', { idempotency_key: 'parallel-key' });
    // Mỗi request của supertest gắn thêm listener vào server; nâng trần để khỏi cảnh báo rò rỉ.
    (api.server() as Server).setMaxListeners(100);
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => post(body)),
    );

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 202)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(49);
    expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
  });

  it('requires an API key', async () => {
    await request(api.server())
      .post('/v1/events')
      .send(eventBody('cus_x'))
      .expect(401);
    await request(api.server())
      .get('/v1/events')
      .query({ customer_id: 'cus_x' })
      .expect(401);
  });
});
