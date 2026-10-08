import type { HostResolver } from '../../src/features/endpoints/ports/host-resolver.port.js';

/** Bộ phân giải giả: tên nào cũng ra `addresses` (mặc định một IP công cộng); đếm số lần gọi. */
export class FakeHostResolver implements HostResolver {
  /** Các host đã được hỏi, theo thứ tự. */
  calls: string[] = [];

  constructor(private addresses: string[] | Error = ['93.184.216.34']) {}

  /** Đổi kết quả cho các lần gọi sau. */
  answer(addresses: string[] | Error): void {
    this.addresses = addresses;
  }

  /** Ghi lại `host` rồi trả kết quả đã đặt (hoặc ném lỗi). */
  async resolve(host: string): Promise<string[]> {
    this.calls.push(host);
    if (this.addresses instanceof Error) throw this.addresses;
    return this.addresses;
  }
}
