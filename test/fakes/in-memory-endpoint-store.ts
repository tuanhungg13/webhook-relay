import type { Id } from '../../src/core/id.js';
import type {
  Endpoint,
  EndpointListQuery,
  EndpointPatch,
  EndpointStore,
} from '../../src/features/endpoints/ports/endpoint-store.port.js';

/** Một dòng endpoint trong bộ nhớ: giống bảng `endpoints`, thêm `deletedAt` (null = chưa xóa). */
interface StoredEndpoint extends Endpoint {
  deletedAt: Date | null;
}

/**
 * Bản giả của `EndpointStore` lưu trong bộ nhớ, dùng cho test không cần Postgres.
 * Chạy qua cùng bộ contract test với bản Postgres (ARCH-21).
 *
 * Luôn trả BẢN SAO (`structuredClone`) như Postgres trả dòng mới mỗi lần đọc: bên gọi sửa
 * object nhận được không làm đổi dữ liệu đã lưu.
 */
export class InMemoryEndpointStore implements EndpointStore {
  private readonly rows = new Map<Id<'endpoint'>, StoredEndpoint>();

  /** Đếm endpoint chưa xóa của (app, customer); đủ `max` thì từ chối. Một luồng nên không cần khóa. */
  insertWithinLimit(
    endpoint: Endpoint,
    max: number,
  ): Promise<'inserted' | 'limit_exceeded'> {
    const count = [...this.rows.values()].filter(
      (row) =>
        row.appId === endpoint.appId &&
        row.customerId === endpoint.customerId &&
        row.deletedAt === null,
    ).length;
    if (count >= max) return Promise.resolve('limit_exceeded');
    this.rows.set(endpoint.id, {
      ...structuredClone(endpoint),
      deletedAt: null,
    });
    return Promise.resolve('inserted');
  }

  /** Tìm endpoint chưa xóa của app. */
  findById(appId: Id<'app'>, id: Id<'endpoint'>): Promise<Endpoint | null> {
    const row = this.live(appId, id);
    return Promise.resolve(row ? toEndpoint(row) : null);
  }

  /**
   * Danh sách mới nhất trước. So chuỗi TypeID cho cùng thứ tự với so UUID trong Postgres:
   * cùng tiền tố, cùng độ dài, và bảng chữ base32 xếp tăng dần theo mã ASCII.
   */
  list(appId: Id<'app'>, query: EndpointListQuery): Promise<Endpoint[]> {
    const { customerId, afterId, limit } = query;
    const found = [...this.rows.values()]
      .filter(
        (row) =>
          row.appId === appId &&
          row.deletedAt === null &&
          (customerId === undefined || row.customerId === customerId) &&
          (afterId === undefined || row.id < afterId),
      )
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, limit);
    return Promise.resolve(found.map(toEndpoint));
  }

  /** Ghi đè các trường có trong `patch`. */
  update(
    appId: Id<'app'>,
    id: Id<'endpoint'>,
    patch: EndpointPatch,
    at: Date,
  ): Promise<Endpoint | null> {
    const row = this.live(appId, id);
    if (!row) return Promise.resolve(null);
    // Bỏ khóa mang giá trị undefined, giống COALESCE bên Postgres giữ nguyên giá trị cũ.
    const present = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    Object.assign(row, structuredClone(present), { updatedAt: at });
    return Promise.resolve(toEndpoint(row));
  }

  /** Đặt `deletedAt`; đã xóa hoặc không có thì false. */
  softDelete(appId: Id<'app'>, id: Id<'endpoint'>, at: Date): Promise<boolean> {
    const row = this.live(appId, id);
    if (!row) return Promise.resolve(false);
    row.deletedAt = at;
    row.updatedAt = at;
    return Promise.resolve(true);
  }

  /** Vô hiệu hóa; lần hai giữ thời điểm và lý do lần đầu. */
  disable(appId: Id<'app'>, id: Id<'endpoint'>, at: Date): Promise<boolean> {
    const row = this.live(appId, id);
    if (!row) return Promise.resolve(false);
    row.disabledAt ??= at;
    row.disabledReason ??= 'manual';
    row.updatedAt = at;
    return Promise.resolve(true);
  }

  /** Kích hoạt lại, xóa các trường lỗi. */
  enable(appId: Id<'app'>, id: Id<'endpoint'>, at: Date): Promise<boolean> {
    const row = this.live(appId, id);
    if (!row) return Promise.resolve(false);
    Object.assign(row, {
      firstFailureAt: null,
      disabledAt: null,
      disabledReason: null,
      updatedAt: at,
    });
    return Promise.resolve(true);
  }

  /** Secret hiện tại thành secret trước, secret mới thành hiện tại. */
  rotateSecret(
    appId: Id<'app'>,
    id: Id<'endpoint'>,
    rotation: { newSecret: string; graceUntil: Date; at: Date },
  ): Promise<Endpoint | null> {
    const row = this.live(appId, id);
    if (!row) return Promise.resolve(null);
    Object.assign(row, {
      previousSecret: row.secret,
      previousSecretExpiresAt: rotation.graceUntil,
      secret: rotation.newSecret,
      updatedAt: rotation.at,
    });
    return Promise.resolve(toEndpoint(row));
  }

  /** Dòng chưa xóa mềm thuộc `appId`, hoặc undefined. */
  private live(
    appId: Id<'app'>,
    id: Id<'endpoint'>,
  ): StoredEndpoint | undefined {
    const row = this.rows.get(id);
    return row && row.appId === appId && row.deletedAt === null
      ? row
      : undefined;
  }
}

/** Bỏ `deletedAt` và trả bản sao, giống một dòng Postgres vừa đọc. */
function toEndpoint(row: StoredEndpoint): Endpoint {
  const { deletedAt: _deletedAt, ...endpoint } = row;
  return structuredClone(endpoint);
}
