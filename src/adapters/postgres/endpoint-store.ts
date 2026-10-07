import type pg from 'pg';
import { type Id, idFromUuid, idToUuid } from '../../core/id.js';
import type {
  Endpoint,
  EndpointDisabledReason,
  EndpointListQuery,
  EndpointPatch,
  EndpointStore,
} from '../../features/endpoints/ports/endpoint-store.port.js';

/** Các cột đọc ra của bảng `endpoints`, dùng chung cho mọi câu `SELECT`/`RETURNING`. */
const COLUMNS = `id, app_id, customer_id, url, event_types, secret, previous_secret,
  previous_secret_expires_at, rate_limit_rps, max_concurrency, first_failure_at,
  disabled_at, disabled_reason, created_at, updated_at`;

/**
 * Điều kiện "endpoint `$1` của app `$2`, chưa xóa mềm" có mặt trong mọi câu đọc/ghi một endpoint.
 * Không khớp thì 0 dòng: không tồn tại, của app khác hay đã xóa đều như nhau (API-04, API-33).
 */
const OWNED_LIVE = 'id = $1 AND app_id = $2 AND deleted_at IS NULL';

/** Một dòng `endpoints` như `pg` trả về: uuid là chuỗi, timestamptz là `Date`, text[] là mảng. */
interface EndpointRow {
  id: string;
  app_id: string;
  customer_id: string;
  url: string;
  event_types: string[];
  secret: string;
  previous_secret: string | null;
  previous_secret_expires_at: Date | null;
  rate_limit_rps: number;
  max_concurrency: number;
  first_failure_at: Date | null;
  disabled_at: Date | null;
  disabled_reason: EndpointDisabledReason | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Hiện thực port `EndpointStore` bằng Postgres (bảng `endpoints`).
 *
 * Chỉ hàm tạo cần transaction (đếm rồi chèn). Mọi thao tác khác là MỘT câu
 * `UPDATE ... WHERE ... RETURNING`: Postgres chạy mỗi câu nguyên tử, nên không cần transaction.
 * TypeID đổi sang UUID ở đây (DAT-03); giá trị truyền qua tham số `$n` để chống SQL injection.
 */
export class PostgresEndpointStore implements EndpointStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Tạo endpoint trong giới hạn `max` của (app, customer) (API-30).
   *
   * Vì sao cần khóa: hai transaction cùng đếm được 19 rồi cùng chèn sẽ thành 21. Khóa advisory
   * (khóa do ứng dụng tự đặt tên bằng một số, Postgres chỉ giữ hộ) theo (app, customer) bắt các
   * request cùng customer xếp hàng qua đoạn đếm-rồi-chèn. Đã đo: không khóa 40 request song song
   * tạo 25 dòng với giới hạn 20; có khóa đúng 20.
   */
  async insertWithinLimit(
    endpoint: Endpoint,
    max: number,
  ): Promise<'inserted' | 'limit_exceeded'> {
    const appUuid = idToUuid(endpoint.appId);
    const client = await this.pool.connect();
    // Lỗi khiến kết nối không dùng lại được; truyền cho `release` để pool hủy kết nối đó.
    let brokenConnection: Error | undefined;
    try {
      await client.query('BEGIN');
      // 1. `_xact_` = khóa tự nhả khi transaction kết thúc (COMMIT hoặc ROLLBACK), không cần mở.
      //    `hashtextextended` băm chuỗi ra số 64 bit làm tên khóa. Hai customer khác nhau mà
      //    trùng số băm chỉ phải chờ nhau, kết quả vẫn đúng.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`endpoints:${appUuid}:${endpoint.customerId}`],
      );
      // 2. Đếm endpoint chưa xóa mềm của customer; disabled vẫn tính (API-30, API-33).
      const { rows } = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM endpoints
         WHERE app_id = $1 AND customer_id = $2 AND deleted_at IS NULL`,
        [appUuid, endpoint.customerId],
      );
      if ((rows[0]?.count ?? 0) >= max) {
        await client.query('ROLLBACK');
        return 'limit_exceeded';
      }
      // 3. Chèn rồi COMMIT; COMMIT nhả khóa cho request tiếp theo.
      await insertRow(client, endpoint);
      await client.query('COMMIT');
      return 'inserted';
    } catch (error) {
      // Lỗi giữa chừng: hủy transaction rồi ném tiếp lỗi gốc (thứ có ích để tìm nguyên nhân).
      // ROLLBACK cũng lỗi (vd mất kết nối) thì kết nối đang hỏng: đánh dấu để pool hủy nó thay
      // vì đưa một kết nối kẹt giữa transaction cho request khác.
      await client.query('ROLLBACK').catch((rollbackError: unknown) => {
        brokenConnection =
          rollbackError instanceof Error
            ? rollbackError
            : new Error('ROLLBACK failed');
      });
      throw error;
    } finally {
      client.release(brokenConnection);
    }
  }

  /** Đọc một endpoint chưa xóa của app. */
  async findById(
    appId: Id<'app'>,
    id: Id<'endpoint'>,
  ): Promise<Endpoint | null> {
    const { rows } = await this.pool.query<EndpointRow>(
      `SELECT ${COLUMNS} FROM endpoints WHERE ${OWNED_LIVE}`,
      [idToUuid(id), idToUuid(appId)],
    );
    return rows[0] ? toEndpoint(rows[0]) : null;
  }

  /**
   * Danh sách mới nhất trước, phân trang theo ID (keyset: "lấy các dòng có ID nhỏ hơn ID cuối
   * trang trước", không dùng OFFSET nên trang sâu vẫn nhanh).
   *
   * `$2::text IS NULL OR ...`: tham số null thì bỏ điều kiện đó. `pg` gửi giá trị tham số cùng
   * lúc lập kế hoạch truy vấn, nên Postgres rút gọn điều kiện thừa và vẫn dùng đúng chỉ mục:
   * `endpoints_by_customer` khi lọc customer, `endpoints_by_app` khi không.
   */
  async list(appId: Id<'app'>, query: EndpointListQuery): Promise<Endpoint[]> {
    const { rows } = await this.pool.query<EndpointRow>(
      `SELECT ${COLUMNS} FROM endpoints
       WHERE app_id = $1 AND deleted_at IS NULL
         AND ($2::text IS NULL OR customer_id = $2)
         AND ($3::uuid IS NULL OR id < $3)
       ORDER BY id DESC
       LIMIT $4`,
      [
        idToUuid(appId),
        query.customerId ?? null,
        query.afterId ? idToUuid(query.afterId) : null,
        query.limit,
      ],
    );
    return rows.map(toEndpoint);
  }

  /** Sửa một phần: `COALESCE($n, cột)` giữ giá trị cũ khi trường không được gửi (tham số null). */
  async update(
    appId: Id<'app'>,
    id: Id<'endpoint'>,
    patch: EndpointPatch,
    at: Date,
  ): Promise<Endpoint | null> {
    const { rows } = await this.pool.query<EndpointRow>(
      `UPDATE endpoints SET
         url = COALESCE($3, url),
         event_types = COALESCE($4::text[], event_types),
         rate_limit_rps = COALESCE($5, rate_limit_rps),
         max_concurrency = COALESCE($6, max_concurrency),
         updated_at = $7
       WHERE ${OWNED_LIVE}
       RETURNING ${COLUMNS}`,
      [
        idToUuid(id),
        idToUuid(appId),
        patch.url ?? null,
        patch.eventTypes ?? null,
        patch.rateLimitRps ?? null,
        patch.maxConcurrency ?? null,
        at,
      ],
    );
    return rows[0] ? toEndpoint(rows[0]) : null;
  }

  /** Xóa mềm: đặt `deleted_at`; dòng vẫn còn để delivery cũ tra được endpoint (API-33). */
  async softDelete(
    appId: Id<'app'>,
    id: Id<'endpoint'>,
    at: Date,
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE endpoints SET deleted_at = $3, updated_at = $3 WHERE ${OWNED_LIVE}`,
      [idToUuid(id), idToUuid(appId), at],
    );
    return rowCount === 1;
  }

  /** Vô hiệu hóa; `COALESCE` giữ thời điểm và lý do cũ nếu đã bị vô hiệu hóa từ trước. */
  async disable(
    appId: Id<'app'>,
    id: Id<'endpoint'>,
    at: Date,
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE endpoints SET
         disabled_at = COALESCE(disabled_at, $3),
         disabled_reason = COALESCE(disabled_reason, 'manual'),
         updated_at = $3
       WHERE ${OWNED_LIVE}`,
      [idToUuid(id), idToUuid(appId), at],
    );
    return rowCount === 1;
  }

  /** Kích hoạt lại; không đụng circuit breaker trong Redis (API-34). */
  async enable(
    appId: Id<'app'>,
    id: Id<'endpoint'>,
    at: Date,
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE endpoints SET
         first_failure_at = NULL, disabled_at = NULL, disabled_reason = NULL,
         updated_at = $3
       WHERE ${OWNED_LIVE}`,
      [idToUuid(id), idToUuid(appId), at],
    );
    return rowCount === 1;
  }

  /**
   * Xoay secret trong một câu UPDATE. Vế phải của `SET` luôn đọc giá trị CŨ của dòng, nên
   * `previous_secret = secret` lấy secret trước khi bị thay bằng `$3` (API-35).
   */
  async rotateSecret(
    appId: Id<'app'>,
    id: Id<'endpoint'>,
    rotation: { newSecret: string; graceUntil: Date; at: Date },
  ): Promise<Endpoint | null> {
    const { rows } = await this.pool.query<EndpointRow>(
      `UPDATE endpoints SET
         previous_secret = secret,
         previous_secret_expires_at = $4,
         secret = $3,
         updated_at = $5
       WHERE ${OWNED_LIVE}
       RETURNING ${COLUMNS}`,
      [
        idToUuid(id),
        idToUuid(appId),
        rotation.newSecret,
        rotation.graceUntil,
        rotation.at,
      ],
    );
    return rows[0] ? toEndpoint(rows[0]) : null;
  }
}

/** Chèn `endpoint` thành một dòng mới bằng `client` đang trong transaction. */
async function insertRow(
  client: pg.PoolClient,
  endpoint: Endpoint,
): Promise<void> {
  await client.query(
    `INSERT INTO endpoints (id, app_id, customer_id, url, event_types, secret,
       previous_secret, previous_secret_expires_at, rate_limit_rps, max_concurrency,
       first_failure_at, disabled_at, disabled_reason, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      idToUuid(endpoint.id),
      idToUuid(endpoint.appId),
      endpoint.customerId,
      endpoint.url,
      endpoint.eventTypes,
      endpoint.secret,
      endpoint.previousSecret,
      endpoint.previousSecretExpiresAt,
      endpoint.rateLimitRps,
      endpoint.maxConcurrency,
      endpoint.firstFailureAt,
      endpoint.disabledAt,
      endpoint.disabledReason,
      endpoint.createdAt,
      endpoint.updatedAt,
    ],
  );
}

/** Đổi một dòng database sang `Endpoint`; UUID thành TypeID (DAT-03). */
function toEndpoint(row: EndpointRow): Endpoint {
  return {
    id: idFromUuid('endpoint', row.id),
    appId: idFromUuid('app', row.app_id),
    customerId: row.customer_id,
    url: row.url,
    eventTypes: row.event_types,
    secret: row.secret,
    previousSecret: row.previous_secret,
    previousSecretExpiresAt: row.previous_secret_expires_at,
    rateLimitRps: row.rate_limit_rps,
    maxConcurrency: row.max_concurrency,
    firstFailureAt: row.first_failure_at,
    disabledAt: row.disabled_at,
    disabledReason: row.disabled_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
