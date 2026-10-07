import { SetMetadata } from '@nestjs/common';

/** Khóa metadata đánh dấu route không cần xác thực. */
export const IS_PUBLIC = 'isPublic';

/**
 * Đánh dấu route (hoặc controller) không cần API key, vd `/healthz`, `/readyz`.
 * Mặc định mọi route đều bị `ApiKeyGuard` chặn, nên route mới không thể hở vì quên gắn guard.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
