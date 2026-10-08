import { InMemoryDeliveryStore } from '../../../../test/fakes/in-memory-delivery-store.js';
import { newId } from '../../../core/id.js';
import {
  serializeWebhookBody,
  signWebhook,
} from '../../../core/webhook-signature.js';
import { generateWebhookSecret } from '../../../core/webhook-secret.js';
import type { ClaimedDelivery } from '../ports/delivery-store.port.js';
import type {
  SendOutcome,
  SendRequest,
  WebhookSender,
} from '../ports/webhook-sender.port.js';
import { Deliver } from './deliver.use-case.js';

/** "Bây giờ" cố định của mọi ca. */
const NOW = new Date('2026-10-08T10:00:00Z');
/** Hạn lease khi giành quyền trong test: 30 giây sau `NOW`. */
const LEASE_UNTIL = new Date(NOW.getTime() + 30_000);
/** Secret hiện tại của endpoint. */
const SECRET = generateWebhookSecret();
/** Secret cũ (trước lần xoay) của endpoint. */
const OLD_SECRET = generateWebhookSecret();
/** `User-Agent` mà use case phải gửi. */
const USER_AGENT = 'WebhookRelay/0.0.1';
/** Lịch retry rút gọn: 3 attempt tối đa. */
const DELAYS = [5_000, 60_000];

/** Bộ gửi giả: ghi lại request, trả lần lượt các outcome đã xếp (hết thì trả 200). */
class FakeSender implements WebhookSender {
  /** Các request đã nhận, theo thứ tự. */
  readonly requests: SendRequest[] = [];
  constructor(private readonly outcomes: SendOutcome[] = []) {}
  /** Ghi lại request rồi trả outcome kế tiếp. */
  send(request: SendRequest): Promise<SendOutcome> {
    this.requests.push(request);
    return Promise.resolve(
      this.outcomes.shift() ?? { status: 'ok', httpStatus: 200, snippet: '' },
    );
  }
}

let store: InMemoryDeliveryStore;
let claim: ClaimedDelivery;

/** Dựng một sự kiện + endpoint + delivery `pending` rồi giành quyền nó. */
async function seed(
  endpoint: Partial<{
    url: string;
    previousSecret: string | null;
    previousSecretExpiresAt: Date | null;
    deletedAt: Date | null;
    disabledAt: Date | null;
  }> = {},
) {
  store = new InMemoryDeliveryStore();
  const eventId = newId('event', NOW.getTime());
  const endpointId = newId('endpoint', NOW.getTime());
  const id = newId('delivery', NOW.getTime());
  store.events.set(eventId, {
    id: eventId,
    type: 'order.created',
    createdAt: new Date('2026-10-08T09:59:00Z'),
    payload: { order_id: 'o1', note: 'xin chào' },
  });
  store.endpoints.set(endpointId, {
    url: 'https://shop.example/hook',
    secret: SECRET,
    previousSecret: null,
    previousSecretExpiresAt: null,
    deletedAt: null,
    disabledAt: null,
    firstFailureAt: null,
    ...endpoint,
  });
  store.deliveries.set(id, {
    id,
    eventId,
    endpointId,
    status: 'pending',
    failedReason: null,
    attemptCount: 0,
    nextAttemptAt: NOW,
    leaseUntil: null,
    leaseToken: null,
    lastError: null,
    gateBlockedCount: 0,
    updatedAt: NOW,
  });
  [claim] = await store.claimDue({
    now: NOW,
    leaseUntil: LEASE_UNTIL,
    limit: 1,
  });
}

/** Use case với đồng hồ đứng yên ở `NOW` và `random` = 0,5 (jitter 1,0). */
function makeDeliver(sender: WebhookSender, warn = vi.fn()) {
  return new Deliver(
    store,
    sender,
    { now: () => NOW },
    {
      userAgent: USER_AGENT,
      retryDelaysMs: DELAYS,
      logger: { warn },
      random: () => 0.5,
    },
  );
}

/** Delivery duy nhất trong store. */
const delivery = () => [...store.deliveries.values()][0]!;

describe('Deliver', () => {
  it('sends a signed request and records a success (U5)', async () => {
    await seed();
    const sender = new FakeSender([
      { status: 'ok', httpStatus: 200, snippet: 'thanks' },
    ]);

    const result = await makeDeliver(sender).execute(claim);

    expect(result).toEqual({
      status: 'sent',
      attemptCount: 1,
      outcome: { status: 'ok', httpStatus: 200, snippet: 'thanks' },
      decision: { status: 'succeeded' },
    });
    const [request] = sender.requests;
    expect(request!.headers).toMatchObject({
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      'webhook-id': claim.eventId,
      'webhook-timestamp': String(NOW.getTime() / 1000),
    });
    expect(request!.headers['webhook-signature']).toBe(
      signWebhook({
        webhookId: claim.eventId,
        sentAt: NOW,
        body: request!.body,
        secrets: [SECRET],
      })['webhook-signature'],
    );
    expect(store.attempts).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        startedAt: NOW,
        httpStatus: 200,
        responseSnippet: 'thanks',
        error: null,
      }),
    ]);
    expect(delivery()).toMatchObject({ status: 'succeeded', lastError: null });
  });

  it('sends exactly the serialized body bytes that were signed (U6, SIG-01)', async () => {
    await seed();
    const sender = new FakeSender();

    await makeDeliver(sender).execute(claim);

    const event = [...store.events.values()][0]!;
    expect(sender.requests[0]!.body.equals(serializeWebhookBody(event))).toBe(
      true,
    );
  });

  it('signs with the previous secret too while it is still valid (U7, SEC-22)', async () => {
    const countSignatures = async (expiresAt: Date) => {
      await seed({
        previousSecret: OLD_SECRET,
        previousSecretExpiresAt: expiresAt,
      });
      const sender = new FakeSender();
      await makeDeliver(sender).execute(claim);
      return sender.requests[0]!.headers['webhook-signature']!.split(' ')
        .length;
    };
    expect(await countSignatures(new Date(NOW.getTime() + 1))).toBe(2);
    expect(await countSignatures(NOW)).toBe(1);
  });

  it.each<[SendOutcome, object, string]>([
    [{ status: 'timeout' }, { error: 'timeout', httpStatus: null }, 'timeout'],
    [
      { status: 'ssrf_blocked' },
      { error: 'ssrf_blocked', httpStatus: null },
      'ssrf_blocked',
    ],
    [
      { status: 'http_status', httpStatus: 503, snippet: 'down' },
      { error: null, httpStatus: 503, responseSnippet: 'down' },
      'http 503',
    ],
  ])(
    'records a failed attempt and retries later (U8: %j)',
    async (outcome, attempt, label) => {
      await seed();

      const result = await makeDeliver(new FakeSender([outcome])).execute(
        claim,
      );

      const nextAttemptAt = new Date(NOW.getTime() + DELAYS[0]!);
      expect(result).toMatchObject({
        status: 'sent',
        decision: { status: 'pending', nextAttemptAt },
      });
      expect(store.attempts[0]).toMatchObject(attempt);
      expect(delivery()).toMatchObject({
        status: 'pending',
        nextAttemptAt,
        lastError: label,
      });
      expect(delivery().lastError).not.toContain('shop.example');
    },
  );

  it('fails as exhausted on the last attempt', async () => {
    await seed();
    claim = { ...claim, attemptCount: DELAYS.length };

    const result = await makeDeliver(
      new FakeSender([{ status: 'timeout' }]),
    ).execute(claim);

    expect(result).toMatchObject({
      decision: { status: 'failed', reason: 'exhausted' },
    });
    expect(delivery()).toMatchObject({
      status: 'failed',
      failedReason: 'exhausted',
    });
  });

  it.each([
    ['deletedAt', 'endpoint_deleted'],
    ['disabledAt', 'endpoint_disabled'],
  ] as const)(
    'fails without sending when the endpoint has %s (U9)',
    async (field, reason) => {
      await seed({ [field]: new Date('2026-10-08T09:00:00Z') });
      const sender = new FakeSender();

      const result = await makeDeliver(sender).execute(claim);

      expect(result).toEqual({ status: 'endpoint_gone', reason });
      expect(sender.requests).toHaveLength(0);
      expect(store.attempts).toHaveLength(0);
      expect(delivery()).toMatchObject({
        status: 'failed',
        failedReason: reason,
      });
    },
  );

  it('reports lease_lost instead of throwing (U10)', async () => {
    await seed();
    const stale = { ...claim, leaseToken: 'someone-else' };

    expect(await makeDeliver(new FakeSender()).execute(stale)).toEqual({
      status: 'lease_lost',
    });
  });

  it('sends to the endpoint URL current at processing time (U11, WRK-06)', async () => {
    await seed();
    store.endpoints.values().next().value!.url = 'https://new.example/hook';
    const sender = new FakeSender();

    await makeDeliver(sender).execute(claim);

    expect(sender.requests[0]!.url).toBe('https://new.example/hook');
  });

  it('retries a failing recordAttempt and sends HTTP only once (U18)', async () => {
    await seed();
    const sender = new FakeSender();
    const record = vi
      .spyOn(store, 'recordAttempt')
      .mockRejectedValueOnce(new Error('connection timeout'))
      .mockRejectedValueOnce(new Error('connection timeout'));

    const warn = vi.fn();

    const result = await makeDeliver(sender, warn).execute(claim);

    expect(result).toMatchObject({ status: 'sent' });
    expect(record).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toMatchObject({
      error: { message: 'connection timeout' },
    });
    expect(sender.requests).toHaveLength(1);
    expect(delivery().status).toBe('succeeded');
  });

  it('gives up after 3 failed recordAttempt calls and throws (U18)', async () => {
    await seed();
    const record = vi
      .spyOn(store, 'recordAttempt')
      .mockRejectedValue(new Error('connection timeout'));

    await expect(makeDeliver(new FakeSender()).execute(claim)).rejects.toThrow(
      'connection timeout',
    );
    expect(record).toHaveBeenCalledTimes(3);
  });

  it('does not retry recordAttempt when the lease is lost (U18)', async () => {
    await seed();
    const record = vi
      .spyOn(store, 'recordAttempt')
      .mockResolvedValue('lease_lost');

    expect(await makeDeliver(new FakeSender()).execute(claim)).toEqual({
      status: 'lease_lost',
    });
    expect(record).toHaveBeenCalledTimes(1);
  });
});
