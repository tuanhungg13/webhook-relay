import { Controller, Get, Inject } from '@nestjs/common';
import pg from 'pg';
import { ApiError } from '../../platform/http/api-error.js';
import type { Logger } from '../../platform/logger.js';
import { LOGGER } from './logger.token.js';
import { Public } from './http/public.js';

/**
 * Readiness probe (API-41): 200 khi `api` nối được Postgres, 503 khi không.
 * Chỉ kiểm Postgres, KHÔNG kiểm Redis: API vẫn nhận được sự kiện khi Redis chết (D-06).
 *
 * Bộ cân bằng tải gọi route này để quyết định có giữ api trong vòng phục vụ không.
 */
@Controller()
export class ReadinessController {
  constructor(
    @Inject(pg.Pool) private readonly pool: pg.Pool,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Chạy `SELECT 1` để thử kết nối Postgres; lỗi thì trả 503 `unavailable`. */
  @Public()
  @Get('readyz')
  async readyz(): Promise<{ status: 'ok' }> {
    try {
      await this.pool.query('SELECT 1');
    } catch (error) {
      // Mức warn vì probe chạy liên tục: Postgres chết thì lỗi lặp lại mỗi vài giây.
      this.logger.warn({ err: error }, 'readiness check failed');
      throw new ApiError(503, 'unavailable', 'database is not reachable');
    }
    return { status: 'ok' };
  }
}
