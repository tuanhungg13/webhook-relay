import type { Id } from '../../../core/id.js';

/** Lý do endpoint bị vô hiệu hóa: App tự tắt (`manual`) hoặc hệ thống tắt vì lỗi kéo dài. */
export type EndpointDisabledReason = 'manual' | 'auto_failing';

/**
 * Một endpoint còn tồn tại (chưa xóa mềm), đủ mọi trường kể cả secret.
 *
 * Kiểu này chỉ dùng bên trong hệ thống: đổi sang JSON trả cho App thì phải bỏ secret
 * (API-31, xem `endpoint.view.ts`).
 */
export interface Endpoint {
  id: Id<'endpoint'>;
  appId: Id<'app'>;
  customerId: string;
  url: string;
  eventTypes: string[];
  secret: string;
  /** Secret trước lần xoay gần nhất, còn hiệu lực tới `previousSecretExpiresAt` (API-35). */
  previousSecret: string | null;
  previousSecretExpiresAt: Date | null;
  rateLimitRps: number;
  maxConcurrency: number;
  firstFailureAt: Date | null;
  /** null = đang hoạt động. Luôn đi cùng `disabledReason` (ràng buộc ở database). */
  disabledAt: Date | null;
  disabledReason: EndpointDisabledReason | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Các trường App được phép sửa (PATCH); trường không có mặt thì giữ nguyên. */
export interface EndpointPatch {
  url?: string;
  eventTypes?: string[];
  rateLimitRps?: number;
  maxConcurrency?: number;
}

/**
 * Điều kiện lấy danh sách: `customerId` có thì chỉ lấy của customer đó; `afterId` có thì chỉ lấy
 * endpoint cũ hơn nó (trang sau); tối đa `limit` phần tử.
 */
export interface EndpointListQuery {
  customerId?: string;
  afterId?: Id<'endpoint'>;
  limit: number;
}

/**
 * Port đọc/ghi endpoint mà các use case endpoint cần. Bản thật: `PostgresEndpointStore`.
 *
 * Quy ước chung: mọi hàm nhận `appId` và chỉ thấy endpoint của app đó, chưa xóa mềm. Endpoint
 * không tồn tại, thuộc app khác hoặc đã xóa mềm cho CÙNG một kết quả (null/false), để API trả
 * cùng một `404` (API-04, API-33).
 */
export interface EndpointStore {
  /**
   * Lưu endpoint mới nếu customer của nó chưa có đủ `max` endpoint (đếm cả endpoint đang
   * vô hiệu hóa, không đếm endpoint đã xóa mềm). Phải đúng cả khi nhiều lời gọi chạy đồng
   * thời cho cùng customer (API-30). Đã đủ thì trả `'limit_exceeded'` và không ghi gì.
   */
  insertWithinLimit(
    endpoint: Endpoint,
    max: number,
  ): Promise<'inserted' | 'limit_exceeded'>;

  /** Tìm endpoint theo ID. */
  findById(appId: Id<'app'>, id: Id<'endpoint'>): Promise<Endpoint | null>;

  /**
   * Danh sách endpoint theo `query`, mới nhất trước (ID giảm dần; UUIDv7 nên ID lớn hơn là
   * mới hơn).
   */
  list(appId: Id<'app'>, query: EndpointListQuery): Promise<Endpoint[]>;

  /** Sửa các trường có trong `patch`, đặt `updatedAt = at`, trả endpoint sau khi sửa. */
  update(
    appId: Id<'app'>,
    id: Id<'endpoint'>,
    patch: EndpointPatch,
    at: Date,
  ): Promise<Endpoint | null>;

  /** Xóa mềm tại `at`. Trả true nếu vừa xóa, false nếu không tìm thấy (kể cả đã xóa trước đó). */
  softDelete(appId: Id<'app'>, id: Id<'endpoint'>, at: Date): Promise<boolean>;

  /**
   * Vô hiệu hóa với lý do `manual`. Idempotent (gọi lại cho cùng kết quả): đang bị vô hiệu hóa
   * thì giữ nguyên thời điểm và lý do lần đầu. Trả false nếu không tìm thấy.
   */
  disable(appId: Id<'app'>, id: Id<'endpoint'>, at: Date): Promise<boolean>;

  /**
   * Kích hoạt lại: xóa `firstFailureAt`, `disabledAt`, `disabledReason` (spec 05). Đang hoạt
   * động thì vẫn thành công. Trả false nếu không tìm thấy.
   */
  enable(appId: Id<'app'>, id: Id<'endpoint'>, at: Date): Promise<boolean>;

  /**
   * Xoay secret: secret hiện tại thành `previousSecret` (hết hạn lúc `graceUntil`), `newSecret`
   * thành secret hiện tại. Secret cũ hơn nữa (nếu có) bị bỏ ngay: chỉ giữ tối đa hai (API-35).
   */
  rotateSecret(
    appId: Id<'app'>,
    id: Id<'endpoint'>,
    rotation: { newSecret: string; graceUntil: Date; at: Date },
  ): Promise<Endpoint | null>;
}
