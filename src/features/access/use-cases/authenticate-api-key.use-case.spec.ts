import { generateApiKey } from '../../../core/api-key.js';
import { newId } from '../../../core/id.js';
import { InMemoryAccessStore } from '../../../../test/fakes/in-memory-access-store.js';
import { AuthenticateApiKey } from './authenticate-api-key.use-case.js';

describe('AuthenticateApiKey', () => {
  const now = new Date('2026-10-06T10:00:00Z');

  async function setup() {
    const store = new InMemoryAccessStore();
    const appId = newId('app', now.getTime());
    await store.insertApp({ id: appId });
    const keyId = newId('apiKey', now.getTime());
    const { key, hash, prefix } = generateApiKey();
    await store.insertApiKey({ id: keyId, appId, keyHash: hash, prefix });
    return {
      store,
      useCase: new AuthenticateApiKey(store),
      appId,
      keyId,
      key,
      prefix,
    };
  }

  it('returns the app and key prefix for an active key', async () => {
    const { useCase, appId, key, prefix } = await setup();
    expect(await useCase.execute({ apiKey: key })).toEqual({
      appId,
      keyPrefix: prefix,
    });
  });

  it('returns null for a revoked key', async () => {
    const { store, useCase, keyId, key } = await setup();
    await store.revokeApiKey(keyId, now);
    expect(await useCase.execute({ apiKey: key })).toBeNull();
  });

  it('returns null for a key that does not exist', async () => {
    const { useCase } = await setup();
    expect(await useCase.execute({ apiKey: generateApiKey().key })).toBeNull();
  });
});
