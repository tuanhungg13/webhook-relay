import { newId } from '../../../core/id.js';
import { InMemoryEndpointStore } from '../../../../test/fakes/in-memory-endpoint-store.js';
import { CreateEndpoint } from './create-endpoint.use-case.js';
import { UpdateEndpoint } from './update-endpoint.use-case.js';

describe('UpdateEndpoint', () => {
  const created = new Date('2026-10-07T10:00:00Z');
  const later = new Date('2026-10-07T11:00:00Z');
  const appId = newId('app', created.getTime());
  const options = { allowInsecureHttp: false };

  /** Tạo sẵn một endpoint lúc `created`; use case sửa chạy với đồng hồ đứng ở `later`. */
  async function setup() {
    const store = new InMemoryEndpointStore();
    const result = await new CreateEndpoint(
      store,
      { now: () => created },
      { allowInsecureHttp: false, maxPerCustomer: 20 },
    ).execute({
      appId,
      customerId: 'cus_1',
      url: 'https://shop.example/hook',
      eventTypes: ['order.created'],
    });
    if (result.status !== 'created') throw new Error(result.status);
    const useCase = new UpdateEndpoint(store, { now: () => later }, options);
    return { useCase, endpoint: result.endpoint };
  }

  it('changes only the given fields, dedupes event types and stamps updatedAt', async () => {
    const { useCase, endpoint } = await setup();
    const result = await useCase.execute({
      appId,
      id: endpoint.id,
      patch: { eventTypes: ['a.b', 'a.b', 'c.d'], rateLimitRps: 9 },
    });
    expect(result).toEqual({
      status: 'updated',
      endpoint: {
        ...endpoint,
        eventTypes: ['a.b', 'c.d'],
        rateLimitRps: 9,
        updatedAt: later,
      },
    });
  });

  it('rejects a new URL that breaks the static rules', async () => {
    const { useCase, endpoint } = await setup();
    expect(
      await useCase.execute({
        appId,
        id: endpoint.id,
        patch: { url: 'https://a.com:25/h' },
      }),
    ).toEqual({
      status: 'invalid_url',
      message: 'port must be 443 or at least 1024',
    });
  });

  it('returns not_found for an endpoint of another app', async () => {
    const { useCase, endpoint } = await setup();
    expect(
      await useCase.execute({
        appId: newId('app', later.getTime()),
        id: endpoint.id,
        patch: { maxConcurrency: 1 },
      }),
    ).toEqual({ status: 'not_found' });
  });
});
