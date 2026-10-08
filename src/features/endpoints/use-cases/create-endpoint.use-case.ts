import { validateEndpointUrl } from '../../../core/endpoint-url.js';
import { type Id, newId } from '../../../core/id.js';
import { generateWebhookSecret } from '../../../core/webhook-secret.js';
import type { Clock } from '../../../platform/clock.js';
import {
  checkEndpointHost,
  type HostCheckDeps,
} from './check-endpoint-host.js';
import type { Endpoint, EndpointStore } from '../ports/endpoint-store.port.js';

/** Mặc định của `rate_limit_rps` khi App không gửi (spec 05). */
const DEFAULT_RATE_LIMIT_RPS = 50;
/** Mặc định của `max_concurrency` khi App không gửi (spec 05). */
const DEFAULT_MAX_CONCURRENCY = 10;

/**
 * Kết quả tạo endpoint, phân biệt bằng `status`:
 * - `'created'`: kèm endpoint vừa tạo (có secret, đây là lần duy nhất secret được trả ra, API-31);
 * - `'invalid_url'`: URL sai luật tĩnh hoặc trỏ vào IP nội bộ (SSRF), kèm mô tả lỗi; không ghi gì;
 * - `'limit_exceeded'`: customer đã đủ `limit` endpoint (API-30); không ghi gì.
 */
export type CreateEndpointResult =
  | { status: 'created'; endpoint: Endpoint }
  | { status: 'invalid_url'; message: string }
  | { status: 'limit_exceeded'; limit: number };

/** Dữ liệu tạo endpoint, đã qua kiểm định dạng ở tầng HTTP. */
export interface CreateEndpointInput {
  appId: Id<'app'>;
  customerId: string;
  url: string;
  eventTypes: string[];
  rateLimitRps?: number;
  maxConcurrency?: number;
}

/** Cấu hình use case tạo endpoint: lấy từ `ALLOW_INSECURE_HTTP` và `ENDPOINTS_PER_CUSTOMER_MAX`. */
export interface CreateEndpointOptions {
  allowInsecureHttp: boolean;
  maxPerCustomer: number;
}

/**
 * Use case: App đăng ký một endpoint nhận webhook cho một customer (spec 05, tạo endpoint).
 * Ngoài luật tĩnh còn phân giải DNS và chặn IP nội bộ (SEC-01).
 */
export class CreateEndpoint {
  constructor(
    private readonly store: EndpointStore,
    private readonly clock: Clock,
    private readonly options: CreateEndpointOptions,
    private readonly hostCheck: HostCheckDeps,
  ) {}

  /** Kiểm URL, sinh ID và secret, rồi lưu trong giới hạn của customer. */
  async execute(input: CreateEndpointInput): Promise<CreateEndpointResult> {
    // 1. Luật tĩnh của URL (https, không user:pass@, cổng, độ dài), rồi host không được trỏ vào IP nội bộ.
    const urlError =
      validateEndpointUrl(input.url, this.options) ??
      (await checkEndpointHost(input.url, this.hostCheck));
    if (urlError !== null) return { status: 'invalid_url', message: urlError };

    // 2. Dựng endpoint mới: đang hoạt động, chưa có secret cũ. `Set` loại event type trùng
    //    mà vẫn giữ thứ tự xuất hiện đầu tiên.
    const now = this.clock.now();
    const endpoint: Endpoint = {
      id: newId('endpoint', now.getTime()),
      appId: input.appId,
      customerId: input.customerId,
      url: input.url,
      eventTypes: [...new Set(input.eventTypes)],
      secret: generateWebhookSecret(),
      previousSecret: null,
      previousSecretExpiresAt: null,
      rateLimitRps: input.rateLimitRps ?? DEFAULT_RATE_LIMIT_RPS,
      maxConcurrency: input.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      firstFailureAt: null,
      disabledAt: null,
      disabledReason: null,
      createdAt: now,
      updatedAt: now,
    };

    // 3. Lưu; kho tự đếm và từ chối nếu customer đã đủ (đúng cả khi đồng thời, API-30).
    const limit = this.options.maxPerCustomer;
    const outcome = await this.store.insertWithinLimit(endpoint, limit);
    if (outcome === 'limit_exceeded')
      return { status: 'limit_exceeded', limit };
    return { status: 'created', endpoint };
  }
}
