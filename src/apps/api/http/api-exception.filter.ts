import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  NotFoundException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { isDatabaseUnavailable } from '../../../adapters/postgres/errors.js';
import { ApiError } from '../../../platform/http/api-error.js';
import type { Logger } from '../../../platform/logger.js';
import { REQUEST_ID_HEADER } from './request-id.js';

/** Dạng JSON của mọi lỗi trả về cho App (spec 05). */
interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown };
}

/** Message chung cho lỗi không lường trước: không lộ chi tiết nội bộ (spec 05). */
const INTERNAL_MESSAGE = 'internal server error';

/**
 * Filter toàn cục: đổi MỌI lỗi (từ middleware, từ route không khớp, từ handler) thành
 * phản hồi `{ error: { code, message, details } }`.
 *
 * - `ApiError` → status và code của nó;
 * - `NotFoundException` (không khớp route) → 404 `not_found`;
 * - lỗi Postgres không dùng được → 503 `unavailable`, log `error` (ING-05);
 * - còn lại → 500 `internal`, log `error` kèm stack, KHÔNG trả chi tiết cho client.
 *
 * Log chỉ gồm `request_id`, `method`, `path`, `err`; không bao giờ log header vì có
 * `Authorization` (SEC-13). Phải đăng ký bằng `useGlobalFilters` để bắt được cả lỗi middleware.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  /** Nest gọi hàm này với mọi lỗi chưa được xử lý; ghi phản hồi lỗi trực tiếp lên `response`. */
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const { status, body } = this.toEnvelope(exception, request, response);
    // Vượt giới hạn body: server đã ngừng đọc, đóng kết nối để client không gửi tiếp (ING-01).
    if (status === 413) response.setHeader('Connection', 'close');
    response.status(status).json(body);
  }

  /** Quyết định status và body cho lỗi `exception`; ghi log nếu đó là lỗi phía server. */
  private toEnvelope(
    exception: unknown,
    request: Request,
    response: Response,
  ): { status: number; body: ErrorEnvelope } {
    if (exception instanceof ApiError) {
      return {
        status: exception.status,
        body: envelope(exception.code, exception.message, exception.details),
      };
    }
    if (exception instanceof NotFoundException) {
      return { status: 404, body: envelope('not_found', 'not found') };
    }

    const requestId = response.getHeader(REQUEST_ID_HEADER);
    this.logger.error(
      {
        request_id: requestId,
        method: request.method,
        path: request.path,
        err: exception,
      },
      'request failed',
    );
    if (isDatabaseUnavailable(exception)) {
      return {
        status: 503,
        body: envelope('unavailable', 'service temporarily unavailable'),
      };
    }
    return { status: 500, body: envelope('internal', INTERNAL_MESSAGE) };
  }
}

/** Dựng body lỗi; bỏ `details` khi không có để body gọn. */
function envelope(
  code: string,
  message: string,
  details?: unknown,
): ErrorEnvelope {
  return {
    error:
      details === undefined ? { code, message } : { code, message, details },
  };
}
