# features — mỗi chức năng một thư mục

`ingestion`, `endpoints`, `delivery`, `scheduling`, `reconciliation` (tạo khi bắt đầu làm chức năng đó).

Trong mỗi thư mục chức năng, tách theo vai trò:
- `use-cases/*.use-case.ts` — một hành động của hệ thống; class TypeScript thuần, nhận port qua constructor. Test `*.use-case.spec.ts` đặt cạnh file nó kiểm.
- `ports/*.port.ts` — interface mà use case cần; bên dùng sở hữu interface. Adapter chỉ được import các file này (lint kiến trúc nhận diện bằng hậu tố `.port.ts`).
- `http/` — controller, DTO (NestJS chỉ được xuất hiện ở đây, ARCH-11).

Quy tắc: chỉ import `core` và `platform`; không import chức năng khác (ARCH-12), adapter hay apps.

Chi tiết: `spec/15-code-architecture.md`.
