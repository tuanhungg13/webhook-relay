import { type Id, newId } from '../../../core/id.js';
import { eventFingerprint } from '../../../core/request-fingerprint.js';
import type { Clock } from '../../../platform/clock.js';
import type { EventStore } from '../ports/event-store.port.js';

/** Dữ liệu gửi sự kiện, đã qua kiểm định dạng và `checkEventPayload` ở tầng HTTP. */
export interface IngestEventInput {
  appId: Id<'app'>;
  customerId: string;
  type: string;
  payload: object;
  idempotencyKey?: string;
}

/**
 * Kết quả gửi sự kiện, phân biệt bằng `status`:
 * - `'created'`: sự kiện mới (HTTP 202);
 * - `'duplicate'`: trùng khóa, cùng nội dung; `id` và `createdAt` của sự kiện cũ (HTTP 200);
 * - `'conflict'`: trùng khóa, khác nội dung (HTTP 409).
 */
export type IngestEventResult =
  | { status: 'created' | 'duplicate'; id: Id<'event'>; createdAt: Date }
  | { status: 'conflict' };

/** Cấu hình use case: `idempotencyTtlMs` lấy từ `IDEMPOTENCY_TTL` (đã đổi ra mili giây). */
export interface IngestEventOptions {
  idempotencyTtlMs: number;
}

/** Use case: App báo một sự kiện của customer; hệ thống lưu và tạo delivery cho endpoint khớp. */
export class IngestEvent {
  constructor(
    private readonly store: EventStore,
    private readonly clock: Clock,
    private readonly options: IngestEventOptions,
  ) {}

  /**
   * Tính dấu vân tay, sinh ID rồi giao cho store lưu trong một transaction.
   *
   * Không có `idempotencyKey` thì luôn tạo sự kiện mới (ING-05). Có khóa thì khóa cũ hơn
   * `IDEMPOTENCY_TTL` bị coi là hết hạn ngay tại đây, không chờ reconciler dọn (API-21).
   */
  async execute(input: IngestEventInput): Promise<IngestEventResult> {
    const now = this.clock.now();
    const event = {
      id: newId('event', now.getTime()),
      appId: input.appId,
      customerId: input.customerId,
      type: input.type,
      payload: input.payload,
      createdAt: now,
    };
    const idempotency =
      input.idempotencyKey === undefined
        ? null
        : {
            key: input.idempotencyKey,
            requestHash: eventFingerprint(input),
            expiresBefore: new Date(
              now.getTime() - this.options.idempotencyTtlMs,
            ),
          };

    const outcome = await this.store.ingest({ event, idempotency });
    switch (outcome.status) {
      case 'created':
        return { status: 'created', id: event.id, createdAt: now };
      case 'duplicate':
        return {
          status: 'duplicate',
          id: outcome.eventId,
          createdAt: outcome.createdAt,
        };
      case 'conflict':
        return { status: 'conflict' };
    }
  }
}
