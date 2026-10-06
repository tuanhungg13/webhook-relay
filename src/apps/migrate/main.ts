import pg from 'pg';
import { runMigrations } from '../../adapters/postgres/migrator.js';
import { loadMigrateConfig } from '../../platform/config.js';
import { exitOnFatalErrors } from '../../platform/lifecycle.js';
import { createLogger } from '../../platform/logger.js';

/** One-shot process: apply pending migrations, then exit (the `migrate` service of spec 13). */
async function main(): Promise<void> {
  const config = loadMigrateConfig(process.env);
  const logger = createLogger({ mode: 'migrate', level: config.LOG_LEVEL });
  exitOnFatalErrors(logger);

  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });
  try {
    const applied = await runMigrations(pool, logger);
    logger.info({ applied: applied.length }, 'migrations up to date');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // The logger may not exist yet (e.g. invalid configuration), so report on stderr.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
