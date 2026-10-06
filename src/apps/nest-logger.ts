import type { LoggerService } from '@nestjs/common';
import type { Logger } from '../platform/logger.js';

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Routes NestJS framework logs into the platform's JSON logger.
 * Nest passes its context (e.g. "RoutesResolver") as the last optional parameter,
 * and `error` may receive a stack trace before it.
 */
export class NestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    const stack = params.length >= 2 ? params[0] : undefined;
    this.write(
      'error',
      message,
      params,
      typeof stack === 'string' ? { stack } : {},
    );
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('trace', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  private write(
    level: Level,
    message: unknown,
    params: unknown[],
    extra: object = {},
  ): void {
    const context = params.at(-1);
    const fields = {
      ...extra,
      ...(typeof context === 'string' ? { context } : {}),
    };

    if (message instanceof Error) {
      this.logger[level]({ ...fields, err: message }, message.message);
    } else if (typeof message === 'object' && message !== null) {
      this.logger[level]({ ...fields, data: message });
    } else {
      this.logger[level](fields, String(message));
    }
  }
}
