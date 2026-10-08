import { isAllowedAddress, parseCidrList } from './ip-policy.js';

describe('isAllowedAddress', () => {
  it.each([
    '0.0.0.0',
    '127.0.0.1',
    '::1',
    '::',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    'fc00::1',
    '169.254.169.254',
    'fe80::1',
    '100.64.0.1',
    '192.0.0.1',
    '198.18.0.1',
    '224.0.0.1',
    'ff00::1',
    '240.0.0.1',
    '255.255.255.255',
  ])('blocks the special range %s (SEC-07)', (ip) => {
    expect(isAllowedAddress(ip, [])).toBe(false);
  });

  it.each([
    '::ffff:127.0.0.1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '::127.0.0.1',
    '::7f00:1',
    '::ffff:a00:1',
  ])('blocks IPv4 loopback/private embedded as %s (SEC-08)', (ip) => {
    expect(isAllowedAddress(ip, [])).toBe(false);
  });

  it('allows a public IPv4 embedded in IPv6', () => {
    expect(isAllowedAddress('::ffff:8.8.8.8', [])).toBe(true);
    expect(isAllowedAddress('64:ff9b::808:808', [])).toBe(true);
  });

  it('allows public addresses', () => {
    expect(isAllowedAddress('8.8.8.8', [])).toBe(true);
    expect(isAllowedAddress('2606:4700::1111', [])).toBe(true);
  });

  it.each(['', 'not-an-ip', 'fe80::1%eth0', '300.1.1.1', 'localhost'])(
    'blocks the unparsable value %j',
    (ip) => {
      expect(isAllowedAddress(ip, [])).toBe(false);
    },
  );

  it('lets the allowlist override the range check, only inside the CIDR', () => {
    const allowlist = parseCidrList('172.20.0.0/16');
    expect(isAllowedAddress('172.20.0.5', allowlist)).toBe(true);
    expect(isAllowedAddress('172.21.0.5', allowlist)).toBe(false);
    expect(isAllowedAddress('::1', allowlist)).toBe(false);
    expect(isAllowedAddress('8.8.8.8', allowlist)).toBe(true);
  });
});

describe('parseCidrList', () => {
  it('returns [] for an empty string', () => {
    expect(parseCidrList('')).toEqual([]);
  });

  it('splits on commas and trims spaces', () => {
    expect(parseCidrList('10.0.0.0/8, fd00::/8')).toHaveLength(2);
  });

  it('names the bad item', () => {
    expect(() => parseCidrList('10.0.0.0/8,oops')).toThrow(/"oops"/);
  });
});
