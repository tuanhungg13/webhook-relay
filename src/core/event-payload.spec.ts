import { checkEventPayload } from './event-payload.js';

/** Object lồng `levels` cấp (cấp 1 là chính nó), dựng bằng vòng lặp để không tràn stack. */
function nested(levels: number): object {
  let value: object = {};
  for (let i = 1; i < levels; i++) value = { n: value };
  return value;
}

describe('checkEventPayload', () => {
  it('accepts an ordinary object', () => {
    expect(
      checkEventPayload({
        id: 'o1',
        total: 12.5,
        tags: ['a'],
        ok: true,
        x: null,
      }),
    ).toBeNull();
  });

  it.each([[[]], [null], ['text'], [1], [undefined]])(
    'rejects %j as the payload',
    (payload) => {
      expect(checkEventPayload(payload)).toEqual({
        path: 'payload',
        message: 'must be a JSON object',
      });
    },
  );

  it('accepts 32 levels and rejects 33', () => {
    expect(checkEventPayload(nested(32))).toBeNull();
    expect(checkEventPayload(nested(33))?.message).toMatch(/32 levels/);
  });

  it('stops on a payload nested 100000 levels without overflowing the stack', () => {
    const text = '{"n":'.repeat(100_000) + '{}' + '}'.repeat(100_000);
    expect(checkEventPayload(JSON.parse(text))).not.toBeNull();
  });

  it('accepts ±(2^53-1) and fractions, rejects larger integers with the path', () => {
    expect(
      checkEventPayload({
        a: Number.MAX_SAFE_INTEGER,
        b: -Number.MAX_SAFE_INTEGER,
        c: 1.5,
      }),
    ).toBeNull();
    const issue = checkEventPayload(
      JSON.parse('{"order":{"id":12345678901234567890}}'),
    );
    expect(issue?.path).toBe('payload.order.id');
  });

  it('rejects numbers that overflow to Infinity (1e400)', () => {
    expect(checkEventPayload(JSON.parse('{"a":[1,1e400]}'))?.path).toBe(
      'payload.a[1]',
    );
    expect(checkEventPayload(JSON.parse('{"a":-1e400}'))?.path).toBe(
      'payload.a',
    );
  });

  it.each([
    ['NUL in a value', String.raw`{"a":"x\u0000y"}`],
    ['NUL in a key', String.raw`{"a\u0000":1}`],
    ['lone surrogate in a value', String.raw`{"a":"\ud800"}`],
    ['lone surrogate in a key', String.raw`{"\udc00":1}`],
  ])('rejects %s', (_name, json) => {
    expect(checkEventPayload(JSON.parse(json))).not.toBeNull();
  });

  it('accepts a proper surrogate pair and a __proto__ key', () => {
    expect(
      checkEventPayload(
        JSON.parse(String.raw`{"a":"\ud83d\ude00","__proto__":{"x":1}}`),
      ),
    ).toBeNull();
  });

  it('never copies the offending value into the message', () => {
    const issue = checkEventPayload(
      JSON.parse(String.raw`{"secret":"whsec_abc\u0000"}`),
    );
    expect(JSON.stringify(issue)).not.toContain('whsec_abc');
  });
});
