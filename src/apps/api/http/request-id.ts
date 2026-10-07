import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Tên header mang mã truy vết request, cả chiều vào lẫn chiều ra. */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Mã do client gửi chỉ được dùng nếu gồm chữ, số, `.`, `_`, `-` và dài 1..128 ký tự. */
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Chọn mã truy vết cho request: giữ mã client gửi nếu đúng định dạng, không thì sinh UUID mới.
 *
 * Mã sai (quá dài, ký tự lạ) bị bỏ qua chứ không trả lỗi, và không bao giờ được đưa vào log
 * hay phản hồi để tránh bị chèn nội dung bẩn (API-12).
 */
export function resolveRequestId(header: string | undefined): string {
  return header !== undefined && VALID_REQUEST_ID.test(header)
    ? header
    : randomUUID();
}

/**
 * Middleware Express chạy ĐẦU TIÊN: gắn `X-Request-Id` vào phản hồi của mọi request, kể cả
 * request bị từ chối ở các bước sau (API-11). Filter lỗi đọc lại id này từ header phản hồi.
 */
export function requestIdMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  response.setHeader(
    REQUEST_ID_HEADER,
    resolveRequestId(request.header(REQUEST_ID_HEADER)),
  );
  next();
}
