import { pino, type Logger } from 'pino';

export type { Logger };

/** Structured JSON logger with the standard fields of spec 11: time, level, msg, mode. */
export function createLogger(options: { mode: string; level: string }): Logger {
  return pino({
    level: options.level,
    base: { mode: options.mode },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}
