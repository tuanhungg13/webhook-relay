import type pg from 'pg';

/**
 * Chạy `work` trong một transaction trên một kết nối riêng: `BEGIN`, rồi `COMMIT` nếu `work`
 * xong, `ROLLBACK` nếu ném lỗi (lỗi gốc được ném tiếp, vì đó là thứ có ích để tìm nguyên nhân).
 *
 * Kết nối luôn được trả về pool. `ROLLBACK` cũng lỗi (vd mất kết nối) nghĩa là kết nối đang
 * hỏng: đánh dấu để pool hủy nó thay vì đưa một kết nối kẹt giữa transaction cho request khác.
 * Mức cô lập là READ COMMITTED mặc định của Postgres (ING-03.7).
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let brokenConnection: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
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
