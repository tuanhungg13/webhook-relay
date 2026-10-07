import { runMigrations } from '../../adapters/postgres/migrator.js';
import { createPool } from '../../adapters/postgres/pool.js';
import { loadDatabaseConfig } from '../../platform/config.js';
import { exitOnFatalErrors } from '../../platform/lifecycle.js';
import { createLogger } from '../../platform/logger.js';

/**
 * Tiến trình chạy một lần: áp dụng các migration (file SQL đổi cấu trúc database) chưa chạy,
 * rồi thoát. Đây là dịch vụ `migrate` ở spec 13.
 */
async function main(): Promise<void> {
  // Đọc cấu hình; thiếu hoặc sai DATABASE_URL thì ném lỗi, dừng ngay.
  const config = loadDatabaseConfig(process.env);
  const logger = createLogger({ mode: 'migrate', level: config.LOG_LEVEL });
  exitOnFatalErrors(logger);

  // Migration chạy lần lượt từng file nên pool mặc định 1 kết nối là đủ. Migration chạy lâu
  // (vd tạo chỉ mục bảng lớn) cần đặt DB_STATEMENT_TIMEOUT lớn hơn cho lần chạy đó.
  const pool = createPool(config, logger);
  try {
    const applied = await runMigrations(pool, logger);
    logger.info({ applied: applied.length }, 'migrations up to date');
  } finally {
    // Luôn đóng kết nối, kể cả khi migration lỗi, để tiến trình thoát được.
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // Lúc lỗi, logger có thể chưa kịp tạo (vd cấu hình sai), nên in thẳng ra stderr.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
