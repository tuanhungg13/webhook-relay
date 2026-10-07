import { validateEndpointUrl } from './endpoint-url.js';

/** Tùy chọn như production: chỉ https. */
const strict = { allowInsecureHttp: false };
/** Tùy chọn khi bật `ALLOW_INSECURE_HTTP` (dev/test). */
const insecure = { allowInsecureHttp: true };

describe('validateEndpointUrl', () => {
  it.each([
    'https://a.com/h',
    'https://a.com:443/h',
    'https://a.com:1024/h',
    'https://a.com:8443/h?x=1',
  ])('accepts %s', (url) => {
    expect(validateEndpointUrl(url, strict)).toBeNull();
  });

  it.each([
    ['http://a.com/h', /https/],
    ['http://a.com:8080/h', /https/],
    ['ftp://a.com/h', /https/],
    ['https://user:pass@a.com/h', /credentials/],
    ['https://user@a.com/h', /credentials/],
    ['https://a.com:25/h', /port/],
    ['https://a.com:80/h', /port/],
    ['https://a.com:1023/h', /port/],
    ['not a url', /valid URL/],
    ['', /valid URL/],
    [`https://a.com/${'a'.repeat(2049 - 'https://a.com/'.length)}`, /2048/],
  ])('rejects %s', (url, message) => {
    expect(validateEndpointUrl(url, strict)).toMatch(message);
  });

  it('accepts exactly 2048 characters', () => {
    const url = `https://a.com/${'a'.repeat(2048 - 'https://a.com/'.length)}`;
    expect(validateEndpointUrl(url, strict)).toBeNull();
  });

  it.each(['http://a.com/h', 'http://a.com:80/h', 'http://a.com:8080/h'])(
    'accepts %s when insecure HTTP is allowed',
    (url) => {
      expect(validateEndpointUrl(url, insecure)).toBeNull();
    },
  );

  it.each([
    ['https://a.com:25/h', /port/],
    ['http://a.com:22/h', /port/],
    ['ftp://a.com/h', /http/],
  ])('still rejects %s when insecure HTTP is allowed', (url, message) => {
    expect(validateEndpointUrl(url, insecure)).toMatch(message);
  });

  it('does not echo the URL (it may contain credentials)', () => {
    expect(
      validateEndpointUrl('https://user:hunter2@a.com/h', strict),
    ).not.toContain('hunter2');
  });
});
