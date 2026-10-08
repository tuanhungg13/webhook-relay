import { checkHost } from './host-check.js';
import { parseCidrList } from './ip-policy.js';

const never = () => Promise.reject(new Error('resolver must not be called'));

describe('checkHost', () => {
  it.each([
    '127.0.0.1', // 2130706433, 0x7f.1, 0177.0.0.1 đều ra dạng này sau khi URL chuẩn hóa
    '169.254.169.254',
    '[::ffff:7f00:1]',
    '[::7f00:1]',
    '[2002:7f00:1::]',
    '[64:ff9b::7f00:1]',
  ])('blocks the IP literal %s without calling DNS (SEC-06)', async (host) => {
    expect(await checkHost(host, never, [])).toEqual({ status: 'blocked' });
  });

  it('normalises attack URLs the way the callers do', () => {
    for (const url of [
      'https://2130706433/',
      'https://0x7f.1/',
      'https://0177.0.0.1/',
    ]) {
      expect(URL.parse(url)!.hostname).toBe('127.0.0.1');
    }
  });

  it('accepts a public IP literal and returns it', async () => {
    expect(await checkHost('[2606:4700::1111]', never, [])).toEqual({
      status: 'ok',
      address: '2606:4700::1111',
    });
  });

  it('blocks a name that resolves to an internal IP', async () => {
    const resolve = async () => ['127.0.0.1'];
    expect(await checkHost('evil.example', resolve, [])).toEqual({
      status: 'blocked',
    });
  });

  it('blocks when only one of several IPs is internal (SEC-01)', async () => {
    const resolve = async () => ['8.8.8.8', '10.0.0.5'];
    expect(await checkHost('evil.example', resolve, [])).toEqual({
      status: 'blocked',
    });
  });

  it('returns the first IP when all are public', async () => {
    const resolve = async () => ['8.8.8.8', '1.1.1.1'];
    expect(await checkHost('ok.example', resolve, [])).toEqual({
      status: 'ok',
      address: '8.8.8.8',
    });
  });

  it('reports unresolved on resolver error or empty answer', async () => {
    const fail = async () => {
      throw new Error('ENOTFOUND');
    };
    expect(await checkHost('x.example', fail, [])).toEqual({
      status: 'unresolved',
    });
    expect(await checkHost('x.example', async () => [], [])).toEqual({
      status: 'unresolved',
    });
  });

  it('honours the allowlist', async () => {
    const allowlist = parseCidrList('172.20.0.0/16');
    const resolve = async () => ['172.20.0.9'];
    expect(await checkHost('mock', resolve, allowlist)).toEqual({
      status: 'ok',
      address: '172.20.0.9',
    });
  });
});
