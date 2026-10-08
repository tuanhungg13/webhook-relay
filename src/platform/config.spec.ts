import {
  loadApiConfig,
  loadDatabaseConfig,
  loadWorkerConfig,
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
  const APP_ENV = 'development';

  it('applies defaults', () => {
    expect(loadApiConfig({ DATABASE_URL, APP_ENV })).toEqual({
      APP_ENV,
      ALLOW_INSECURE_HTTP: false,
      SSRF_ALLOWLIST: '',
      ENDPOINTS_PER_CUSTOMER_MAX: 20,
      SECRET_ROTATION_GRACE: 86_400_000,
      IDEMPOTENCY_TTL: 86_400_000,
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
    expect(() => loadApiConfig({ APP_ENV })).toThrow(/DATABASE_URL/);
  });

  it('requires APP_ENV', () => {
    expect(() => loadApiConfig({ DATABASE_URL })).toThrow(/APP_ENV/);
  });

  it('reads ALLOW_INSECURE_HTTP=false as false, not as a truthy string', () => {
    const read = (value: string) =>
      loadApiConfig({ DATABASE_URL, APP_ENV, ALLOW_INSECURE_HTTP: value })
        .ALLOW_INSECURE_HTTP;
    expect(read('false')).toBe(false);
    expect(read('true')).toBe(true);
    expect(() => read('yes')).toThrow(/ALLOW_INSECURE_HTTP/);
  });

  it('refuses ALLOW_INSECURE_HTTP in production, listed with the other errors (SEC-05, DEP-10)', () => {
    expect(() =>
      loadApiConfig({
        DATABASE_URL,
        APP_ENV: 'production',
        ALLOW_INSECURE_HTTP: 'true',
        DB_POOL_SIZE: '0',
      }),
    ).toThrow(
      /(?=[\s\S]*DB_POOL_SIZE)(?=[\s\S]*ALLOW_INSECURE_HTTP.*production)/,
    );
  });

  it('accepts a CIDR allowlist outside production, rejects bad items and production use (SEC-05)', () => {
    const load = (env: Record<string, string>) =>
      loadApiConfig({ DATABASE_URL, APP_ENV, ...env }).SSRF_ALLOWLIST;
    expect(load({ SSRF_ALLOWLIST: '172.20.0.0/16, fd00::/8' })).toBe(
      '172.20.0.0/16, fd00::/8',
    );
    expect(() => load({ SSRF_ALLOWLIST: '10.0.0.1' })).toThrow(
      /SSRF_ALLOWLIST/,
    );
    expect(() =>
      loadApiConfig({
        DATABASE_URL,
        APP_ENV: 'production',
        SSRF_ALLOWLIST: '172.20.0.0/16',
      }),
    ).toThrow(/SSRF_ALLOWLIST.*production/);
    expect(
      loadApiConfig({ DATABASE_URL, APP_ENV: 'production', SSRF_ALLOWLIST: '' })
        .SSRF_ALLOWLIST,
    ).toBe('');
  });

  it('lists every invalid variable at once', () => {
    expect(() =>
      loadApiConfig({
        DATABASE_URL,
        APP_ENV,
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

describe('loadWorkerConfig', () => {
  const APP_ENV = 'development';
  const load = (env: Record<string, string> = {}) =>
    loadWorkerConfig({ DATABASE_URL, APP_ENV, ...env });

  it('applies the spec 13 defaults (U4)', () => {
    expect(load()).toEqual({
      APP_ENV,
      ALLOW_INSECURE_HTTP: false,
      SSRF_ALLOWLIST: '',
      WORKER_CONCURRENCY: 200,
      WORKER_IDLE_SLEEP: 200,
      REQUEST_TIMEOUT: 10_000,
      CONNECT_TIMEOUT: 3_000,
      LEASE_DURATION: 30_000,
      MAX_ATTEMPTS: 8,
      RETRY_DELAYS: [
        5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000,
        36_000_000,
      ],
      LOG_LEVEL: 'info',
      SHUTDOWN_TIMEOUT: 25_000,
      DATABASE_URL,
      DB_POOL_SIZE: 20,
      DB_STATEMENT_TIMEOUT: 5_000,
      DB_IDLE_TX_TIMEOUT: 30_000,
    });
  });

  it('accepts shortened millisecond delays for tests (RTY-03)', () => {
    expect(
      load({ RETRY_DELAYS: '20ms, 20ms', MAX_ATTEMPTS: '3' }).RETRY_DELAYS,
    ).toEqual([20, 20]);
  });

  it('names the bad item of RETRY_DELAYS', () => {
    expect(() => load({ RETRY_DELAYS: '5s,soon', MAX_ATTEMPTS: '3' })).toThrow(
      /RETRY_DELAYS.*"soon"/,
    );
  });

  it('requires MAX_ATTEMPTS = RETRY_DELAYS + 1 (U4)', () => {
    expect(() => load({ RETRY_DELAYS: '1s,1s,1s,1s,1s,1s' })).toThrow(
      /MAX_ATTEMPTS/,
    );
  });

  it('requires LEASE_DURATION >= REQUEST_TIMEOUT + 15s (WRK-03, U4)', () => {
    expect(() => load({ LEASE_DURATION: '20s' })).toThrow(/LEASE_DURATION/);
    expect(load({ LEASE_DURATION: '25s' }).LEASE_DURATION).toBe(25_000);
  });

  it('requires CONNECT_TIMEOUT < REQUEST_TIMEOUT (U4)', () => {
    expect(() => load({ CONNECT_TIMEOUT: '10s' })).toThrow(/CONNECT_TIMEOUT/);
  });

  it('refuses ALLOW_INSECURE_HTTP and SSRF_ALLOWLIST in production (SEC-05, U4)', () => {
    expect(() =>
      load({ APP_ENV: 'production', ALLOW_INSECURE_HTTP: 'true' }),
    ).toThrow(/ALLOW_INSECURE_HTTP.*production/);
    expect(() =>
      load({ APP_ENV: 'production', SSRF_ALLOWLIST: '10.0.0.0/8' }),
    ).toThrow(/SSRF_ALLOWLIST.*production/);
  });

  it('lists every invalid variable at once (DEP-10, U4)', () => {
    expect(() =>
      load({
        WORKER_CONCURRENCY: '0',
        LEASE_DURATION: '20s',
        CONNECT_TIMEOUT: '10s',
        RETRY_DELAYS: '1s',
      }),
    ).toThrow(
      /(?=[\s\S]*WORKER_CONCURRENCY)(?=[\s\S]*LEASE_DURATION)(?=[\s\S]*CONNECT_TIMEOUT)(?=[\s\S]*MAX_ATTEMPTS)/,
    );
  });
});
