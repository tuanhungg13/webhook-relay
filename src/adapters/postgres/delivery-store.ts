import type pg from 'pg';
import { type Id, idFromUuid, idToUuid } from '../../core/id.js';
import type { DeliveryDecision } from '../../core/retry-policy.js';
import {
  type ClaimDueInput,
  type ClaimedDelivery,
  type DeliveryStore,
  type DeliveryTarget,
  type FailForEndpointInput,
  type GuardedWriteResult,
  maxExpiredInBatch,
  type NewAttempt,
  type RecordAttemptInput,
} from '../../features/delivery/ports/delivery-store.port.js';
import { withTransaction } from './transaction.js';

/** Một dòng `deliveries` vừa giành quyền, như `RETURNING` trả về. */
interface ClaimRow {
  id: string;
  event_id: string;
  endpoint_id: string;
  lease_token: string;
  attempt_count: number;
}

/** Sự kiện + endpoint của một delivery; `jsonb` được `pg` đọc sẵn thành giá trị JavaScript. */
interface TargetRow {
  event_id: string;
  type: string;
  created_at: Date;
  payload: unknown;
  url: string;
  secret: string;
  previous_secret: string | null;
  previous_secret_expires_at: Date | null;
  deleted_at: Date | null;
  disabled_at: Date | null;
}

/**
 * Câu giành quyền (spec 07 bước 1, D-23). Ba CTE (`WITH` = bảng tạm đặt tên trong một câu):
 * - `expired`: `in_flight` quá lease (worker cũ chết), tối đa nửa lô ($4) để tin độc không
 *   bỏ đói delivery mới; giai đoạn 2 chuyển phần này về reconciler R1.
 * - `due`: `pending` đã đến hạn, cho sớm 1 giây vì lệch đồng hồ.
 * - `picked`: ghép hai nguồn, lấy tối đa $3.
 * `FOR UPDATE SKIP LOCKED` khóa dòng được chọn và bỏ qua dòng worker khác đang khóa, nên hai
 * worker không bao giờ giành cùng một delivery (WRK-02). Postgres không cho `FOR UPDATE` đứng
 * thẳng trong `UNION` nên phải tách CTE. Mỗi CTE đi đúng chỉ mục một phần của nó
 * (`deliveries_in_flight_lease`, `deliveries_pending_due`). `gen_random_uuid()` sinh mã giữ
 * quyền mới mỗi lần giành (WRK-09); "bây giờ" ($1) lấy từ đồng hồ ứng dụng (DAT-22).
 */
const CLAIM_SQL = `
  WITH expired AS (
    SELECT id FROM deliveries
    WHERE status = 'in_flight' AND lease_until < $1
    ORDER BY lease_until LIMIT $4
    FOR UPDATE SKIP LOCKED
  ), due AS (
    SELECT id FROM deliveries
    WHERE status = 'pending' AND next_attempt_at <= $1::timestamptz + interval '1 second'
    ORDER BY next_attempt_at LIMIT $3
    FOR UPDATE SKIP LOCKED
  ), picked AS (
    SELECT id FROM expired UNION ALL SELECT id FROM due LIMIT $3
  )
  UPDATE deliveries d
  SET status = 'in_flight', lease_until = $2, lease_token = gen_random_uuid(), updated_at = $1
  FROM picked WHERE d.id = picked.id
  RETURNING d.id, d.event_id, d.endpoint_id, d.lease_token, d.attempt_count`;

/**
 * Hiện thực port `DeliveryStore` bằng Postgres. Mọi thao tác ghi sau khi giành quyền có điều
 * kiện `status = 'in_flight' AND lease_token = mã của mình` (WRK-09); 0 dòng = mất quyền.
 * Mọi trạng thái sau `in_flight` đều xóa `lease_until`, `lease_token` (CHECK
 * `lease_token` ⇔ `in_flight`).
 */
export class PostgresDeliveryStore implements DeliveryStore {
  constructor(private readonly pool: pg.Pool) {}

  /** Giành quyền một lô bằng đúng một câu lệnh (tự commit); xem `CLAIM_SQL`. */
  async claimDue(input: ClaimDueInput): Promise<ClaimedDelivery[]> {
    const { now, leaseUntil, limit } = input;
    const { rows } = await this.pool.query<ClaimRow>(CLAIM_SQL, [
      now,
      leaseUntil,
      limit,
      maxExpiredInBatch(limit),
    ]);
    return rows.map((row) => ({
      id: idFromUuid('delivery', row.id),
      eventId: idFromUuid('event', row.event_id),
      endpointId: idFromUuid('endpoint', row.endpoint_id),
      leaseToken: row.lease_token,
      attemptCount: row.attempt_count,
    }));
  }

  /**
   * Đọc sự kiện + endpoint hiện tại (kể cả đã xóa mềm/tắt, để worker quyết định). Không thấy
   * dòng nào là lỗi dữ liệu (khóa ngoại không cascade, DAT-40) nên ném lỗi.
   */
  async loadTarget(claim: ClaimedDelivery): Promise<DeliveryTarget> {
    const { rows } = await this.pool.query<TargetRow>(
      `SELECT e.id AS event_id, e.type, e.created_at, e.payload,
         p.url, p.secret, p.previous_secret, p.previous_secret_expires_at,
         p.deleted_at, p.disabled_at
       FROM deliveries d
       JOIN events e ON e.id = d.event_id
       JOIN endpoints p ON p.id = d.endpoint_id
       WHERE d.id = $1`,
      [idToUuid(claim.id)],
    );
    const row = rows[0];
    if (!row) throw new Error(`delivery ${claim.id} has no event or endpoint`);
    return {
      event: {
        id: idFromUuid('event', row.event_id),
        type: row.type,
        createdAt: row.created_at,
        payload: row.payload,
      },
      endpoint: {
        url: row.url,
        secret: row.secret,
        previousSecret: row.previous_secret,
        previousSecretExpiresAt: row.previous_secret_expires_at,
        deletedAt: row.deleted_at,
        disabledAt: row.disabled_at,
      },
    };
  }

  /** Kết thúc `failed` vì endpoint đã xóa/tắt; giữ nguyên `attempt_count`, `last_error`. */
  async failForEndpoint(
    claim: ClaimedDelivery,
    input: FailForEndpointInput,
  ): Promise<GuardedWriteResult> {
    const { rowCount } = await this.pool.query(
      `UPDATE deliveries
       SET status = 'failed', failed_reason = $3, lease_until = NULL, lease_token = NULL,
         updated_at = $4
       WHERE id = $1 AND status = 'in_flight' AND lease_token = $2`,
      [idToUuid(claim.id), claim.leaseToken, input.reason, input.now],
    );
    return rowCount === 1 ? 'done' : 'lease_lost';
  }

  /**
   * Ghi kết quả trong một transaction (spec 07 bước 5). Cập nhật delivery TRƯỚC: mất quyền
   * (0 dòng) thì dừng ngay, không ghi attempt. Câu `UPDATE` cũng khóa dòng delivery nên
   * việc tính số attempt kế tiếp không bị ghi song song chen vào.
   */
  recordAttempt(
    claim: ClaimedDelivery,
    input: RecordAttemptInput,
  ): Promise<GuardedWriteResult> {
    return withTransaction(this.pool, async (client) => {
      // 1. Cập nhật delivery có điều kiện mã giữ quyền
      const endpointUuid = await updateDelivery(client, claim, input);
      // 0 dòng: transaction chưa ghi gì, COMMIT rỗng tương đương ROLLBACK.
      if (endpointUuid === null) return 'lease_lost';
      // 2. Thêm attempt, số thứ tự tiếp nối lịch sử
      await insertAttempt(client, claim.id, input.attempt);
      // 3. Cập nhật first_failure_at của endpoint nếu giá trị đổi
      await updateFirstFailure(client, endpointUuid, input);
      return 'done';
    });
  }
}

/**
 * Cập nhật delivery theo quyết định (bảng cập nhật của spec 07): tăng `attempt_count`, đặt
 * `last_error`, `gate_blocked_count` về 0; `next_attempt_at` chỉ đổi khi hẹn lại. Trả UUID
 * endpoint, hoặc `null` nếu mất quyền.
 */
async function updateDelivery(
  client: pg.PoolClient,
  claim: ClaimedDelivery,
  input: RecordAttemptInput,
): Promise<string | null> {
  const { decision, lastError, now } = input;
  // `$5 IS NULL` → giữ nguyên next_attempt_at (succeeded / failed).
  const { rows } = await client.query<{ endpoint_id: string }>(
    `UPDATE deliveries
     SET status = $3, failed_reason = $4,
       next_attempt_at = COALESCE($5::timestamptz, next_attempt_at),
       attempt_count = attempt_count + 1, last_error = $6, gate_blocked_count = 0,
       lease_until = NULL, lease_token = NULL, updated_at = $7
     WHERE id = $1 AND status = 'in_flight' AND lease_token = $2
     RETURNING endpoint_id`,
    [
      idToUuid(claim.id),
      claim.leaseToken,
      decision.status,
      decision.status === 'failed' ? decision.reason : null,
      decision.status === 'pending' ? decision.nextAttemptAt : null,
      lastError,
      now,
    ],
  );
  return rows[0]?.endpoint_id ?? null;
}

/** Thêm attempt với số thứ tự = lớn nhất trong lịch sử + 1, kể cả qua replay (WRK-08). */
async function insertAttempt(
  client: pg.PoolClient,
  deliveryId: Id<'delivery'>,
  attempt: NewAttempt,
): Promise<void> {
  await client.query(
    `INSERT INTO attempts (id, delivery_id, attempt_number, started_at, duration_ms,
       http_status, response_snippet, error)
     SELECT $1, $2, COALESCE(MAX(attempt_number), 0) + 1, $3, $4, $5, $6, $7
     FROM attempts WHERE delivery_id = $2`,
    [
      idToUuid(attempt.id),
      idToUuid(deliveryId),
      attempt.startedAt,
      attempt.durationMs,
      attempt.httpStatus,
      attempt.responseSnippet,
      attempt.error,
    ],
  );
}

/**
 * Cập nhật `first_failure_at` của endpoint, chỉ khi giá trị đổi (RTY-10): thất bại thì đặt nếu
 * đang rỗng, thành công thì xóa nếu đang có. Không ghi thừa để 200 delivery cùng endpoint
 * không tranh nhau khóa dòng endpoint mỗi lần.
 */
async function updateFirstFailure(
  client: pg.PoolClient,
  endpointUuid: string,
  input: { decision: DeliveryDecision; now: Date },
): Promise<void> {
  if (input.decision.status === 'succeeded') {
    await client.query(
      `UPDATE endpoints SET first_failure_at = NULL
       WHERE id = $1 AND first_failure_at IS NOT NULL`,
      [endpointUuid],
    );
    return;
  }
  await client.query(
    `UPDATE endpoints SET first_failure_at = $2
     WHERE id = $1 AND first_failure_at IS NULL`,
    [endpointUuid, input.now],
  );
}
