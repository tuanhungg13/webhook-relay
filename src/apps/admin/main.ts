import { PostgresAccessStore } from '../../adapters/postgres/access-store.js';
import { createPool } from '../../adapters/postgres/pool.js';
import { systemClock } from '../../platform/clock.js';
import { loadDatabaseConfig } from '../../platform/config.js';
import { exitOnFatalErrors } from '../../platform/lifecycle.js';
import { createLogger } from '../../platform/logger.js';
import { runAdminCli } from './admin-cli.js';

/**
 * Điểm khởi động của công cụ quản trị (`pnpm admin ...`).
 *
 * Đây là nơi "lắp ráp": tạo kết nối Postgres thật và đồng hồ thật, rồi giao cho `runAdminCli`
 * xử lý lệnh. Thành công thì in một dòng JSON ra stdout; thất bại thì xem `main().catch` bên dưới.
 */
async function main(): Promise<void> {
  // Đọc cấu hình từ biến môi trường; thiếu hoặc sai DATABASE_URL thì ném lỗi, dừng ngay.
  const config = loadDatabaseConfig(process.env);
  // Lỗi không ai bắt được thì ghi log rồi thoát, không để tiến trình chạy tiếp trong trạng thái hỏng.
  const logger = createLogger({ mode: 'admin', level: config.LOG_LEVEL });
  exitOnFatalErrors(logger);

  // Pool = nhóm kết nối tới Postgres, có timeout (NODE-02). CLI chạy một lệnh rồi thoát nên
  // pool mặc định chỉ 1 kết nối (DB_POOL_SIZE).
  const pool = createPool(config, logger);
  try {
    // process.argv = ['node', 'main.js', ...các từ người dùng gõ]; slice(2) bỏ hai phần tử đầu.
    const output = await runAdminCli(process.argv.slice(2), {
      store: new PostgresAccessStore(pool),
      clock: systemClock,
    });
    console.log(JSON.stringify(output));
  } finally {
    // Luôn đóng kết nối, kể cả khi lệnh lỗi; nếu không, tiến trình sẽ treo mà không thoát.
    await pool.end();
  }
}

// Lỗi của lệnh (sai tham số, không tìm thấy app...) chạy tới đây: in câu báo lỗi ra stderr
// và thoát với mã 1 để shell biết lệnh đã thất bại.
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
