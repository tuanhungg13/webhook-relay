import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import type { Logger } from '../../platform/logger.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
// Arbitrary constant shared by every runner, so only one applies migrations at a time.
const MIGRATION_LOCK_KEY = 7_420_001;

/**
 * Applies pending `migrations/*.sql` files in name order, each in its own transaction, and
 * returns the names applied. Holds a session advisory lock so concurrent runners are safe.
 */
export async function runMigrations(
  pool: pg.Pool,
  logger: Logger,
): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      return await applyPending(client, logger);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function applyPending(
  client: pg.PoolClient,
  logger: Logger,
): Promise<string[]> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const { rows } = await client.query<{ name: string }>(
    'SELECT name FROM schema_migrations',
  );
  const applied = new Set(rows.map((row) => row.name));
  const pending = (await readdir(MIGRATIONS_DIR))
    .filter((file) => file.endsWith('.sql') && !applied.has(file))
    .sort();

  for (const file of pending) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await inTransaction(client, async () => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [
        file,
      ]);
    });
    logger.info({ migration: file }, 'migration applied');
  }
  return pending;
}

async function inTransaction(
  client: pg.PoolClient,
  work: () => Promise<void>,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await work();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
