import { validateEndpointUrl } from '../../../core/endpoint-url.js';
import type { Id } from '../../../core/id.js';
import type { Clock } from '../../../platform/clock.js';
import {
  checkEndpointHost,
  type HostCheckDeps,
} from './check-endpoint-host.js';
import type {
  Endpoint,
  EndpointPatch,
  EndpointStore,
} from '../ports/endpoint-store.port.js';

/** Kết quả sửa endpoint: đã sửa (kèm bản mới), không tìm thấy, hoặc URL mới sai luật (kể cả trỏ vào IP nội bộ). */
export type UpdateEndpointResult =
  | { status: 'updated'; endpoint: Endpoint }
  | { status: 'not_found' }
  | { status: 'invalid_url'; message: string };

/**
 * Use case: App sửa `url`, `event_types`, `rate_limit_rps`, `max_concurrency` của endpoint.
 * Thay đổi có hiệu lực ngay cho lần gửi tiếp theo (WRK-06) vì worker đọc lại endpoint mỗi lần.
 */
export class UpdateEndpoint {
  constructor(
    private readonly store: EndpointStore,
    private readonly clock: Clock,
    private readonly options: { allowInsecureHttp: boolean },
    private readonly hostCheck: HostCheckDeps,
  ) {}

  /** Kiểm URL mới (nếu có), loại event type trùng, rồi ghi các trường được gửi. */
  async execute(input: {
    appId: Id<'app'>;
    id: Id<'endpoint'>;
    patch: EndpointPatch;
  }): Promise<UpdateEndpointResult> {
    const { url, eventTypes } = input.patch;
    if (url !== undefined) {
      // Chỉ kiểm lại khi `url` đổi; lúc gửi bộ gửi vẫn kiểm lại mọi lần.
      const urlError =
        validateEndpointUrl(url, this.options) ??
        (await checkEndpointHost(url, this.hostCheck));
      if (urlError !== null)
        return { status: 'invalid_url', message: urlError };
    }
    const patch: EndpointPatch = {
      ...input.patch,
      eventTypes: eventTypes && [...new Set(eventTypes)],
    };

    const endpoint = await this.store.update(
      input.appId,
      input.id,
      patch,
      this.clock.now(),
    );
    if (!endpoint) return { status: 'not_found' };
    return { status: 'updated', endpoint };
  }
}
