import { newId } from '../../../core/id.js';
import { InMemoryEndpointStore } from '../../../../test/fakes/in-memory-endpoint-store.js';
import { CreateEndpoint } from './create-endpoint.use-case.js';
import { RotateEndpointSecret } from './rotate-endpoint-secret.use-case.js';

describe('RotateEndpointSecret', () => {
  const created = new Date('2026-10-07T10:00:00Z');
  const appId = newId('app', created.getTime());
  const graceMs = 86_400_000;

  /** Tạo sẵn một endpoint; `setNow` đổi giờ mà use case xoay secret nhìn thấy. */
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
    let now = created;
    const useCase = new RotateEndpointSecret(
      store,
      { now: () => now },
      { rotationGraceMs: graceMs },
    );
    const setNow = (value: Date) => {
      now = value;
    };
    return { useCase, endpoint: result.endpoint, setNow };
  }

  it('makes the old secret previous, valid for the grace period (API-35, SEC-22)', async () => {
    const { useCase, endpoint, setNow } = await setup();
    const at = new Date('2026-10-07T12:00:00Z');
    setNow(at);

    const result = await useCase.execute({ appId, id: endpoint.id });

    if (result.status !== 'rotated') throw new Error(result.status);
    expect(result.endpoint.secret).toMatch(/^whsec_/);
    expect(result.endpoint.secret).not.toBe(endpoint.secret);
    expect(result.endpoint.previousSecret).toBe(endpoint.secret);
    expect(result.endpoint.previousSecretExpiresAt).toEqual(
      new Date(at.getTime() + graceMs),
    );
    expect(result.endpoint.updatedAt).toEqual(at);
  });

  it('rotating twice keeps only the most recent previous secret', async () => {
    const { useCase, endpoint } = await setup();
    const first = await useCase.execute({ appId, id: endpoint.id });
    const second = await useCase.execute({ appId, id: endpoint.id });
    if (first.status !== 'rotated' || second.status !== 'rotated')
      throw new Error('not rotated');
    expect(second.endpoint.previousSecret).toBe(first.endpoint.secret);
  });

  it('returns not_found for an unknown endpoint', async () => {
    const { useCase } = await setup();
    expect(
      await useCase.execute({
        appId,
        id: newId('endpoint', created.getTime()),
      }),
    ).toEqual({ status: 'not_found' });
  });
});
