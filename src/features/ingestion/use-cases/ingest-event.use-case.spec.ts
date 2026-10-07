import { newId } from '../../../core/id.js';
import { InMemoryEventStore } from '../../../../test/fakes/in-memory-event-store.js';
import { IngestEvent } from './ingest-event.use-case.js';
import { ListEvents } from './list-events.use-case.js';

describe('IngestEvent', () => {
  const HOUR_MS = 3_600_000;
  const TTL_MS = 24 * HOUR_MS;
  const appId = newId('app', Date.now());
  const input = {
    appId,
    customerId: 'cus_1',
    type: 'order.created',
    payload: { order_id: 'o1' },
    idempotencyKey: 'k1',
  };

  /** Use case với đồng hồ chỉnh tay được (`clock.at`) trên store giả rỗng. */
  function setup() {
    const store = new InMemoryEventStore();
    const clock = { current: new Date('2026-10-07T10:00:00Z') };
    const useCase = new IngestEvent(
      store,
      { now: () => clock.current },
      { idempotencyTtlMs: TTL_MS },
    );
    const advance = (ms: number) => {
      clock.current = new Date(clock.current.getTime() + ms);
    };
    return { store, useCase, advance, clock };
  }

  it('creates an event with an evt_ ID and the clock time', async () => {
    const { useCase, clock, store } = setup();
    const result = await useCase.execute(input);

    if (result.status !== 'created') throw new Error(result.status);
    expect(result.id).toMatch(/^evt_/);
    expect(result.createdAt).toEqual(clock.current);
    expect((await store.findById(appId, result.id))?.payload).toEqual(
      input.payload,
    );
  });

  it('returns the first event for a retry with the same key and content', async () => {
    const { useCase, advance } = setup();
    const first = await useCase.execute(input);
    advance(5_000);
    const retry = await useCase.execute({
      ...input,
      payload: JSON.parse('{"order_id":"o1"}'),
    });

    if (first.status !== 'created') throw new Error(first.status);
    expect(retry).toEqual({
      status: 'duplicate',
      id: first.id,
      createdAt: first.createdAt,
    });
  });

  it('reports a conflict when the key is reused with another payload or type', async () => {
    const { useCase } = setup();
    await useCase.execute(input);

    expect(
      await useCase.execute({ ...input, payload: { order_id: 'o2' } }),
    ).toEqual({ status: 'conflict' });
    expect(await useCase.execute({ ...input, type: 'order.paid' })).toEqual({
      status: 'conflict',
    });
  });

  it('treats a key older than the TTL as expired and creates a new event (API-21)', async () => {
    const { useCase, advance } = setup();
    const first = await useCase.execute(input);
    advance(TTL_MS + 1_000);
    const second = await useCase.execute(input);

    if (first.status !== 'created') throw new Error(first.status);
    expect(second.status).toBe('created');
    if (second.status !== 'created') return;
    expect(second.id).not.toBe(first.id);
  });

  it('always creates a new event when no key is sent', async () => {
    const { useCase, store } = setup();
    const { idempotencyKey: _unused, ...withoutKey } = input;
    const first = await useCase.execute(withoutKey);
    const second = await useCase.execute(withoutKey);

    expect([first.status, second.status]).toEqual(['created', 'created']);
    const page = await new ListEvents(store).execute({
      appId,
      customerId: 'cus_1',
      limit: 10,
    });
    expect(page.status === 'ok' && page.events).toHaveLength(2);
  });
});

describe('ListEvents', () => {
  const appId = newId('app', Date.now());

  it('pages with limit + 1 and returns the last ID as the next cursor, null at the end', async () => {
    const store = new InMemoryEventStore();
    let second = 0;
    const ingest = new IngestEvent(
      store,
      {
        now: () =>
          new Date(Date.parse('2026-10-07T10:00:00Z') + 1000 * second++),
      },
      { idempotencyTtlMs: 1000 },
    );
    for (let i = 0; i < 3; i++) {
      await ingest.execute({
        appId,
        customerId: 'cus_1',
        type: 'a.b',
        payload: {},
      });
    }
    const list = new ListEvents(store);

    const first = await list.execute({ appId, customerId: 'cus_1', limit: 2 });
    if (first.status !== 'ok') throw new Error(first.status);
    expect(first.events).toHaveLength(2);
    expect(first.nextAfterId).toBe(first.events[1]?.id);

    const last = await list.execute({
      appId,
      customerId: 'cus_1',
      limit: 2,
      afterId: first.nextAfterId ?? undefined,
    });
    if (last.status !== 'ok') throw new Error(last.status);
    expect(last.events).toHaveLength(1);
    expect(last.nextAfterId).toBeNull();
  });

  it('reports an invalid cursor for an unknown event', async () => {
    const result = await new ListEvents(new InMemoryEventStore()).execute({
      appId,
      customerId: 'cus_1',
      afterId: newId('event', Date.now()),
      limit: 10,
    });
    expect(result).toEqual({ status: 'invalid_cursor' });
  });
});
