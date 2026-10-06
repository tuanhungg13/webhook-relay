import {
  loadApiConfig,
  parseDurationMs,
  parseListenAddress,
} from './config.js';

describe('parseDurationMs', () => {
  it.each([
    ['100ms', 100],
    ['25s', 25_000],
    ['5m', 300_000],
    ['2h', 7_200_000],
  ])('parses %s', (input, expected) => {
    expect(parseDurationMs(input)).toBe(expected);
  });

  it.each(['', '10', '1.5s', '-1s', '5d'])('rejects %j', (input) => {
    expect(() => parseDurationMs(input)).toThrow(/invalid duration/);
  });
});

describe('parseListenAddress', () => {
  it('defaults the host when only a port is given', () => {
    expect(parseListenAddress(':8080')).toEqual({
      host: '0.0.0.0',
      port: 8080,
    });
  });

  it('keeps an explicit host', () => {
    expect(parseListenAddress('127.0.0.1:9000')).toEqual({
      host: '127.0.0.1',
      port: 9000,
    });
  });

  it.each(['8080', ':0', ':70000', ':abc'])('rejects %j', (input) => {
    expect(() => parseListenAddress(input)).toThrow(/invalid listen address/);
  });
});

describe('loadApiConfig', () => {
  it('applies defaults', () => {
    expect(loadApiConfig({})).toEqual({
      LOG_LEVEL: 'info',
      SHUTDOWN_TIMEOUT: 25_000,
      API_ADDR: { host: '0.0.0.0', port: 8080 },
    });
  });

  it('lists every invalid variable at once', () => {
    expect(() =>
      loadApiConfig({ LOG_LEVEL: 'loud', SHUTDOWN_TIMEOUT: 'soon' }),
    ).toThrow(
      /LOG_LEVEL[\s\S]*SHUTDOWN_TIMEOUT|SHUTDOWN_TIMEOUT[\s\S]*LOG_LEVEL/,
    );
  });
});
