# platform — hạ tầng kỹ thuật dùng chung

Cấu hình (kiểm tra lúc khởi động), logger JSON, vòng đời tiến trình (dừng êm, lỗi không bắt được); telemetry ở giai đoạn 4.

- Không chứa luật nghiệp vụ; không import khu vực nào khác; không dùng NestJS.

Chi tiết: `spec/15-code-architecture.md`.
