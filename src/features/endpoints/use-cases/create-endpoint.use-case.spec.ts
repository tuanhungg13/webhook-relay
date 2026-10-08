import { newId } from '../../../core/id.js';
import { InMemoryEndpointStore } from '../../../../test/fakes/in-memory-endpoint-store.js';
import { FakeHostResolver } from '../../../../test/fakes/fake-host-resolver.js';
import { CreateEndpoint } from './create-endpoint.use-case.js';

describe('CreateEndpoint', () => {
  const now = new Date('2026-10-07T10:00:00Z');
  const clock = { now: () => now };
  const appId = newId('app', now.getTime());
  const input = {
    appId,
    customerId: 'cus_1',
    url: 'https://shop.example/hook',
    eventTypes: ['order.created'],
  };

  /** Store rỗng và use case với giới hạn 2 endpoint mỗi customer (mặc định chỉ https). */
  function setup(options = { allowInsecureHttp: false, maxPerCustomer: 2 }) {
    const store = new InMemoryEndpointStore();
    const resolver = new FakeHostResolver();
    const useCase = new CreateEndpoint(store, clock, options, {
      resolver,
      allowlist: [],
    });
    return { store, resolver, useCase };
  }

  it('creates an active endpoint with a secret and default limits', async () => {
    const { store, useCase } = setup();
    const result = await useCase.execute(input);

    if (result.status !== 'created') throw new Error(result.status);
    expect(result.endpoint).toMatchObject({
      appId,
      customerId: 'cus_1',
      url: 'https://shop.example/hook',
      eventTypes: ['order.created'],
      rateLimitRps: 50,
      maxConcurrency: 10,
      previousSecret: null,
      disabledAt: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(result.endpoint.id).toMatch(/^ep_/);
    expect(result.endpoint.secret).toMatch(/^whsec_/);
    expect(await store.findById(appId, result.endpoint.id)).toEqual(
      result.endpoint,
    );
  });

  it('keeps explicit limits and removes duplicate event types in order', async () => {
    const { useCase } = setup();
    const result = await useCase.execute({
      ...input,
      eventTypes: ['b.x', 'a.y', 'b.x'],
      rateLimitRps: 5,
      maxConcurrency: 1,
    });
    expect(result).toMatchObject({
      status: 'created',
      endpoint: {
        eventTypes: ['b.x', 'a.y'],
        rateLimitRps: 5,
        maxConcurrency: 1,
      },
    });
  });

  it('rejects a URL that breaks the static rules, writing nothing', async () => {
    const { store, useCase } = setup();
    expect(
      await useCase.execute({ ...input, url: 'http://shop.example/hook' }),
    ).toEqual({ status: 'invalid_url', message: 'must use https' });
    expect(await store.list(appId, { limit: 10 })).toEqual([]);
  });

  it.each([
    'https://127.0.0.1/h',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::ffff:7f00:1]/h',
  ])(
    'rejects the internal IP literal %s, writing nothing (SEC-01)',
    async (url) => {
      const { store, resolver, useCase } = setup();
      const result = await useCase.execute({ ...input, url });
      expect(result.status).toBe('invalid_url');
      expect(resolver.calls).toEqual([]);
      expect(await store.list(appId, { limit: 10 })).toEqual([]);
    },
  );

  it('rejects a name that resolves to an internal IP, even beside a public one', async () => {
    const { store, resolver, useCase } = setup();
    resolver.answer(['93.184.216.34', '10.0.0.5']);
    expect(await useCase.execute(input)).toEqual({
      status: 'invalid_url',
      message: 'host must not resolve to a private or reserved address',
    });
    expect(await store.list(appId, { limit: 10 })).toEqual([]);
  });

  it('rejects with a clear message when DNS fails', async () => {
    const { resolver, useCase } = setup();
    resolver.answer(new Error('timeout'));
    expect(await useCase.execute(input)).toEqual({
      status: 'invalid_url',
      message: 'host could not be resolved',
    });
  });

  it('accepts http when insecure HTTP is allowed', async () => {
    const { useCase } = setup({ allowInsecureHttp: true, maxPerCustomer: 2 });
    const result = await useCase.execute({ ...input, url: 'http://a.test/h' });
    expect(result.status).toBe('created');
  });

  it('returns limit_exceeded with the limit once the customer is full (API-30)', async () => {
    const { useCase } = setup();
    await useCase.execute(input);
    await useCase.execute(input);
    expect(await useCase.execute(input)).toEqual({
      status: 'limit_exceeded',
      limit: 2,
    });
  });
});
