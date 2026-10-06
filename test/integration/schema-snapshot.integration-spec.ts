import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { runMigrations } from '../../src/adapters/postgres/migrator.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from './postgres-test-db.js';

const SNAPSHOT_PATH = '../../src/adapters/postgres/schema.sql';
// pg_dump otherwise writes a random \restrict key, which would change the file on every run.
const FIXED_RESTRICT_KEY = 'webhookrelay';

/**
 * `schema.sql` is the generated overview of the current schema: every migration applied to an
 * empty database, then dumped. This test fails when a migration changes the schema without the
 * snapshot being regenerated (`pnpm db:schema`).
 */
describe('schema snapshot', () => {
  it('matches the schema produced by all migrations', async () => {
    const db = await createTestDatabase();
    const pool = new pg.Pool({ connectionString: db.url, max: 1 });
    try {
      await runMigrations(
        pool,
        createLogger({ mode: 'test', level: 'silent' }),
      );
      await expect(await dumpSchema(db.name)).toMatchFileSnapshot(
        SNAPSHOT_PATH,
      );
    } finally {
      await pool.end();
      await db.drop();
    }
  });
});

/** Runs pg_dump inside the compose Postgres container, so its version matches the server. */
async function dumpSchema(database: string): Promise<string> {
  const { stdout } = await promisify(execFile)('docker', [
    'compose',
    '-f',
    'deploy/compose.yaml',
    'exec',
    '-T',
    'postgres',
    'pg_dump',
    '--username=whr',
    `--dbname=${database}`,
    '--schema-only',
    '--no-owner',
    '--no-privileges',
    `--restrict-key=${FIXED_RESTRICT_KEY}`,
    '--exclude-table=schema_migrations',
  ]);
  return stdout.replaceAll('\r\n', '\n');
}
