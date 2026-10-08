import { pino, type Logger } from 'pino';

export type { Logger };

const STDOUT_FD = 1;

/**
 * Structured JSON logger with the standard fields of spec 11: time, level, msg, mode.
 * Writes to stdout synchronously (OBS-03): pino's default destination is asynchronous, so a
 * hard kill (SIGKILL, OOM) would lose the last lines — the ones explaining why we died.
 */
export function createLogger(options: { mode: string; level: string }): Logger {
  return pino(
    {
      level: options.level,
      base: { mode: options.mode },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
      },
    },
    pino.destination({ dest: STDOUT_FD, sync: true }),
  );
}

/**
 * Chỉ lấy `code` và `message` của lỗi để log. Không log nguyên đối tượng lỗi: lỗi ràng buộc của
 * `pg` có trường `detail` chứa cả dòng dữ liệu (có thể có secret), không được vào log (SEC-13).
 */
export function errorFields(error: unknown): {
  code?: string;
  message: string;
} {
  if (!(error instanceof Error)) return { message: String(error) };
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string'
    ? { code, message: error.message }
    : { message: error.message };
}
