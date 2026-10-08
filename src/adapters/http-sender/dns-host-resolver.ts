import { lookup } from 'node:dns/promises';
import type { HostResolver } from '../../features/endpoints/ports/host-resolver.port.js';

/** Thời hạn phân giải DNS (quyết định #8, `DNS_TIMEOUT`). */
export const DNS_TIMEOUT_MS = 3000;

/** Phân giải tên miền bằng `dns.lookup` của hệ điều hành, trả mọi IP theo đúng thứ tự hệ thống. */
export class DnsHostResolver implements HostResolver {
  /** `timeoutMs` mặc định là `DNS_TIMEOUT_MS`; test truyền số nhỏ hơn. */
  constructor(private readonly timeoutMs: number = DNS_TIMEOUT_MS) {}

  /**
   * Quá thời hạn thì ném lỗi và bỏ kết quả. `lookup` gọi `getaddrinfo` trong threadpool của
   * libuv và không hủy được, nên lời gọi vẫn chạy ngầm, chiếm một thread (mặc định có 4) cho tới
   * khi hệ điều hành trả lời. Nhiều tên miền có DNS cực chậm có thể chiếm hết threadpool và làm
   * chậm file/crypto dùng chung.
   * ponytail: chấp nhận ở giai đoạn 1; nếu đo thấy threadpool nghẽn, đổi sang `dns.Resolver`
   * (c-ares, có timeout, hủy được) và tự xử lý `localhost`/file hosts.
   */
  async resolve(host: string): Promise<string[]> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('dns lookup timed out')),
        this.timeoutMs,
      );
    });
    try {
      const results = await Promise.race([
        lookup(host, { all: true, verbatim: true }),
        timeout,
      ]);
      return results.map((result) => result.address);
    } finally {
      clearTimeout(timer);
    }
  }
}
