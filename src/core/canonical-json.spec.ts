import { canonicalJson } from './canonical-json.js';

describe('canonicalJson (RFC 8785)', () => {
  it('sorts keys by UTF-16 code unit at every level (RFC §3.2.3)', () => {
    // Ví dụ của RFC: "\r" < "1" < "\u0080" < "ö" < "€" < "😀" < "\ufb33".
    const input = JSON.parse(
      String.raw`{"\u20ac":"Euro","\r":"CR","\ufb33":"Hebrew","1":"One","\ud83d\ude00":"Emoji","\u0080":"C1","\u00f6":"o"}`,
    );
    // So thẳng chuỗi đầu ra (đọc lại bằng JSON.parse sẽ đưa key số "1" lên đầu).
    expect(canonicalJson(input)).toBe(
      [
        String.raw`{"\r":"CR"`,
        String.raw`"1":"One"`,
        '"\u0080":"C1"',
        '"ö":"o"',
        '"€":"Euro"',
        '"😀":"Emoji"',
        '"\ufb33":"Hebrew"}',
      ].join(','),
    );
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: [{ z: 1, y: 2 }] })).toBe(
      '{"a":[{"y":2,"z":1}],"b":{"c":2,"d":1}}',
    );
  });

  it('formats numbers like ECMAScript (RFC §3.2.2)', () => {
    const numbers = JSON.parse(
      '[333333333.33333329,1E30,4.5,2e-3,0.000000000000000000000000001,-0,1.0]',
    );
    expect(canonicalJson(numbers)).toBe(
      '[333333333.3333333,1e+30,4.5,0.002,1e-27,0,1]',
    );
  });

  it('escapes strings like JSON.stringify (RFC §3.2.2)', () => {
    expect(canonicalJson('\u000f\n"\\é\u2028')).toBe(
      String.raw`"\u000f\n\"\\é` + '\u2028"',
    );
  });

  it('ING-03.1: different key order, 1.0 vs 1 and escaped vs literal text give the same string', () => {
    const a = JSON.parse(String.raw`{"b":1.0,"a":"\u00e9"}`);
    const b = JSON.parse('{"a":"é","b":1}');
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('keeps a __proto__ key as ordinary data', () => {
    const value = JSON.parse('{"__proto__":{"x":1},"a":2}');
    expect(canonicalJson(value)).toBe('{"__proto__":{"x":1},"a":2}');
  });

  it('handles null, booleans and empty containers', () => {
    expect(canonicalJson([null, true, false, {}, []])).toBe(
      '[null,true,false,{},[]]',
    );
  });
});
