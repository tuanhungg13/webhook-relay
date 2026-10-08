import request from 'supertest';
import { TEST_ENDPOINTS_CONFIG } from '../support/api-test-app.js';
import {
  auth,
  expectNoSecretsLogged,
  useEndpointApi,
} from './endpoint-api-harness.js';

describe('endpoint API on real Postgres: lifecycle, listing, update', () => {
  const api = useEndpointApi();

  it('H5: delete → 204, then every route 404s and the slot is free again', async () => {
    const ids = [];
    for (let i = 0; i < TEST_ENDPOINTS_CONFIG.maxPerCustomer; i++) {
      ids.push((await api.create('cus_h5')).id);
    }
    const [deleted] = ids;
    await request(api.server())
      .delete(`/v1/endpoints/${deleted}`)
      .set(auth(api.keyA))
      .expect(204);

    await request(api.server())
      .get(`/v1/endpoints/${deleted}`)
      .set(auth(api.keyA))
      .expect(404);
    await request(api.server())
      .patch(`/v1/endpoints/${deleted}`)
      .set(auth(api.keyA))
      .send({ rate_limit_rps: 5 })
      .expect(404);
    for (const action of ['disable', 'enable', 'rotate-secret']) {
      await request(api.server())
        .post(`/v1/endpoints/${deleted}/${action}`)
        .set(auth(api.keyA))
        .expect(404);
    }
    await request(api.server())
      .delete(`/v1/endpoints/${deleted}`)
      .set(auth(api.keyA))
      .expect(404);
    await api.create('cus_h5');
  });

  it('H6: disable/enable → 204 and GET shows the status', async () => {
    const { id } = await api.create('cus_h6');
    const status = async () =>
      (
        await request(api.server())
          .get(`/v1/endpoints/${id}`)
          .set(auth(api.keyA))
      ).body;

    await request(api.server())
      .post(`/v1/endpoints/${id}/disable`)
      .set(auth(api.keyA))
      .expect(204, '');
    await request(api.server())
      .post(`/v1/endpoints/${id}/disable`)
      .set(auth(api.keyA))
      .expect(204);
    expect(await status()).toMatchObject({
      status: 'disabled',
      disabled_reason: 'manual',
    });

    await request(api.server())
      .post(`/v1/endpoints/${id}/enable`)
      .set(auth(api.keyA))
      .expect(204);
    await request(api.server())
      .post(`/v1/endpoints/${id}/enable`)
      .set(auth(api.keyA))
      .expect(204);
    expect(await status()).toMatchObject({
      status: 'active',
      disabled_reason: null,
    });
  });

  it('H7: rotate-secret → 200 with a new secret; GET leaks neither secret', async () => {
    const created = await api.create('cus_h7');
    const rotated = await request(api.server())
      .post(`/v1/endpoints/${created.id}/rotate-secret`)
      .set(auth(api.keyA))
      .expect(200);
    api.secretsSeen.push(rotated.body.secret);
    expect(rotated.body.id).toBe(created.id);
    expect(rotated.body.secret).toMatch(/^whsec_/);
    expect(rotated.body.secret).not.toBe(created.secret);
    expect(rotated.body).not.toHaveProperty('previous_secret');

    const fetched = await request(api.server())
      .get(`/v1/endpoints/${created.id}`)
      .set(auth(api.keyA))
      .expect(200);
    expect(fetched.text).not.toContain(created.secret);
    expect(fetched.text).not.toContain(rotated.body.secret);
  });

  it('H8: limit=2 walks 5 endpoints in 3 pages, newest first, no gaps or duplicates', async () => {
    const created = [];
    for (let i = 0; i < 5; i++) created.push((await api.create('cus_h8')).id);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response: request.Response = await request(api.server())
        .get('/v1/endpoints')
        .query({
          customer_id: 'cus_h8',
          limit: 2,
          ...(cursor ? { cursor } : {}),
        })
        .set(auth(api.keyA))
        .expect(200);
      seen.push(...response.body.data.map((e: { id: string }) => e.id));
      cursor = response.body.next_cursor;
      pages++;
    } while (cursor !== null);

    expect(pages).toBe(3);
    expect(seen).toEqual([...created].sort().reverse());
  });

  it('H8: list without customer_id sees only this app; a broken cursor → 422', async () => {
    const own = await api.create('cus_h8b');
    const foreign = await api.create('cus_h8b', api.keyB);
    const response = await request(api.server())
      .get('/v1/endpoints')
      .query({ limit: 100 })
      .set(auth(api.keyA))
      .expect(200);
    const ids = response.body.data.map((e: { id: string }) => e.id);
    expect(ids).toContain(own.id);
    expect(ids).not.toContain(foreign.id);
    expect(response.text).not.toContain('whsec_');

    for (const query of [{ cursor: 'garbage' }, { limit: 0 }, { limit: 101 }]) {
      const bad = await request(api.server())
        .get('/v1/endpoints')
        .query(query)
        .set(auth(api.keyA))
        .expect(422);
      expect(bad.body.error.code).toBe('validation_failed');
    }
  });

  it('H9: PATCH rejects unknown fields, empty bodies and bad URLs; applies a valid one', async () => {
    const { id } = await api.create('cus_h9');
    const patch = (body: object) =>
      request(api.server())
        .patch(`/v1/endpoints/${id}`)
        .set(auth(api.keyA))
        .send(body);

    for (const body of [
      { customer_id: 'cus_other' },
      { secret: 'whsec_mine' },
      {},
      { url: null },
      { url: 'https://shop.example:22/h' },
      { url: 'https://10.0.0.5/h' },
    ]) {
      const response = await patch(body).expect(422);
      expect(response.body.error.code).toBe('validation_failed');
    }

    const response = await patch({
      url: 'https://new.example/hook',
      event_types: ['a.b', 'a.b', 'c.d'],
    }).expect(200);
    expect(response.body).toMatchObject({
      customer_id: 'cus_h9',
      url: 'https://new.example/hook',
      event_types: ['a.b', 'c.d'],
      rate_limit_rps: 50,
    });
    expect(response.body).not.toHaveProperty('secret');
  });
  it('H11: logs never contain a webhook secret (SEC-13)', () => {
    expectNoSecretsLogged(api);
  });
});
