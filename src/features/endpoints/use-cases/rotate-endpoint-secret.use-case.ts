import type { Id } from '../../../core/id.js';
import { generateWebhookSecret } from '../../../core/webhook-secret.js';
import type { Clock } from '../../../platform/clock.js';
import type { Endpoint, EndpointStore } from '../ports/endpoint-store.port.js';

/** Kết quả xoay secret: đã xoay (kèm endpoint có secret mới) hoặc không tìm thấy. */
export type RotateEndpointSecretResult =
  { status: 'rotated'; endpoint: Endpoint } | { status: 'not_found' };

/**
 * Use case: xoay webhook secret của endpoint (SEC-22, API-35).
 *
 * Secret cũ còn hiệu lực thêm `rotationGraceMs` (cấu hình `SECRET_ROTATION_GRACE`, 24 giờ) để
 * người nhận kịp chuyển sang secret mới; trong lúc đó worker ký bằng cả hai.
 */
export class RotateEndpointSecret {
  constructor(
    private readonly store: EndpointStore,
    private readonly clock: Clock,
    private readonly options: { rotationGraceMs: number },
  ) {}

  /** Sinh secret mới và lưu; secret mới chỉ được trả ra ở đây, giống lúc tạo (API-31). */
  async execute(input: {
    appId: Id<'app'>;
    id: Id<'endpoint'>;
  }): Promise<RotateEndpointSecretResult> {
    const now = this.clock.now();
    const endpoint = await this.store.rotateSecret(input.appId, input.id, {
      newSecret: generateWebhookSecret(),
      graceUntil: new Date(now.getTime() + this.options.rotationGraceMs),
      at: now,
    });
    if (!endpoint) return { status: 'not_found' };
    return { status: 'rotated', endpoint };
  }
}
