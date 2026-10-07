import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Id } from '../../core/id.js';

/** App đã xác thực và prefix của key vừa dùng. */
export interface AuthenticatedApp {
  appId: Id<'app'>;
  keyPrefix: string;
}

/**
 * Khóa lưu app đã xác thực trên request. Là `Symbol` nội bộ nên không header, query hay body
 * nào của client ghi đè được.
 */
const AUTHENTICATED_APP = Symbol('authenticatedApp');

/** Request có thể mang app đã xác thực. */
type RequestWithApp = { [AUTHENTICATED_APP]?: AuthenticatedApp };

/** Guard gọi hàm này sau khi xác thực xong để gắn app vào request. */
export function attachAuthenticatedApp(
  request: object,
  app: AuthenticatedApp,
): void {
  (request as RequestWithApp)[AUTHENTICATED_APP] = app;
}

/**
 * Decorator tham số lấy app đã xác thực: `handler(@CurrentApp() app: AuthenticatedApp)`.
 * Route không qua guard thì không có app: đó là lỗi lập trình nên ném `Error` (thành 500)
 * chứ không âm thầm cho qua.
 */
export const CurrentApp = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedApp => {
    const request = context.switchToHttp().getRequest<RequestWithApp>();
    const app = request[AUTHENTICATED_APP];
    if (!app)
      throw new Error('@CurrentApp() used on a route without ApiKeyGuard');
    return app;
  },
);
