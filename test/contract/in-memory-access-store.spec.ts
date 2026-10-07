import { InMemoryAccessStore } from '../fakes/in-memory-access-store.js';
import { describeAccessStoreContract } from './access-store.contract.js';

describeAccessStoreContract('in-memory', () =>
  Promise.resolve({ store: new InMemoryAccessStore() }),
);
