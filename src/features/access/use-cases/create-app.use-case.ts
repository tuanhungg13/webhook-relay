import { type Id, newId } from '../../../core/id.js';
import type { Clock } from '../../../platform/clock.js';
import type { AccessStore } from '../ports/access-store.port.js';

/**
 * Use case: tạo một app mới. App là khách hàng dùng hệ thống, vd "ShopX".
 *
 * Đồ nghề được truyền vào qua constructor: `store` để lưu dữ liệu, `clock` để lấy giờ.
 * `private readonly` vừa khai báo vừa gán thuộc tính trong một dòng, và không cho gán lại sau đó.
 */
export class CreateApp {
  constructor(
    private readonly store: AccessStore,
    private readonly clock: Clock,
  ) {}

  /**
   * Tạo app tên `input.name` và trả về ID của app mới.
   * Ném lỗi nếu tên rỗng hoặc chỉ toàn khoảng trắng.
   */
  async execute(input: { name: string }): Promise<{ appId: Id<'app'> }> {
    // 1. Bỏ khoảng trắng ở hai đầu tên; còn lại chuỗi rỗng thì từ chối.
    const name = input.name.trim();
    if (name === '') throw new Error('app name must not be blank');

    // 2. Sinh ID từ giờ hiện tại, rồi lưu app vào kho dữ liệu.
    const now = this.clock.now();
    const appId = newId('app', now.getTime());
    await this.store.insertApp({ id: appId, name, createdAt: now });
    return { appId };
  }
}
