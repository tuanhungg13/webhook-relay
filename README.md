# Webhook Relay

Hệ thống trung gian nhận sự kiện và gửi webhook tin cậy (at-least-once, retry, DLQ, rate limit, circuit breaker, observability). Dự án học tập.

- Spec: [`spec/00-README.md`](spec/00-README.md)
- Kiến trúc mã nguồn: [`spec/15-code-architecture.md`](spec/15-code-architecture.md)

## Yêu cầu
Node.js ≥ 24.15, pnpm.

## Lệnh

| Lệnh | Việc |
|---|---|
| `pnpm install` | Cài dependency |
| `pnpm start:dev` | Chạy tiến trình `api` ở chế độ watch |
| `pnpm build` · `pnpm start:prod` | Build và chạy bản build |
| `pnpm check` | Typecheck + lint + lint ranh giới kiến trúc + unit test + e2e |
| `pnpm lint:arch` | Chỉ kiểm tra ranh giới kiến trúc (ARCH-20) |
| `pnpm db:up` · `pnpm db:down` | Bật / tắt Postgres local (`deploy/compose.yaml`) |
| `DATABASE_URL=postgres://whr:whr@localhost:5432/whr pnpm db:migrate` | Build rồi chạy migration |
| `pnpm test:integration` | Integration test trên Postgres thật (cần `pnpm db:up`) |
| `pnpm db:schema` | Sinh lại `src/adapters/postgres/schema.sql` (ảnh chụp schema hiện tại) sau khi thêm migration |
