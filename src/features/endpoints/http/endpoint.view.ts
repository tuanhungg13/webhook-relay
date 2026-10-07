import type {
  Endpoint,
  EndpointDisabledReason,
} from '../ports/endpoint-store.port.js';

/**
 * Dạng JSON công khai của endpoint trả cho App. KHÔNG có `secret` hay `previous_secret`
 * (API-31, SEC-13): chỉ phản hồi tạo và xoay secret mới thêm `secret`, xem `EndpointWithSecretView`.
 */
export interface EndpointView {
  id: string;
  customer_id: string;
  url: string;
  event_types: string[];
  rate_limit_rps: number;
  max_concurrency: number;
  status: 'active' | 'disabled';
  disabled_reason: EndpointDisabledReason | null;
  created_at: string;
  updated_at: string;
}

/** Phản hồi tạo (201) và xoay secret (200): endpoint kèm secret hiện tại, lần duy nhất App thấy nó. */
export interface EndpointWithSecretView extends EndpointView {
  secret: string;
}

/**
 * Đổi `Endpoint` sang JSON công khai. Liệt kê từng trường (không dùng `...endpoint`) để một
 * trường bí mật thêm vào `Endpoint` sau này không tự lọt ra API. Thời gian dạng RFC 3339 UTC.
 */
export function toEndpointView(endpoint: Endpoint): EndpointView {
  return {
    id: endpoint.id,
    customer_id: endpoint.customerId,
    url: endpoint.url,
    event_types: endpoint.eventTypes,
    rate_limit_rps: endpoint.rateLimitRps,
    max_concurrency: endpoint.maxConcurrency,
    status: endpoint.disabledAt === null ? 'active' : 'disabled',
    disabled_reason: endpoint.disabledReason,
    created_at: endpoint.createdAt.toISOString(),
    updated_at: endpoint.updatedAt.toISOString(),
  };
}

/** Như `toEndpointView` nhưng thêm `secret`; chỉ dùng cho phản hồi tạo và xoay secret. */
export function toEndpointWithSecretView(
  endpoint: Endpoint,
): EndpointWithSecretView {
  return { ...toEndpointView(endpoint), secret: endpoint.secret };
}
