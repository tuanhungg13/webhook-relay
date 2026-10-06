# features — mỗi chức năng một thư mục

`ingestion`, `endpoints`, `delivery`, `scheduling`, `reconciliation` (tạo khi bắt đầu làm chức năng đó).

Trong mỗi thư mục chức năng:
- `*.use-case.ts` — một hành động của hệ thống; class TypeScript thuần, nhận port qua constructor.
- `*.port.ts` — interface mà use case cần; bên dùng sở hữu interface. Adapter chỉ được import các file này.
- `http/` — controller, DTO (NestJS chỉ được xuất hiện ở đây, ARCH-11).

Quy tắc: chỉ import `core` và `platform`; không import chức năng khác (ARCH-12), adapter hay apps.

Chi tiết: `spec/15-code-architecture.md`.
