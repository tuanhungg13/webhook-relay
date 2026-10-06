import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { runMigrations } from '../../src/adapters/postgres/migrator.js';
import { createLogger } from '../../src/platform/logger.js';
import { createTestDatabase } from './postgres-test-db.js';

const SNAPSHOT_DIR = '../../src/adapters/postgres';
// pg_dump otherwise writes a random \restrict key, which would change the file on every run.
const FIXED_RESTRICT_KEY = 'webhookrelay';
const ENUMS_QUERY = `SELECT t.typname AS enum, string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) AS values
  FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
  GROUP BY t.typname ORDER BY t.typname`;

/**
 * Two generated snapshots of the schema that all migrations produce on an empty database:
 * - `schema.txt`: for reading — enums, then one psql `\d` block per table (columns, indexes,
 *   checks, foreign keys and who references the table, all together).
 * - `schema.sql`: pg_dump output — exact and re-runnable, catches what `\d` does not show.
 * They fail when a migration changes the schema without `pnpm db:schema` being run.
 */
describe('schema snapshot', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: pg.Pool;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new pg.Pool({ connectionString: db.url, max: 1 });
    await runMigrations(pool, createLogger({ mode: 'test', level: 'silent' }));
  });

  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  it('schema.txt describes every table', async () => {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
       ORDER BY tablename`,
    );
    const describeTables = rows.flatMap((row) => ['-c', `\\d ${row.name}`]);
    const overview = await execInPostgresContainer([
      'psql',
      '--username=whr',
      `--dbname=${db.name}`,
      '--no-psqlrc',
      '--quiet',
      '--pset=footer=off',
      '-c',
      ENUMS_QUERY,
      ...describeTables,
    ]);

    await expect(overview).toMatchFileSnapshot(`${SNAPSHOT_DIR}/schema.txt`);
  });

  it('schema.sql is the exact dump', async () => {
    const dump = await execInPostgresContainer([
      'pg_dump',
      '--username=whr',
      `--dbname=${db.name}`,
      '--schema-only',
      '--no-owner',
      '--no-privileges',
      `--restrict-key=${FIXED_RESTRICT_KEY}`,
      '--exclude-table=schema_migrations',
    ]);

    await expect(dump).toMatchFileSnapshot(`${SNAPSHOT_DIR}/schema.sql`);
  });
});

/** Runs a Postgres client tool inside the compose container, so its version matches the server. */
async function execInPostgresContainer(command: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)('docker', [
    'compose',
    '-f',
    'deploy/compose.yaml',
    'exec',
    '-T',
    'postgres',
    ...command,
  ]);
  return stdout.replaceAll('\r\n', '\n');
}
