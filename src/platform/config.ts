import { z } from 'zod';

/** Dạng hợp lệ của thời lượng: số nguyên + đơn vị (ms, s, m, h). */
const DURATION_PATTERN = /^(\d+)(ms|s|m|h)$/;
/** Số mili giây của mỗi đơn vị thời lượng. */
const MS_PER_UNIT = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;

/** Đổi chuỗi thời lượng như "100ms", "25s", "5m", "2h" ra số mili giây. Sai định dạng → ném lỗi. */
export function parseDurationMs(value: string): number {
  const match = DURATION_PATTERN.exec(value);
  if (!match) {
    throw new Error(
      `invalid duration "${value}" (expected e.g. 100ms, 25s, 5m, 2h)`,
    );
  }
  // match[1] là phần số, match[2] là đơn vị (hai nhóm trong ngoặc của DURATION_PATTERN).
  const unit = match[2] as keyof typeof MS_PER_UNIT;
  return Number(match[1]) * MS_PER_UNIT[unit];
}

/**
 * Đọc địa chỉ lắng nghe dạng ":8080" hoặc "127.0.0.1:8080" ra `{ host, port }`.
 * Không ghi host thì nghe trên mọi địa chỉ mạng (0.0.0.0). Cổng phải là số nguyên 1..65535,
 * sai thì ném lỗi.
 */
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

/**
 * Kiểu zod cho biến môi trường dạng thời lượng: nhận chuỗi, đổi ra mili giây.
 * Chuỗi sai thì ghi nhận thành một lỗi của zod (không ném ngay), để gom chung với lỗi khác.
 */
const duration = z.string().transform((value, ctx) => {
  try {
    return parseDurationMs(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: (error as Error).message });
    return z.NEVER;
  }
});

/** Kiểu zod cho biến môi trường dạng địa chỉ lắng nghe; xử lý lỗi giống `duration`. */
const listenAddress = z.string().transform((value, ctx) => {
  try {
    return parseListenAddress(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: (error as Error).message });
    return z.NEVER;
  }
});

/** Biến môi trường mà mọi tiến trình đều dùng; không đặt thì lấy giá trị mặc định. */
const commonSchema = z.object({
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  SHUTDOWN_TIMEOUT: duration.default(parseDurationMs('25s')),
});

/** Số nguyên >= 1 đọc từ biến môi trường (chuỗi), không đặt thì lấy `fallback`. */
const positiveInt = (fallback: number) =>
  z.coerce.number().int().min(1).default(fallback);

/**
 * Các biến kết nối Postgres dùng chung cho mọi tiến trình có database.
 * `defaultPoolSize` khác nhau theo tiến trình: api cần nhiều kết nối, CLI chỉ cần 1.
 * Timeout phía server giúp Postgres tự hủy câu lệnh chạy quá lâu (NODE-02).
 */
function databaseFields(defaultPoolSize: number) {
  return {
    DATABASE_URL: z.url(),
    DB_POOL_SIZE: positiveInt(defaultPoolSize),
    DB_STATEMENT_TIMEOUT: duration.default(parseDurationMs('5s')),
    DB_IDLE_TX_TIMEOUT: duration.default(parseDurationMs('30s')),
  };
}

/** Số kết nối Postgres mặc định của tiến trình `api`. */
const API_DEFAULT_POOL_SIZE = 10;
/** Mặc định của `MAX_BODY_BYTES`: 256 KiB. */
const DEFAULT_MAX_BODY_BYTES = 262_144;

/** Cấu hình của tiến trình `api`: địa chỉ lắng nghe (mặc định :8080), giới hạn body và Postgres. */
const apiSchema = commonSchema.extend({
  API_ADDR: listenAddress.default(parseListenAddress(':8080')),
  MAX_BODY_BYTES: positiveInt(DEFAULT_MAX_BODY_BYTES),
  ...databaseFields(API_DEFAULT_POOL_SIZE),
});

/** Cấu hình của các tiến trình CLI cần Postgres (`migrate`, `admin`): pool mặc định 1 kết nối. */
const databaseSchema = commonSchema.extend(databaseFields(1));

/** Kiểu TypeScript của cấu hình, suy ra tự động từ schema tương ứng ở trên. */
export type CommonConfig = z.infer<typeof commonSchema>;
export type ApiConfig = z.infer<typeof apiSchema>;
export type DatabaseConfig = z.infer<typeof databaseSchema>;

/**
 * Kiểm tra biến môi trường `env` theo `schema` và trả về cấu hình đã đổi kiểu.
 * Sai thì ném MỘT lỗi liệt kê TẤT CẢ biến sai cùng lúc, để sửa một lần là xong (DEP-10).
 */
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

/** Đọc và kiểm tra cấu hình của tiến trình `api`. */
export function loadApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  return load(apiSchema, env);
}

/** Đọc và kiểm tra cấu hình của các tiến trình cần Postgres (`migrate`, `admin`). */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv): DatabaseConfig {
  return load(databaseSchema, env);
}
