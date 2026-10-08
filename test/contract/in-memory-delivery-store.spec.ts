import { randomUUID } from 'node:crypto';
import { newId } from '../../src/core/id.js';
import { InMemoryDeliveryStore } from '../fakes/in-memory-delivery-store.js';
import {
  at,
  describeDeliveryStoreContract,
  httpAttempt,
  NOW,
  SEED_ENDPOINT,
  SEED_EVENT,
  SEED_GONE_AT,
} from './delivery-store.contract.js';

describeDeliveryStoreContract('in-memory', () => {
  const store = new InMemoryDeliveryStore();
  return Promise.resolve({
    store,
    addDelivery: (seed = {}) => {
      const eventId = newId('event', SEED_EVENT.createdAt.getTime());
      const endpointId = newId('endpoint', NOW.getTime());
      const id = newId('delivery', NOW.getTime());
      store.events.set(eventId, { id: eventId, ...SEED_EVENT });
      store.endpoints.set(endpointId, {
        ...SEED_ENDPOINT,
        deletedAt: seed.endpoint === 'deleted' ? SEED_GONE_AT : null,
        disabledAt: seed.endpoint === 'disabled' ? SEED_GONE_AT : null,
        firstFailureAt: null,
      });
      const inFlight = seed.status === 'in_flight';
      store.deliveries.set(id, {
        id,
        eventId,
        endpointId,
        status: seed.status ?? 'pending',
        failedReason: null,
        attemptCount: seed.attemptCount ?? 0,
        nextAttemptAt: seed.nextAttemptAt ?? at(-60_000),
        leaseUntil: inFlight ? seed.leaseUntil! : null,
        leaseToken: inFlight ? (seed.leaseToken ?? randomUUID()) : null,
        lastError: seed.lastError ?? null,
        gateBlockedCount: seed.gateBlockedCount ?? 0,
        updatedAt: NOW,
      });
      for (let n = 1; n <= (seed.priorAttempts ?? 0); n++) {
        store.attempts.push({
          ...httpAttempt(500),
          deliveryId: id,
          attemptNumber: n,
        });
      }
      return Promise.resolve(id);
    },
    readDelivery: (id) => {
      const d = store.deliveries.get(id)!;
      return Promise.resolve(
        structuredClone({
          status: d.status,
          failedReason: d.failedReason,
          attemptCount: d.attemptCount,
          nextAttemptAt: d.nextAttemptAt,
          leaseUntil: d.leaseUntil,
          leaseToken: d.leaseToken,
          lastError: d.lastError,
          gateBlockedCount: d.gateBlockedCount,
        }),
      );
    },
    readAttempts: (id) =>
      Promise.resolve(
        store.attempts
          .filter((a) => a.deliveryId === id)
          .map((a) => ({
            attemptNumber: a.attemptNumber,
            httpStatus: a.httpStatus,
            error: a.error,
            responseSnippet: a.responseSnippet,
            durationMs: a.durationMs,
          })),
      ),
    firstFailureAt: (id) =>
      Promise.resolve(
        store.endpoints.get(store.deliveries.get(id)!.endpointId)!
          .firstFailureAt,
      ),
  });
});
