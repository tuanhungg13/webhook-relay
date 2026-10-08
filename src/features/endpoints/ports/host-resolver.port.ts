/** Port phân giải tên miền ra danh sách IP (adapter: `adapters/http-sender/dns-host-resolver`). */
export interface HostResolver {
  /** Trả mọi IP của `host`. Ném lỗi khi không phân giải được hoặc quá thời hạn. */
  resolve(host: string): Promise<string[]>;
}
