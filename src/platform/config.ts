import { z } from 'zod';

const DURATION_PATTERN = /^(\d+)(ms|s|m|h)$/;
const MS_PER_UNIT = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;

/** Parses durations written like "100ms", "25s", "5m", "2h" into milliseconds. */
export function parseDurationMs(value: string): number {
  const match = DURATION_PATTERN.exec(value);
  if (!match) {
    throw new Error(
      `invalid duration "${value}" (expected e.g. 100ms, 25s, 5m, 2h)`,
    );
  }
  const unit = match[2] as keyof typeof MS_PER_UNIT;
  return Number(match[1]) * MS_PER_UNIT[unit];
}

/** Parses a listen address such as ":8080" or "127.0.0.1:8080". */
export function parseListenAddress(value: string): {
  host: string;
  port: number;
} {
  const separator = value.lastIndexOf(':');
  const port = Number(value.slice(separator + 1));
  if (
    separator === -1 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error(`invalid listen address "${value}" (expected e.g. :8080)`);
  }
  return { host: value.slice(0, separator) || '0.0.0.0', port };
}

const duration = z.string().transform((value, ctx) => {
  try {
    return parseDurationMs(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: (error as Error).message });
    return z.NEVER;
  }
});

const listenAddress = z.string().transform((value, ctx) => {
  try {
    return parseListenAddress(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: (error as Error).message });
    return z.NEVER;
  }
});

const commonSchema = z.object({
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  SHUTDOWN_TIMEOUT: duration.default(parseDurationMs('25s')),
});

const apiSchema = commonSchema.extend({
  API_ADDR: listenAddress.default(parseListenAddress(':8080')),
});

const migrateSchema = commonSchema.extend({
  DATABASE_URL: z.url(),
});

export type CommonConfig = z.infer<typeof commonSchema>;
export type ApiConfig = z.infer<typeof apiSchema>;
export type MigrateConfig = z.infer<typeof migrateSchema>;

/** Fails fast with every invalid variable listed (DEP-10). */
function load<T>(schema: z.ZodType<T>, env: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`invalid configuration:\n${problems}`);
  }
  return result.data;
}

export function loadApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  return load(apiSchema, env);
}

export function loadMigrateConfig(env: NodeJS.ProcessEnv): MigrateConfig {
  return load(migrateSchema, env);
}
