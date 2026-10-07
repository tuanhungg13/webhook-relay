import { resolveRequestId } from './request-id.js';

describe('resolveRequestId', () => {
  it('keeps a valid client id', () => {
    expect(resolveRequestId('abc-1.2_3')).toBe('abc-1.2_3');
  });

  it.each([
    ['too long', 'a'.repeat(129)],
    ['with a space', 'abc def'],
    ['with a $', 'abc$'],
    ['empty', ''],
    ['missing', undefined],
  ])('replaces an id that is %s with a new UUID', (_label, input) => {
    expect(resolveRequestId(input)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('accepts exactly 128 characters', () => {
    expect(resolveRequestId('a'.repeat(128))).toBe('a'.repeat(128));
  });
});
