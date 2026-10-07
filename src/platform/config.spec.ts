import {
  loadApiConfig,
  loadDatabaseConfig,
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

const DATABASE_URL = 'postgres://whr:whr@localhost:5432/whr';

describe('loadApiConfig', () => {
  it('applies defaults', () => {
    expect(loadApiConfig({ DATABASE_URL })).toEqual({
      LOG_LEVEL: 'info',
      SHUTDOWN_TIMEOUT: 25_000,
      API_ADDR: { host: '0.0.0.0', port: 8080 },
      MAX_BODY_BYTES: 262_144,
      DATABASE_URL,
      DB_POOL_SIZE: 10,
      DB_STATEMENT_TIMEOUT: 5_000,
      DB_IDLE_TX_TIMEOUT: 30_000,
    });
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadApiConfig({})).toThrow(/DATABASE_URL/);
  });

  it('lists every invalid variable at once', () => {
    expect(() =>
      loadApiConfig({
        DATABASE_URL,
        LOG_LEVEL: 'loud',
        SHUTDOWN_TIMEOUT: 'soon',
        DB_POOL_SIZE: '0',
        MAX_BODY_BYTES: 'abc',
      }),
    ).toThrow(
      /(?=[\s\S]*LOG_LEVEL)(?=[\s\S]*SHUTDOWN_TIMEOUT)(?=[\s\S]*DB_POOL_SIZE)(?=[\s\S]*MAX_BODY_BYTES)/,
    );
  });
});

describe('loadDatabaseConfig', () => {
  it('requires DATABASE_URL', () => {
    expect(() => loadDatabaseConfig({})).toThrow(/DATABASE_URL/);
  });

  it('defaults the pool to a single connection', () => {
    const config = loadDatabaseConfig({ DATABASE_URL });
    expect(config.DB_POOL_SIZE).toBe(1);
    expect(config.DB_STATEMENT_TIMEOUT).toBe(5_000);
  });

  it('accepts a postgres URL', () => {
    expect(
      loadDatabaseConfig({
        DATABASE_URL: 'postgres://whr:whr@localhost:5432/whr',
      }).DATABASE_URL,
    ).toBe('postgres://whr:whr@localhost:5432/whr');
  });
});
