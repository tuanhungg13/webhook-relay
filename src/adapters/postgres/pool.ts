import pg from 'pg';
import type { DatabaseConfig } from '../../platform/config.js';
import type { Logger } from '../../platform/logger.js';

/**
 * Thời gian tối đa chờ một kết nối: chờ slot trong pool hoặc mở kết nối mới.
 * `pg` mặc định là 0 (chờ vô hạn) nên Postgres treo thì request treo theo, vi phạm NODE-02.
 */
export const DB_CONNECT_TIMEOUT_MS = 5_000;

/** Phần của cấu hình mà `createPool` cần; `ApiConfig` và `DatabaseConfig` đều thỏa. */
export type PoolConfig = Pick<
  DatabaseConfig,
  | 'DATABASE_URL'
  | 'DB_POOL_SIZE'
  | 'DB_STATEMENT_TIMEOUT'
  | 'DB_IDLE_TX_TIMEOUT'
>;

/** Phần nới thêm cho `query_timeout` phía client so với `statement_timeout` phía server. */
const CLIENT_QUERY_TIMEOUT_MARGIN_MS = 1_000;

/**
 * Tạo nhóm kết nối (pool) tới Postgres, có giới hạn thời gian ở ba lớp (NODE-02):
 * - `connectionTimeoutMillis`: chờ slot hoặc mở kết nối.
 * - `statement_timeout`, `idle_in_transaction_session_timeout`: Postgres tự hủy câu lệnh
 *   chạy quá lâu hoặc transaction bỏ dở.
 * - `query_timeout`: phía client tự cắt khi mạng treo im lặng, trường hợp server không
 *   kịp báo gì. Đặt lớn hơn `statement_timeout` để bình thường server hủy trước.
 *
 * Dùng chung cho api, admin và migrate.
 */
export function createPool(config: PoolConfig, logger: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_SIZE,
    connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
    statement_timeout: config.DB_STATEMENT_TIMEOUT,
    idle_in_transaction_session_timeout: config.DB_IDLE_TX_TIMEOUT,
    query_timeout: config.DB_STATEMENT_TIMEOUT + CLIENT_QUERY_TIMEOUT_MARGIN_MS,
  });
  // Kết nối đang rảnh bị đứt (vd Postgres khởi động lại) phát sự kiện 'error' trên pool.
  // Không có ai lắng nghe thì Node ném lỗi ra ngoài và làm chết cả tiến trình.
  pool.on('error', (error) => {
    logger.warn({ err: error }, 'idle postgres client error');
  });
  return pool;
}
