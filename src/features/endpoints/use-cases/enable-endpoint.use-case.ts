import type { Id } from '../../../core/id.js';
import type { Clock } from '../../../platform/clock.js';
import type { EndpointStore } from '../ports/endpoint-store.port.js';

/** Kết quả kích hoạt endpoint: đã kích hoạt (kể cả vốn đang hoạt động), hoặc không tìm thấy. */
export type EnableEndpointResult =
  { status: 'enabled' } | { status: 'not_found' };

/**
 * Use case: kích hoạt lại endpoint, xóa `first_failure_at`, `disabled_at`, `disabled_reason`.
 * Không đụng circuit breaker trong Redis, circuit tự lành (API-34).
 */
export class EnableEndpoint {
  constructor(
    private readonly store: EndpointStore,
    private readonly clock: Clock,
  ) {}

  /** Kích hoạt endpoint `input.id` của app `input.appId`. */
  async execute(input: {
    appId: Id<'app'>;
    id: Id<'endpoint'>;
  }): Promise<EnableEndpointResult> {
    const found = await this.store.enable(
      input.appId,
      input.id,
      this.clock.now(),
    );
    return { status: found ? 'enabled' : 'not_found' };
  }
}
