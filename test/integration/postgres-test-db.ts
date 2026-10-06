import { randomBytes } from 'node:crypto';
import pg from 'pg';

const DEFAULT_ADMIN_URL = 'postgres://whr:whr@localhost:5432/whr';

/**
 * TST-02: integration tests run on a real Postgres (`pnpm db:up`). Each suite gets its own
 * throwaway database so suites never see each other's rows.
 */
export async function createTestDatabase(): Promise<{
  name: string;
  url: string;
  drop: () => Promise<void>;
}> {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? DEFAULT_ADMIN_URL;
  const name = `whr_test_${randomBytes(6).toString('hex')}`;
  await withAdminClient(adminUrl, (client) =>
    client.query(`CREATE DATABASE ${name}`),
  );

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    name,
    url: url.toString(),
    drop: () =>
      withAdminClient(adminUrl, (client) =>
        client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
      ),
  };
}

async function withAdminClient(
  adminUrl: string,
  run: (client: pg.Client) => Promise<unknown>,
): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await run(client);
  } finally {
    await client.end();
  }
}
