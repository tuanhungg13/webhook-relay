import request from 'supertest';
import { newId } from '../../src/core/id.js';
import { TEST_ENDPOINTS_CONFIG } from '../support/api-test-app.js';
import {
  auth,
  expectNoSecretsLogged,
  useEndpointApi,
  validBody,
} from './endpoint-api-harness.js';

describe('endpoint API on real Postgres: create, validation, isolation', () => {
  const api = useEndpointApi();

  it('H1: create returns 201 with a secret; GET returns it without the secret', async () => {
    const response = await request(api.server())
      .post('/v1/endpoints')
      .set(auth(api.keyA))
      .send(validBody('cus_h1'))
      .expect(201);
    const created = response.body;
    api.secretsSeen.push(created.secret);
    expect(created).toMatchObject({
      customer_id: 'cus_h1',
      url: 'https://shop.example/hook',
      event_types: ['order.created'],
      rate_limit_rps: 50,
      max_concurrency: 10,
      status: 'active',
      disabled_reason: null,
    });
    expect(created.id).toMatch(/^ep_/);
    expect(created.secret).toMatch(/^whsec_/);
    expect(response.headers['x-request-id']).toBeTruthy();

    const fetched = await request(api.server())
      .get(`/v1/endpoints/${created.id}`)
      .set(auth(api.keyA))
      .expect(200);
    const { secret: _secret, ...withoutSecret } = created;
    expect(fetched.body).toEqual(withoutSecret);
    expect(fetched.text).not.toContain('whsec_');
  });

  it('H2: the 21st endpoint of a customer gets 422 limit_exceeded with the limit', async () => {
    for (let i = 0; i < TEST_ENDPOINTS_CONFIG.maxPerCustomer; i++) {
      await api.create('cus_h2');
    }
    const response = await request(api.server())
      .post('/v1/endpoints')
      .set(auth(api.keyA))
      .send(validBody('cus_h2'))
      .expect(422);
    expect(response.body.error).toMatchObject({
      code: 'limit_exceeded',
      details: { limit: 20 },
    });
  });

  it.each([
    ['http URL', { url: 'http://shop.example/hook' }, 'url'],
    ['port 25', { url: 'https://shop.example:25/hook' }, 'url'],
    ['loopback IP (SSRF)', { url: 'https://127.0.0.1/h' }, 'url'],
    ['metadata IP (SSRF)', { url: 'https://169.254.169.254/h' }, 'url'],
    ['credentials', { url: 'https://user:hunter2@shop.example/h' }, 'url'],
    ['empty event_types', { event_types: [] }, 'event_types'],
    ['51 event_types', { event_types: Array(51).fill('a.b') }, 'event_types'],
    ['bad event type', { event_types: ['Order Created'] }, 'event_types.0'],
    ['rate_limit_rps 0', { rate_limit_rps: 0 }, 'rate_limit_rps'],
    ['rate_limit_rps 1001', { rate_limit_rps: 1001 }, 'rate_limit_rps'],
    ['max_concurrency 1.5', { max_concurrency: 1.5 }, 'max_concurrency'],
    ['bad customer_id', { customer_id: 'cus 1/x' }, 'customer_id'],
  ])(
    'H3: %s → 422 validation_failed naming the field',
    async (_case, override, field) => {
      const response = await request(api.server())
        .post('/v1/endpoints')
        .set(auth(api.keyA))
        .send({ ...validBody('cus_h3'), ...override })
        .expect(422);
      expect(response.body.error.code).toBe('validation_failed');
      expect(response.body.error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ field })]),
      );
      expect(response.text).not.toContain('hunter2');
    },
  );

  it('H3: a missing body → 422 validation_failed', async () => {
    const response = await request(api.server())
      .post('/v1/endpoints')
      .set(auth(api.keyA))
      .expect(422);
    expect(response.body.error.code).toBe('validation_failed');
  });

  it.each([
    ['get', '', 'get'],
    ['patch', '', 'patch'],
    ['delete', '', 'delete'],
    ['disable', '/disable', 'post'],
    ['enable', '/enable', 'post'],
    ['rotate-secret', '/rotate-secret', 'post'],
  ] as const)(
    'H4/H10: %s on another app’s endpoint, an unknown id and a malformed id → byte-identical 404',
    async (_case, suffix, method) => {
      const { id } = await api.create('cus_h4');
      const send = async (target: string) => {
        const call = request(api.server())
          [method](`/v1/endpoints/${target}${suffix}`)
          .set(auth(api.keyB));
        const response = await (method === 'patch'
          ? call.send({ rate_limit_rps: 5 })
          : call);
        expect(response.status).toBe(404);
        return response.text;
      };
      const foreign = await send(id);
      expect(await send(newId('endpoint', Date.now()))).toBe(foreign);
      expect(await send('abc')).toBe(foreign);
      expect(JSON.parse(foreign).error.code).toBe('not_found');
      // App A vẫn thấy endpoint của mình, không bị app B sửa hay xóa.
      const own = await request(api.server())
        .get(`/v1/endpoints/${id}`)
        .set(auth(api.keyA))
        .expect(200);
      expect(own.body).toMatchObject({ status: 'active', rate_limit_rps: 50 });
    },
  );
  it('H11: logs never contain a webhook secret (SEC-13)', () => {
    expectNoSecretsLogged(api);
  });
});
