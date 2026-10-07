import { newId } from '../../src/core/id.js';
import { InMemoryEndpointStore } from '../fakes/in-memory-endpoint-store.js';
import { describeEndpointStoreContract } from './endpoint-store.contract.js';

describeEndpointStoreContract('in-memory', () =>
  Promise.resolve({
    store: new InMemoryEndpointStore(),
    // Bản giả không kiểm app tồn tại, chỉ cần một ID app mới.
    createApp: () => Promise.resolve(newId('app', Date.now())),
  }),
);
