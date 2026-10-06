# core — luật nghiệp vụ thuần

Vòng đời delivery, chính sách retry + jitter, chữ ký Standard Webhooks, chính sách IP (SSRF), ID có tiền tố.

- Không I/O, không framework, không package npm (ARCH-10). Được dùng module thuần của Node như `node:crypto`.
- Không import khu vực nào khác.
- Viết test trước (TDD); test chạy không cần Docker (ARCH-22).

Chi tiết: `spec/15-code-architecture.md`.
