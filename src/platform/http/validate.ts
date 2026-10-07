import type { z } from 'zod';
import { ApiError } from './api-error.js';

/** Một lỗi của một trường: `field` là đường dẫn nối bằng dấu chấm (rỗng = cả body). */
export interface FieldError {
  field: string;
  message: string;
}

/**
 * Kiểm `input` (body, query) theo schema zod; đúng thì trả giá trị đã đổi kiểu.
 *
 * Sai thì ném `ApiError 422 validation_failed` với `details` là danh sách `{ field, message }`,
 * một phần tử mỗi lỗi. Message lấy từ zod: chỉ nêu luật bị vi phạm, không chép lại giá trị App
 * gửi lên (giá trị có thể chứa bí mật, SEC-13).
 */
export function parseWith<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const details: FieldError[] = result.error.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message,
  }));
  throw validationFailed(details);
}

/** Lỗi `422 validation_failed` dùng chung cho mọi chỗ kiểm đầu vào. */
export function validationFailed(details: FieldError[]): ApiError {
  return new ApiError(422, 'validation_failed', 'request is invalid', details);
}
