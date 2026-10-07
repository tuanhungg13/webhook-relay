import { eventFingerprint } from './request-fingerprint.js';

describe('eventFingerprint', () => {
  const base = {
    customerId: 'cus_1',
    type: 'order.created',
    payload: { a: 1, b: [1, 2] },
  };

  it('is the same for requests with the same meaning', () => {
    const reordered = { ...base, payload: JSON.parse('{"b":[1,2],"a":1.0}') };
    expect(eventFingerprint(reordered).equals(eventFingerprint(base))).toBe(
      true,
    );
    expect(eventFingerprint(base)).toHaveLength(32);
  });

  it.each([
    ['customer_id', { customerId: 'cus_2' }],
    ['type', { type: 'order.paid' }],
    ['payload', { payload: { a: 2, b: [1, 2] } }],
  ])('differs when %s differs', (_name, change) => {
    expect(
      eventFingerprint({ ...base, ...change }).equals(eventFingerprint(base)),
    ).toBe(false);
  });

  it('does not confuse values shifted between fields', () => {
    const a = eventFingerprint({ ...base, customerId: 'a', type: 'bc' });
    const b = eventFingerprint({ ...base, customerId: 'ab', type: 'c' });
    expect(a.equals(b)).toBe(false);
  });
});
