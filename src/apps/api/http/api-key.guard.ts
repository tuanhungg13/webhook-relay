import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthenticateApiKey } from '../../../features/access/authenticate-api-key.use-case.js';
import { ApiError } from '../../../platform/http/api-error.js';
import { attachAuthenticatedApp } from '../../../platform/http/current-app.js';
import { IS_PUBLIC } from './public.js';

/** `Bearer <key>`: tên scheme không phân biệt hoa thường, key là một chuỗi không có khoảng trắng. */
const BEARER_PATTERN = /^bearer +(\S+)$/i;

/** Lấy API key từ giá trị header `Authorization`; sai dạng hoặc thiếu thì trả null (API-01). */
export function extractBearerKey(header: string | undefined): string | null {
  if (header === undefined) return null;
  return BEARER_PATTERN.exec(header)?.[1] ?? null;
}

/**
 * Guard toàn cục xác thực API key cho mọi route, trừ route có `@Public()` (API-01..03).
 *
 * Thiếu header, sai dạng, key không tồn tại và key đã thu hồi đều ném cùng một `401`,
 * không để lộ sự khác biệt (API-03). Lỗi database được ném tiếp để filter trả 503.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthenticateApiKey)
    private readonly authenticate: AuthenticateApiKey,
  ) {}

  /** Cho qua (true) hoặc ném `ApiError` 401; xem các bước đánh số bên dưới. */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1. Route có @Public() (trên method hoặc controller) thì cho qua.
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) return true;

    // 2. Lấy key từ header Authorization; không có thì 401 mà không đụng tới database.
    const request = context.switchToHttp().getRequest<Request>();
    const apiKey = extractBearerKey(request.header('authorization'));
    if (apiKey === null) throw unauthorized();

    // 3. Tra key; không có app tương ứng cũng là cùng một 401.
    const app = await this.authenticate.execute({ apiKey });
    if (app === null) throw unauthorized();

    // 4. Gắn app vào request để @CurrentApp() đọc.
    attachAuthenticatedApp(request, app);
    return true;
  }
}

/** Lỗi 401 duy nhất của hệ thống: message cố định, không nói lý do (API-03). */
function unauthorized(): ApiError {
  return new ApiError(401, 'unauthorized', 'invalid or missing API key');
}
