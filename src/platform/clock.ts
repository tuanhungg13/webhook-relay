/**
 * Đồng hồ của ứng dụng: nguồn DUY NHẤT để lấy "bây giờ" (DAT-22).
 *
 * Mọi mốc thời gian cần so sánh hay hẹn giờ đều lấy từ đây, không dùng now() của Postgres,
 * vì hai đồng hồ lệch nhau sẽ gây lỗi rất khó tìm. Khai báo dạng interface để khi test có thể
 * truyền một đồng hồ đứng yên ở giờ cố định.
 */
export interface Clock {
  /** Trả về thời điểm hiện tại. */
  now(): Date;
}

/** Đồng hồ thật, đọc giờ của máy; các tiến trình trong `apps` dùng nó khi chạy thật. */
export const systemClock: Clock = { now: () => new Date() };
