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

/** Mặc định của `ENDPOINTS_PER_CUSTOMER_MAX` (API-30). */
const DEFAULT_ENDPOINTS_PER_CUSTOMER_MAX = 20;

/**
 * Kiểu zod cho biến bật/tắt: chỉ nhận đúng chuỗi `'true'` hoặc `'false'`.
 * Không dùng `z.coerce.boolean()` vì nó đổi mọi chuỗi khác rỗng, kể cả `"false"`, thành `true`.
 */
const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

/** Dạng sơ bộ của một phần tử CIDR (`10.0.0.0/8`, `fd00::/8`); parse đầy đủ nằm ở `core/ip-policy`. */
const CIDR_ITEM_PATTERN = /^[0-9a-fA-F:.]+\/\d{1,3}$/;

/**
 * Kiểu zod cho `SSRF_ALLOWLIST`: danh sách CIDR cách nhau bởi dấu phẩy, giữ nguyên dạng chuỗi
 * (`platform` không import `core`; `apps` mới đổi ra `Cidr[]` và bắt phần tử sai tinh vi hơn).
 */
const cidrList = z
  .string()
  .default('')
  .refine(
    (value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '')
        .every((item) => CIDR_ITEM_PATTERN.test(item)),
    { message: 'must be a comma-separated list of CIDRs, e.g. 172.20.0.0/16' },
  );

/** Giá trị được phép của `APP_ENV`. */
const appEnv = z.enum(['development', 'test', 'production']);

/** Phần cấu hình mà luật SEC-05 đọc; api và worker đều có. */
interface InsecureHttpConfig {
  APP_ENV: z.infer<typeof appEnv>;
  ALLOW_INSECURE_HTTP: boolean;
  SSRF_ALLOWLIST: string;
}

/**
 * Gắn luật chéo SEC-05 vào `schema` (dùng chung cho api và worker): `APP_ENV=production` mà bật
 * `ALLOW_INSECURE_HTTP` hoặc đặt `SSRF_ALLOWLIST` khác rỗng thì từ chối khởi động.
 *
 * `when: () => true` bắt zod chạy luật này cả khi biến khác đã sai, để lỗi nằm chung một danh
 * sách (DEP-10); mặc định zod bỏ qua refine khi object đã có lỗi.
 */
function refineInsecureHttp<S extends z.ZodType<InsecureHttpConfig>>(
  schema: S,
) {
  return schema
    .refine(
      (config) =>
        !(config.APP_ENV === 'production' && config.ALLOW_INSECURE_HTTP),
      {
        path: ['ALLOW_INSECURE_HTTP'],
        message: 'must not be true when APP_ENV is production (SEC-05)',
        when: () => true,
      },
    )
    .refine(
      (config) =>
        !(
          config.APP_ENV === 'production' && config.SSRF_ALLOWLIST.trim() !== ''
        ),
      {
        path: ['SSRF_ALLOWLIST'],
        message: 'must be empty when APP_ENV is production (SEC-05)',
        when: () => true,
      },
    );
}

/**
 * Cấu hình của tiến trình `api`: môi trường chạy, địa chỉ lắng nghe (mặc định :8080), giới hạn
 * body, Postgres và các giới hạn của endpoint; kèm luật SEC-05.
 */
const apiSchema = refineInsecureHttp(
  commonSchema.extend({
    APP_ENV: appEnv,
    API_ADDR: listenAddress.default(parseListenAddress(':8080')),
    MAX_BODY_BYTES: positiveInt(DEFAULT_MAX_BODY_BYTES),
    ALLOW_INSECURE_HTTP: flag,
    SSRF_ALLOWLIST: cidrList,
    ENDPOINTS_PER_CUSTOMER_MAX: positiveInt(DEFAULT_ENDPOINTS_PER_CUSTOMER_MAX),
    SECRET_ROTATION_GRACE: duration.default(parseDurationMs('24h')),
    IDEMPOTENCY_TTL: duration.default(parseDurationMs('24h')),
    ...databaseFields(API_DEFAULT_POOL_SIZE),
  }),
);

/**
 * Đổi danh sách thời lượng cách nhau bởi dấu phẩy (`"5s, 5m, 2h"`) ra mảng mili giây; phần tử
 * rỗng bị bỏ qua. Phần tử sai thì ném lỗi của `parseDurationMs`, có nêu đúng phần tử đó.
 */
function parseDurationList(value: string): number[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .map(parseDurationMs);
}

/** Kiểu zod cho biến môi trường dạng danh sách thời lượng; xử lý lỗi giống `duration`. */
const durationList = z.string().transform((value, ctx) => {
  try {
    return parseDurationList(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: (error as Error).message });
    return z.NEVER;
  }
});

/** Số kết nối Postgres mặc định của tiến trình `worker` (spec 13). */
const WORKER_DEFAULT_POOL_SIZE = 20;
/** Mặc định của `WORKER_CONCURRENCY`: số delivery gửi song song tối đa của một worker. */
const DEFAULT_WORKER_CONCURRENCY = 200;
/** Mặc định của `MAX_ATTEMPTS` (spec 08). */
const DEFAULT_MAX_ATTEMPTS = 8;
/** Lịch retry mặc định của spec 08: delay sau attempt lỗi thứ 1, 2, ... */
const DEFAULT_RETRY_DELAYS = '5s,5m,30m,2h,5h,10h,10h';
/** Lease phải dài hơn `REQUEST_TIMEOUT` ít nhất chừng này (WRK-03). */
const LEASE_MARGIN_MS = 15_000;

/**
 * Cấu hình của tiến trình `worker`: gửi song song, ngủ khi hết việc (chỉ giai đoạn 1), timeout
 * HTTP, lease, lịch retry, Postgres; kèm SEC-05 và các ràng buộc khởi động của spec 13.
 *
 * Các luật chéo chạy cả khi biến khác đã sai (`when: () => true`, DEP-10), nên giá trị có thể là
 * giá trị hỏng (`undefined`): so sánh với `undefined` luôn ra `false` nên luật viết dạng
 * `!(sai)` để im lặng, còn lỗi gốc của biến đó đã được báo riêng.
 */
const workerSchema = refineInsecureHttp(
  commonSchema.extend({
    APP_ENV: appEnv,
    ALLOW_INSECURE_HTTP: flag,
    SSRF_ALLOWLIST: cidrList,
    WORKER_CONCURRENCY: positiveInt(DEFAULT_WORKER_CONCURRENCY),
    WORKER_IDLE_SLEEP: duration.default(parseDurationMs('200ms')),
    REQUEST_TIMEOUT: duration.default(parseDurationMs('10s')),
    CONNECT_TIMEOUT: duration.default(parseDurationMs('3s')),
    LEASE_DURATION: duration.default(parseDurationMs('30s')),
    MAX_ATTEMPTS: positiveInt(DEFAULT_MAX_ATTEMPTS),
    RETRY_DELAYS: durationList.default(parseDurationList(DEFAULT_RETRY_DELAYS)),
    ...databaseFields(WORKER_DEFAULT_POOL_SIZE),
  }),
)
  .refine(
    (config) =>
      // RETRY_DELAYS sai thì không phải mảng; lỗi đó đã được báo riêng.
      !Array.isArray(config.RETRY_DELAYS) ||
      config.MAX_ATTEMPTS === config.RETRY_DELAYS.length + 1,
    {
      path: ['MAX_ATTEMPTS'],
      message: 'must equal the number of RETRY_DELAYS + 1',
      when: () => true,
    },
  )
  .refine(
    (config) =>
      !(config.LEASE_DURATION < config.REQUEST_TIMEOUT + LEASE_MARGIN_MS),
    {
      path: ['LEASE_DURATION'],
      message: 'must be at least REQUEST_TIMEOUT + 15s (WRK-03)',
      when: () => true,
    },
  )
  .refine((config) => !(config.CONNECT_TIMEOUT >= config.REQUEST_TIMEOUT), {
    path: ['CONNECT_TIMEOUT'],
    message: 'must be less than REQUEST_TIMEOUT',
    when: () => true,
  });

/** Cấu hình của các tiến trình CLI cần Postgres (`migrate`, `admin`): pool mặc định 1 kết nối. */
const databaseSchema = commonSchema.extend(databaseFields(1));

/** Kiểu TypeScript của cấu hình, suy ra tự động từ schema tương ứng ở trên. */
export type CommonConfig = z.infer<typeof commonSchema>;
export type ApiConfig = z.infer<typeof apiSchema>;
export type DatabaseConfig = z.infer<typeof databaseSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;

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

/** Đọc và kiểm tra cấu hình của tiến trình `worker`. */
export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  return load(workerSchema, env);
}
