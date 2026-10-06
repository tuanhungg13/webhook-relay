# apps — điểm khởi động

Mỗi tiến trình một thư mục (`api`, sau này `relay`, `dispatcher`, `worker`, `scheduler`, `reconciler`, `admin`).
Đây là nơi **duy nhất** ghép adapter vào use case.

- Được import mọi khu vực; một tiến trình không import tiến trình khác.
- File ở gốc `src/apps/` là helper khởi động dùng chung cho các tiến trình (vd `nest-logger.ts`).

Chi tiết: `spec/15-code-architecture.md`.
