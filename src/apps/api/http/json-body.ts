import getRawBody from 'raw-body';
import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../../../platform/http/api-error.js';

/**
 * Tạo middleware đọc body JSON, giới hạn `maxBytes` byte (ING-01).
 *
 * Không dùng body-parser của Nest vì khi body vượt giới hạn nó vẫn đọc bỏ hết phần còn lại
 * rồi mới trả 413: client khai Content-Length lớn mà gửi chậm thì treo mãi (D-16).
 * `raw-body` dừng đọc ngay khi vượt giới hạn.
 *
 * Kết quả đặt vào `request.body`:
 * - không có body (không có Content-Length lẫn Transfer-Encoding) hoặc body rỗng: `undefined`;
 * - có body: giá trị JSON đã parse. Không kiểm `Content-Type`.
 * Lỗi: vượt giới hạn → `ApiError` 413; JSON hỏng hoặc lỗi đọc khác → `ApiError` 400.
 * Body nén (`Content-Encoding: gzip`) không được giải nén nên rơi vào 400.
 */
export function jsonBodyMiddleware(maxBytes: number) {
  return async (
    request: Request,
    _response: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      request.body = await readJsonBody(request, maxBytes);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Đọc và parse body của request, xem `jsonBodyMiddleware` về các trường hợp. */
async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const hasBody =
    request.headers['content-length'] !== undefined ||
    request.headers['transfer-encoding'] !== undefined;
  if (!hasBody) return undefined;

  const text = await getRawBody(request, {
    limit: maxBytes,
    length: request.headers['content-length'],
    encoding: 'utf8',
  }).catch((error: unknown) => {
    throw toBodyReadError(error);
  });
  if (text === '') return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, 'invalid_json', 'request body is not valid JSON');
  }
}

/** Đổi lỗi của `raw-body` sang `ApiError`: quá lớn → 413, mọi lỗi đọc khác → 400. */
function toBodyReadError(error: unknown): ApiError {
  const type = (error as { type?: unknown } | null)?.type;
  if (type === 'entity.too.large') {
    return new ApiError(413, 'payload_too_large', 'request body is too large');
  }
  return new ApiError(400, 'invalid_json', 'request body could not be read');
}
