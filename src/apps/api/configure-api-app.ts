import type { INestApplication, NestApplicationOptions } from '@nestjs/common';
import type { Logger } from '../../platform/logger.js';
import { ApiExceptionFilter } from './http/api-exception.filter.js';
import { jsonBodyMiddleware } from './http/json-body.js';
import { requestIdMiddleware } from './http/request-id.js';

/**
 * Tùy chọn khi tạo app Nest: tắt body-parser mặc định (nó không dừng đọc khi body vượt
 * giới hạn, D-16) để `jsonBodyMiddleware` tự đọc body.
 */
export const API_APP_OPTIONS: NestApplicationOptions = { bodyParser: false };

/**
 * Gắn phần HTTP chung vào app `api`: mã request, đọc body có giới hạn, filter lỗi toàn cục.
 *
 * `main` và test cùng gọi hàm này để hai bên không lệch nhau. Thứ tự gắn là thứ tự chạy:
 * mã request trước để mọi phản hồi, kể cả lỗi, đều có `X-Request-Id`.
 * Filter đăng ký bằng `useGlobalFilters` vì đường này bắt được cả lỗi từ middleware.
 */
export function configureApiApp(
  app: INestApplication,
  options: { logger: Logger; maxBodyBytes: number },
): void {
  app.use(requestIdMiddleware);
  app.use(jsonBodyMiddleware(options.maxBodyBytes));
  app.useGlobalFilters(new ApiExceptionFilter(options.logger));
}
