import { type Id, newId } from '../../src/core/id.js';
import type {
  DeliverySummary,
  EventDetail,
  EventListQuery,
  EventStore,
  EventSummary,
  IdempotencyClaim,
  IngestOutcome,
  NewEvent,
} from '../../src/features/ingestion/ports/event-store.port.js';

/** Endpoint mà bản giả biết để fan-out: chỉ các trường fan-out cần. */
export interface FakeEndpoint {
  id: Id<'endpoint'>;
  appId: Id<'app'>;
  customerId: string;
  eventTypes: string[];
  deleted: boolean;
  disabled: boolean;
}

/** Một sự kiện đã lưu cùng các delivery của nó. */
interface StoredEvent extends NewEvent {
  deliveries: DeliverySummary[];
}

/** Một khóa idempotency đã lưu. */
interface StoredKey {
  eventId: Id<'event'>;
  requestHash: Buffer;
  createdAt: Date;
}

/**
 * Bản giả của `EventStore` lưu trong bộ nhớ, dùng cho test không cần Postgres. Chạy qua cùng bộ
 * contract test với bản Postgres (ARCH-21).
 *
 * Không có bảng endpoint thật nên test thêm endpoint bằng `addEndpoint`. Luôn trả BẢN SAO
 * (`structuredClone`) như Postgres trả dòng mới mỗi lần đọc.
 */
export class InMemoryEventStore implements EventStore {
  private readonly events = new Map<Id<'event'>, StoredEvent>();
  private readonly keys = new Map<string, StoredKey>();
  private readonly endpoints: FakeEndpoint[] = [];

  /** Cho bản giả biết một endpoint để các sự kiện sau fan-out tới. */
  addEndpoint(endpoint: FakeEndpoint): void {
    this.endpoints.push(endpoint);
  }

  /** Ghi khóa (nếu có) → sự kiện → delivery, y như một transaction của bản Postgres. */
  ingest(input: {
    event: NewEvent;
    idempotency: IdempotencyClaim | null;
  }): Promise<IngestOutcome> {
    const { event, idempotency } = input;
    if (idempotency) {
      const mapKey = `${event.appId}|${idempotency.key}`;
      const existing = this.keys.get(mapKey);
      // Giống `WHERE created_at < expiresBefore` của Postgres: chỉ khóa còn hạn mới chặn.
      if (existing && existing.createdAt >= idempotency.expiresBefore) {
        return Promise.resolve(this.classify(existing, idempotency));
      }
      this.keys.set(mapKey, {
        eventId: event.id,
        requestHash: idempotency.requestHash,
        createdAt: event.createdAt,
      });
    }
    const deliveries = this.endpoints
      .filter(
        (endpoint) =>
          endpoint.appId === event.appId &&
          endpoint.customerId === event.customerId &&
          !endpoint.deleted &&
          !endpoint.disabled &&
          endpoint.eventTypes.includes(event.type),
      )
      .map<DeliverySummary>((endpoint) => ({
        id: newId('delivery', event.createdAt.getTime()),
        endpointId: endpoint.id,
        status: 'pending',
        attemptCount: 0,
      }));
    this.events.set(event.id, { ...structuredClone(event), deliveries });
    return Promise.resolve({
      status: 'created',
      deliveryCount: deliveries.length,
    });
  }

  /** Đọc sự kiện của app kèm delivery. */
  findById(appId: Id<'app'>, id: Id<'event'>): Promise<EventDetail | null> {
    const stored = this.events.get(id);
    if (!stored || stored.appId !== appId) return Promise.resolve(null);
    return Promise.resolve({
      ...toSummary(stored),
      payload: structuredClone(stored.payload),
      deliveries: structuredClone(stored.deliveries),
    });
  }

  /**
   * Danh sách mới nhất trước. Cursor chỉ hợp lệ nếu trỏ tới sự kiện của đúng (app, customer).
   */
  list(
    appId: Id<'app'>,
    query: EventListQuery,
  ): Promise<EventSummary[] | 'invalid_cursor'> {
    const inScope = [...this.events.values()].filter(
      (event) => event.appId === appId && event.customerId === query.customerId,
    );
    const cursor = query.afterId
      ? inScope.find((event) => event.id === query.afterId)
      : undefined;
    if (query.afterId && !cursor) return Promise.resolve('invalid_cursor');
    const found = inScope
      .filter((event) => query.type === undefined || event.type === query.type)
      .filter((event) => !cursor || isBefore(event, cursor))
      .sort((a, b) => (isBefore(a, b) ? 1 : -1))
      .slice(0, query.limit);
    return Promise.resolve(found.map(toSummary));
  }

  /** Cùng hash là trùng (trả sự kiện cũ), khác hash là xung đột. */
  private classify(key: StoredKey, claim: IdempotencyClaim): IngestOutcome {
    if (!key.requestHash.equals(claim.requestHash))
      return { status: 'conflict' };
    const original = this.events.get(key.eventId);
    if (!original) throw new Error('idempotency key points to a missing event');
    return {
      status: 'duplicate',
      eventId: original.id,
      createdAt: original.createdAt,
    };
  }
}

/** `a` cũ hơn `b` theo (thời gian tạo, ID): đúng thứ tự `ORDER BY created_at, id` của Postgres. */
function isBefore(a: NewEvent, b: NewEvent): boolean {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  return byTime !== 0 ? byTime < 0 : a.id < b.id;
}

/** Bỏ payload và delivery, chỉ giữ phần của danh sách. */
function toSummary(event: NewEvent): EventSummary {
  return {
    id: event.id,
    customerId: event.customerId,
    type: event.type,
    createdAt: event.createdAt,
  };
}
