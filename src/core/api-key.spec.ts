import { createHash } from 'node:crypto';
import { generateApiKey, hashApiKey } from './api-key.js';

describe('generateApiKey', () => {
  it('is sk_ followed by 43 base62 characters (32 random bytes, API-01)', () => {
    expect(generateApiKey().key).toMatch(/^sk_[0-9A-Za-z]{43}$/);
  });

  it('exposes the first 8 characters as the prefix for logs', () => {
    const { key, prefix } = generateApiKey();

    expect(prefix).toBe(key.slice(0, 8));
  });

  it('stores only the SHA-256 of the key (SEC-11)', () => {
    const { key, hash } = generateApiKey();

    expect(hash.equals(createHash('sha256').update(key).digest())).toBe(true);
  });

  it('never repeats', () => {
    const keys = new Set(
      Array.from({ length: 1_000 }, () => generateApiKey().key),
    );

    expect(keys.size).toBe(1_000);
  });
});

describe('hashApiKey', () => {
  it('is deterministic, so a presented key can be looked up by hash', () => {
    const { key, hash } = generateApiKey();

    expect(hashApiKey(key).equals(hash)).toBe(true);
  });
});
