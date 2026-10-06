import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresAccessStore } from '../../src/adapters/postgres/access-store.js';
import { runMigrations } from '../../src/adapters/postgres/migrator.js';
import { runAdminCli } from '../../src/apps/admin/admin-cli.js';
import { hashApiKey } from '../../src/core/api-key.js';
import { idFromUuid, idToUuid, parseId } from '../../src/core/id.js';
import { createLogger } from '../../src/platform/logger.js';
import type { Clock } from '../../src/platform/clock.js';
import { createTestDatabase } from './postgres-test-db.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const fixedClock: Clock = { now: () => NOW };
const UNKNOWN_APP = idFromUuid('app', randomUUID());
const UNKNOWN_KEY = idFromUuid('apiKey', randomUUID());

describe('admin cli', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: pg.Pool;
  let run: (argv: string[]) => Promise<Record<string, unknown>>;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new pg.Pool({ connectionString: db.url, max: 2 });
    await runMigrations(pool, createLogger({ mode: 'test', level: 'silent' }));
    const store = new PostgresAccessStore(pool);
    run = (argv) => runAdminCli(argv, { store, clock: fixedClock });
  });

  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  async function createApp(): Promise<string> {
    const { app_id } = await run(['app', 'create', '--name', 'ShopX']);
    return app_id as string;
  }

  it('creates an app', async () => {
    const appId = await createApp();

    expect(parseId('app', appId)).toBe(appId);
    const { rows } = await pool.query(
      'SELECT name, created_at FROM apps WHERE id = $1',
      [idToUuid(parseId('app', appId)!)],
    );
    expect(rows).toEqual([{ name: 'ShopX', created_at: NOW }]);
  });

  it('rejects a blank app name', async () => {
    await expect(run(['app', 'create', '--name', '   '])).rejects.toThrow(
      /name/,
    );
  });

  it('issues a key and stores only its hash and prefix (SEC-11)', async () => {
    const appId = await createApp();
    const issued = await run(['key', 'issue', '--app', appId]);

    expect(issued.api_key).toMatch(/^sk_/);
    expect(issued.prefix).toBe((issued.api_key as string).slice(0, 8));
    const { rows } = await pool.query<Record<string, unknown>>(
      'SELECT * FROM api_keys WHERE id = $1',
      [idToUuid(parseId('apiKey', issued.key_id as string)!)],
    );
    expect(rows).toHaveLength(1);
    expect(
      (rows[0]!.key_hash as Buffer).equals(
        hashApiKey(issued.api_key as string),
      ),
    ).toBe(true);
    expect(Object.values(rows[0]!)).not.toContain(issued.api_key);
  });

  it('refuses to issue a key for an unknown app', async () => {
    await expect(run(['key', 'issue', '--app', UNKNOWN_APP])).rejects.toThrow(
      /not found/,
    );
  });

  it('revokes a key, and revoking again keeps the first revocation time', async () => {
    const appId = await createApp();
    const { key_id } = await run(['key', 'issue', '--app', appId]);

    expect(await run(['key', 'revoke', '--key', key_id as string])).toEqual({
      key_id,
      revoked_at: NOW.toISOString(),
    });
    const later: Clock = { now: () => new Date(NOW.getTime() + 60_000) };
    const again = await runAdminCli(
      ['key', 'revoke', '--key', key_id as string],
      {
        store: new PostgresAccessStore(pool),
        clock: later,
      },
    );
    expect(again.revoked_at).toBe(NOW.toISOString());
  });

  it('refuses to revoke an unknown or malformed key id', async () => {
    await expect(run(['key', 'revoke', '--key', UNKNOWN_KEY])).rejects.toThrow(
      /not found/,
    );
    await expect(
      run(['key', 'revoke', '--key', 'evt_whatever']),
    ).rejects.toThrow(/key id/);
  });

  it('converts ids between TypeID and UUID for debugging (D-17)', async () => {
    const uuid = '01890a5d-ac96-774b-bcce-b302099a8057';
    const encoded = await run(['id', 'encode', '--kind', 'event', uuid]);

    expect(encoded).toEqual({ id: 'evt_01h455vb4pex5vsknk084sn02q' });
    expect(
      await run(['id', 'decode', 'evt_01h455vb4pex5vsknk084sn02q']),
    ).toEqual({
      kind: 'event',
      uuid,
    });
  });

  it('explains usage on an unknown command', async () => {
    await expect(run(['app', 'delete'])).rejects.toThrow(/usage/i);
  });
});
