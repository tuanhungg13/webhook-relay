import { generateWebhookSecret } from './webhook-secret.js';

describe('generateWebhookSecret', () => {
  it('is whsec_ + standard base64 of 32 random bytes, different every call (SEC-20)', () => {
    const first = generateWebhookSecret();
    const second = generateWebhookSecret();

    for (const secret of [first, second]) {
      expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
      expect(Buffer.from(secret.slice('whsec_'.length), 'base64')).toHaveLength(
        32,
      );
    }
    expect(first).not.toBe(second);
  });
});
