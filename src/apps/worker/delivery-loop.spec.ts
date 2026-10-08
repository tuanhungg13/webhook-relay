import { setTimeout as sleep } from 'node:timers/promises';
import { newId } from '../../core/id.js';
import type { ClaimedDelivery } from '../../features/delivery/ports/delivery-store.port.js';
import type { DeliverResult } from '../../features/delivery/use-cases/deliver.use-case.js';
import { DeliveryLoop, type LoopLogger } from './delivery-loop.js';

/** "Bây giờ" cố định của đồng hồ giả. */
const NOW = new Date('2026-10-08T10:00:00Z');

/** Một delivery giả đã giành quyền. */
const fakeClaim = (): ClaimedDelivery => ({
  id: newId('delivery', NOW.getTime()),
  eventId: newId('event', NOW.getTime()),
  endpointId: newId('endpoint', NOW.getTime()),
  leaseToken: 'token',
  attemptCount: 0,
});

/** Store giả: có `pending` việc; ghi lại `limit` mỗi lần gọi; `gate` để giữ lời gọi lại. */
class FakeQueue {
  readonly limits: number[] = [];
  gate: Promise<void> | null = null;
  constructor(public pending: number) {}
  /** Ghi `limit`, chờ `gate` (nếu có), rồi trả tối đa `limit` việc còn lại. */
  async claimDue(input: { limit: number }): Promise<ClaimedDelivery[]> {
    this.limits.push(input.limit);
    if (this.gate) await this.gate;
    const count = Math.min(input.limit, this.pending);
    this.pending -= count;
    return Array.from({ length: count }, fakeClaim);
  }
}

/** Use case giả: mỗi việc treo tới khi test gọi `finishOne`/`finishAll`. */
class HangingDeliver {
  active = 0;
  maxActive = 0;
  started = 0;
  private readonly waiting: Array<() => void> = [];
  /** Đếm việc đang chạy rồi treo tới khi được thả. */
  async execute(): Promise<DeliverResult> {
    this.started++;
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active--;
    return { status: 'lease_lost' };
  }
  /** Thả việc treo lâu nhất. */
  finishOne(): void {
    this.waiting.shift()?.();
  }
  /** Thả mọi việc đang treo. */
  finishAll(): void {
    this.waiting.splice(0).forEach((resolve) => resolve());
  }
}

/** Logger giả ghi lại từng lời gọi. */
function fakeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies LoopLogger;
}

/** Chờ tới khi `check` đúng (tối đa 1 giây), để test không phụ thuộc thứ tự microtask. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await sleep(10);
  expect(check()).toBe(true);
}

let loop: DeliveryLoop | undefined;
afterEach(async () => {
  await loop?.stop();
  loop = undefined;
});

/** Dựng vòng lặp với store, use case giả; lease 30s, ngủ `idleSleepMs` khi hết việc. */
function makeLoop(
  queue: FakeQueue,
  deliver: { execute: (claim: ClaimedDelivery) => Promise<DeliverResult> },
  options: { concurrency?: number; idleSleepMs?: number } = {},
) {
  const logger = fakeLogger();
  loop = new DeliveryLoop(
    { store: queue, deliver, clock: { now: () => NOW }, logger },
    {
      concurrency: options.concurrency ?? 3,
      idleSleepMs: options.idleSleepMs ?? 1_000,
      leaseMs: 30_000,
    },
  );
  return { loop, logger };
}

describe('DeliveryLoop', () => {
  it('never runs more than the concurrency, claiming only free slots (U12, WRK-07)', async () => {
    const queue = new FakeQueue(10);
    const deliver = new HangingDeliver();
    makeLoop(queue, deliver).loop.start();

    await until(() => deliver.started === 3);
    await sleep(30);
    expect(deliver.active).toBe(3);
    expect(queue.limits).toEqual([3]);

    deliver.finishOne();
    await until(() => deliver.started === 4);
    expect(queue.limits).toEqual([3, 1]);
    expect(deliver.maxActive).toBe(3);
    queue.pending = 0;
    deliver.finishAll();
  });

  it('sleeps when there is no work instead of polling in a loop (U13)', async () => {
    const queue = new FakeQueue(0);
    makeLoop(queue, new HangingDeliver(), { idleSleepMs: 1_000 }).loop.start();

    await sleep(50);

    expect(queue.limits).toHaveLength(1);
  });

  it('logs an unexpected error and keeps the other jobs and the loop going (U14, WRK-11)', async () => {
    const queue = new FakeQueue(3);
    let calls = 0;
    const deliver = {
      execute: (): Promise<DeliverResult> => {
        calls++;
        if (calls === 1) {
          return Promise.reject(
            Object.assign(new Error('boom'), {
              code: 'XX',
              detail: 'row data',
            }),
          );
        }
        return Promise.resolve({ status: 'lease_lost' });
      },
    };
    const { logger } = makeLoop(queue, deliver, { idleSleepMs: 10 });
    loop!.start();

    await until(() => calls === 3 && queue.limits.length >= 2);

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [fields] = logger.error.mock.calls[0]!;
    expect(fields).toMatchObject({ error: { code: 'XX', message: 'boom' } });
    expect(JSON.stringify(fields)).not.toContain('row data');
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('logs and retries when claiming fails, without stopping', async () => {
    const queue = new FakeQueue(1);
    const claimDue = queue.claimDue.bind(queue);
    let failures = 1;
    queue.claimDue = (input) =>
      failures-- > 0 ? Promise.reject(new Error('db down')) : claimDue(input);
    const deliver = new HangingDeliver();
    const { logger } = makeLoop(queue, deliver, { idleSleepMs: 10 });
    loop!.start();

    await until(() => deliver.started === 1);

    expect(logger.error).toHaveBeenCalledTimes(1);
    deliver.finishAll();
  });

  it('stop() waits for running jobs and claims nothing more (U15, WRK-04)', async () => {
    const queue = new FakeQueue(2);
    const deliver = new HangingDeliver();
    makeLoop(queue, deliver, { idleSleepMs: 10 }).loop.start();
    await until(() => deliver.started === 2);
    queue.pending = 5;

    let stopped = false;
    const stopping = loop!.stop().then(() => (stopped = true));
    await sleep(30);
    expect(stopped).toBe(false);

    deliver.finishAll();
    await stopping;
    expect(deliver.started).toBe(2);
  });

  it('stop() while sleeping resolves at once (U15)', async () => {
    makeLoop(new FakeQueue(0), new HangingDeliver(), {
      idleSleepMs: 60_000,
    }).loop.start();
    await sleep(20);

    const startedAt = Date.now();
    await loop!.stop();

    expect(Date.now() - startedAt).toBeLessThan(100);
  });

  it('stop() during a claim still processes the claimed batch (U15)', async () => {
    const queue = new FakeQueue(2);
    let openGate!: () => void;
    queue.gate = new Promise((resolve) => (openGate = resolve));
    const deliver = new HangingDeliver();
    makeLoop(queue, deliver).loop.start();
    await until(() => queue.limits.length === 1);

    const stopping = loop!.stop();
    openGate();
    await until(() => deliver.started === 2);
    deliver.finishAll();
    await stopping;

    expect(queue.limits).toHaveLength(1);
  });
});
