# adapters — hiện thực port, gom theo công nghệ

`postgres`, `redis`, `http-sender` (và `kafka` ở giai đoạn 6).

- Chỉ được import `core`, `platform` và các file `*.port.ts` của features.
- Không import adapter của công nghệ khác, không import apps, không dùng NestJS.
- Mỗi port có một bộ contract test chạy với mọi adapter của nó (ARCH-21).

Chi tiết: `spec/15-code-architecture.md`.
