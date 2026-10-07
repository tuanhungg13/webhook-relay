import type pg from 'pg';
import { type Id, idFromUuid, idToUuid, newId } from '../../core/id.js';
import type {
  DeliveryStatus,
  DeliverySummary,
  EventDetail,
  EventListQuery,
  EventStore,
  EventSummary,
  IdempotencyClaim,
  IngestOutcome,
  NewEvent,
} from '../../features/ingestion/ports/event-store.port.js';
import { withTransaction } from './transaction.js';

/** Một dòng `events` (không payload) như `pg` trả về. */
interface EventRow {
  id: string;
  customer_id: string;
  type: string;
  created_at: Date;
}

/** Một dòng `events` kèm payload; `jsonb` được `pg` đọc sẵn thành giá trị JavaScript. */
interface EventDetailRow extends EventRow {
  payload: unknown;
}

/** Một dòng `deliveries` rút gọn. */
interface DeliveryRow {
  id: string;
  endpoint_id: string;
  status: DeliveryStatus;
  attempt_count: number;
}

/** Khóa idempotency đã có cùng sự kiện nó trỏ tới. */
interface ExistingKeyRow {
  request_hash: Buffer;
  event_id: string;
  event_created_at: Date;
}

/**
 * Hiện thực port `EventStore` bằng Postgres (bảng `events`, `idempotency_keys`, `deliveries`).
 * TypeID đổi sang UUID ở đây (DAT-03); giá trị truyền qua tham số `$n` để chống SQL injection.
 */
export class PostgresEventStore implements EventStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Nhận sự kiện trong một transaction: khóa idempotency → sự kiện → delivery (ING-02).
   *
   * Khóa ghi TRƯỚC sự kiện (ING-03.6): request thua cuộc đụng khóa là dừng ngay, không bao giờ
   * ghi payload. Khóa ngoại tới sự kiện được hoãn tới COMMIT nên thứ tự này hợp lệ.
   */
  ingest(input: {
    event: NewEvent;
    idempotency: IdempotencyClaim | null;
  }): Promise<IngestOutcome> {
    const { event, idempotency } = input;
    return withTransaction(this.pool, async (client) => {
      if (idempotency) {
        const claimed = await claimKey(client, event, idempotency);
        if (!claimed) return readExistingKey(client, event.appId, idempotency);
      }
      await insertEvent(client, event);
      const deliveryCount = await insertDeliveries(client, event);
      return { status: 'created', deliveryCount };
    });
  }

  /** Đọc sự kiện của app kèm delivery tóm tắt (cũ nhất trước). */
  async findById(
    appId: Id<'app'>,
    id: Id<'event'>,
  ): Promise<EventDetail | null> {
    const found = await this.pool.query<EventDetailRow>(
      `SELECT id, customer_id, type, payload, created_at FROM events
       WHERE id = $1 AND app_id = $2`,
      [idToUuid(id), idToUuid(appId)],
    );
    const row = found.rows[0];
    if (!row) return null;
    const deliveries = await this.pool.query<DeliveryRow>(
      `SELECT id, endpoint_id, status, attempt_count FROM deliveries
       WHERE event_id = $1 ORDER BY id`,
      [row.id],
    );
    return {
      ...toSummary(row),
      payload: row.payload,
      deliveries: deliveries.rows.map(toDeliverySummary),
    };
  }

  /**
   * Danh sách mới nhất trước, phân trang kiểu keyset (lấy các dòng "nhỏ hơn" dòng cuối trang
   * trước, không dùng OFFSET nên trang sâu vẫn nhanh) trên chỉ mục `events_by_customer`.
   */
  async list(
    appId: Id<'app'>,
    query: EventListQuery,
  ): Promise<EventSummary[] | 'invalid_cursor'> {
    // 1. Cursor chỉ chứa ID; tra thời gian tạo của nó, nhưng chỉ trong đúng (app, customer):
    //    tra không lọc thì cursor mang ID của app khác vẫn ra trang, lộ việc sự kiện tồn tại.
    let cursorCreatedAt: Date | null = null;
    if (query.afterId) {
      const cursor = await this.pool.query<{ created_at: Date }>(
        `SELECT created_at FROM events
         WHERE id = $1 AND app_id = $2 AND customer_id = $3`,
        [idToUuid(query.afterId), idToUuid(appId), query.customerId],
      );
      if (!cursor.rows[0]) return 'invalid_cursor';
      cursorCreatedAt = cursor.rows[0].created_at;
    }
    // 2. `$n IS NULL OR ...`: tham số null thì bỏ điều kiện đó (không lọc type / trang đầu).
    const { rows } = await this.pool.query<EventRow>(
      `SELECT id, customer_id, type, created_at FROM events
       WHERE app_id = $1 AND customer_id = $2
         AND ($3::text IS NULL OR type = $3)
         AND ($4::timestamptz IS NULL OR (created_at, id) < ($4, $5::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT $6`,
      [
        idToUuid(appId),
        query.customerId,
        query.type ?? null,
        cursorCreatedAt,
        query.afterId ? idToUuid(query.afterId) : null,
        query.limit,
      ],
    );
    return rows.map(toSummary);
  }
}

/**
 * Ghi khóa idempotency. Trả true nếu request này giữ được khóa (khóa mới, hoặc khóa cũ đã hết
 * hạn nên bị ghi đè), false nếu khóa còn hiệu lực của request khác.
 *
 * Một câu `INSERT ... ON CONFLICT DO UPDATE ... WHERE` là nguyên tử: 50 request đồng thời cùng
 * khóa thì Postgres cho đúng một request ghi, các request kia chờ nó commit rồi thấy 0 dòng.
 * `created_at` phải đặt lại khi ghi đè: không thì khóa vừa trỏ sang sự kiện mới vẫn bị coi là
 * hết hạn và mỗi lần gửi lại lại tạo thêm một sự kiện.
 */
async function claimKey(
  client: pg.PoolClient,
  event: NewEvent,
  claim: IdempotencyClaim,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO idempotency_keys (app_id, key, event_id, request_hash, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (app_id, key) DO UPDATE SET
       event_id = EXCLUDED.event_id,
       request_hash = EXCLUDED.request_hash,
       created_at = EXCLUDED.created_at
     WHERE idempotency_keys.created_at < $6`,
    [
      idToUuid(event.appId),
      claim.key,
      idToUuid(event.id),
      claim.requestHash,
      event.createdAt,
      claim.expiresBefore,
    ],
  );
  return rowCount === 1;
}

/**
 * Đọc khóa đang giữ chỗ để phân loại: cùng hash là `duplicate` (trả sự kiện cũ), khác hash là
 * `conflict`. Không ghi gì nên transaction kết thúc rỗng.
 *
 * Không thấy dòng nào chỉ xảy ra nếu job xóa dữ liệu cũ vừa dọn khóa này giữa hai câu lệnh;
 * ném lỗi để App gửi lại (an toàn vì lần gửi lại sẽ thấy khóa trống) thay vì đoán kết quả.
 */
async function readExistingKey(
  client: pg.PoolClient,
  appId: Id<'app'>,
  claim: IdempotencyClaim,
): Promise<IngestOutcome> {
  const { rows } = await client.query<ExistingKeyRow>(
    `SELECT k.request_hash, e.id AS event_id, e.created_at AS event_created_at
     FROM idempotency_keys k JOIN events e ON e.id = k.event_id
     WHERE k.app_id = $1 AND k.key = $2`,
    [idToUuid(appId), claim.key],
  );
  const existing = rows[0];
  if (!existing) throw new Error('idempotency key disappeared during ingest');
  if (!existing.request_hash.equals(claim.requestHash)) {
    return { status: 'conflict' };
  }
  return {
    status: 'duplicate',
    eventId: idFromUuid('event', existing.event_id),
    createdAt: existing.event_created_at,
  };
}

/**
 * Ghi sự kiện. `dispatched_at = created_at`: giai đoạn 1 tạo delivery ngay trong transaction này
 * nên sự kiện coi như đã fan-out (giai đoạn 2 đổi sang outbox). Payload gửi dạng chuỗi JSON
 * rồi ép `::jsonb`, để `pg` không tự đổi object theo cách khác.
 */
async function insertEvent(
  client: pg.PoolClient,
  event: NewEvent,
): Promise<void> {
  await client.query(
    `INSERT INTO events (id, app_id, customer_id, type, payload, created_at, dispatched_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6)`,
    [
      idToUuid(event.id),
      idToUuid(event.appId),
      event.customerId,
      event.type,
      JSON.stringify(event.payload),
      event.createdAt,
    ],
  );
}

/**
 * Tạo một delivery `pending` cho mỗi endpoint của (app, customer) chưa xóa, chưa vô hiệu hóa
 * và có `type` trong `event_types`; trả số delivery đã tạo (0 vẫn hợp lệ, API-20).
 *
 * ID delivery sinh ở ứng dụng từ giờ của sự kiện (DAT-01, DAT-22), rồi `unnest` ghép hai mảng
 * (ID delivery, ID endpoint) thành các dòng để chèn bằng đúng một câu lệnh. Endpoint bị
 * xóa/tắt SAU câu chọn này vẫn nhận delivery; worker xử lý trường hợp đó (spec 07).
 */
async function insertDeliveries(
  client: pg.PoolClient,
  event: NewEvent,
): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM endpoints
     WHERE app_id = $1 AND customer_id = $2
       AND deleted_at IS NULL AND disabled_at IS NULL
       AND $3 = ANY(event_types)`,
    [idToUuid(event.appId), event.customerId, event.type],
  );
  if (rows.length === 0) return 0;
  const deliveryIds = rows.map(() =>
    idToUuid(newId('delivery', event.createdAt.getTime())),
  );
  await client.query(
    `INSERT INTO deliveries (id, event_id, endpoint_id, status, attempt_count,
       next_attempt_at, gate_blocked_count, created_at, updated_at)
     SELECT d.id, $1, d.endpoint_id, 'pending', 0, $4, 0, $4, $4
     FROM unnest($2::uuid[], $3::uuid[]) AS d(id, endpoint_id)`,
    [
      idToUuid(event.id),
      deliveryIds,
      rows.map((row) => row.id),
      event.createdAt,
    ],
  );
  return rows.length;
}

/** Đổi một dòng `events` sang `EventSummary`; UUID thành TypeID (DAT-03). */
function toSummary(row: EventRow): EventSummary {
  return {
    id: idFromUuid('event', row.id),
    customerId: row.customer_id,
    type: row.type,
    createdAt: row.created_at,
  };
}

/** Đổi một dòng `deliveries` sang `DeliverySummary`. */
function toDeliverySummary(row: DeliveryRow): DeliverySummary {
  return {
    id: idFromUuid('delivery', row.id),
    endpointId: idFromUuid('endpoint', row.endpoint_id),
    status: row.status,
    attemptCount: row.attempt_count,
  };
}
