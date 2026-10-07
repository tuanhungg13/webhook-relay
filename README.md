# Webhook Relay

Hệ thống trung gian nhận sự kiện và gửi webhook tin cậy (at-least-once, retry, DLQ, rate limit, circuit breaker, observability). Dự án học tập.

- Spec: [`spec/00-README.md`](spec/00-README.md)
- Kiến trúc mã nguồn: [`spec/15-code-architecture.md`](spec/15-code-architecture.md)

## Yêu cầu
Node.js ≥ 24.15, pnpm.

## Biến môi trường của `api` và công cụ có Postgres

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `DATABASE_URL` | bắt buộc | Chuỗi kết nối Postgres |
| `DB_POOL_SIZE` | `10` (`api`), `1` (`admin`, `migrate`) | Số kết nối tối đa của pool |
| `DB_STATEMENT_TIMEOUT` | `5s` | Postgres hủy câu lệnh chạy quá lâu (NODE-02); migration chạy lâu cần đặt lớn hơn |
| `DB_IDLE_TX_TIMEOUT` | `30s` | Postgres hủy transaction bỏ dở |
| `MAX_BODY_BYTES` | `262144` | Giới hạn body của `api` (chỉ `api`) |

## Lệnh

| Lệnh | Việc |
|---|---|
| `pnpm install` | Cài dependency |
| `DATABASE_URL=postgres://whr:whr@localhost:5432/whr pnpm start:dev` | Chạy tiến trình `api` ở chế độ watch (cần Postgres) |
| `pnpm build` · `pnpm start:prod` | Build và chạy bản build |
| `pnpm check` | Typecheck + lint + lint ranh giới kiến trúc + unit test + e2e |
| `pnpm lint:arch` | Chỉ kiểm tra ranh giới kiến trúc (ARCH-20) |
| `pnpm db:up` · `pnpm db:down` | Bật / tắt Postgres local (`deploy/compose.yaml`) |
| `DATABASE_URL=postgres://whr:whr@localhost:5432/whr pnpm db:migrate` | Build rồi chạy migration |
| `pnpm test:integration` | Integration test trên Postgres thật (cần `pnpm db:up`) |
| `pnpm build` rồi `DATABASE_URL=… pnpm admin <lệnh>` | Công cụ quản trị: `app create --name`, `key issue --app`, `key revoke --key`, `id decode`, `id encode --kind` (chạy không tham số để xem cách dùng) |
| `pnpm db:schema` | Sinh lại `src/adapters/postgres/schema.sql` (ảnh chụp schema hiện tại) sau khi thêm migration |
