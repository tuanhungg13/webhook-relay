import { newId } from '../../src/core/id.js';
import { InMemoryEventStore } from '../fakes/in-memory-event-store.js';
import { describeEventStoreContract } from './event-store.contract.js';

describeEventStoreContract('in-memory', () => {
  const store = new InMemoryEventStore();
  return Promise.resolve({
    store,
    // Bản giả không kiểm app tồn tại, chỉ cần một ID app mới.
    createApp: () => Promise.resolve(newId('app', Date.now())),
    addEndpoint: (appId, seed) => {
      const id = newId('endpoint', Date.now());
      store.addEndpoint({
        id,
        appId,
        customerId: seed.customerId,
        eventTypes: seed.eventTypes,
        deleted: seed.deleted ?? false,
        disabled: seed.disabled ?? false,
      });
      return Promise.resolve(id);
    },
  });
});
