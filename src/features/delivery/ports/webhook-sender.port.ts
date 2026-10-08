/** Một request webhook cần gửi: POST `body` tới `url` kèm `headers` (đã ký). */
export interface SendRequest {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * Kết quả một lần gửi (spec 07, phân loại kết quả). Không kết quả nào mang URL hay header,
 * để log/lỗi không lộ bí mật nằm trong URL (SEC-13).
 * - `ok`: đích trả 2xx; `http_status`: đích trả mã khác 2xx (kể cả 3xx, không theo redirect);
 *   cả hai kèm `snippet` là tối đa 1 KiB đầu của phản hồi;
 * - `ssrf_blocked`: một IP của host không được phép; chưa mở kết nối nào;
 * - `dns`: không phân giải được host; `tls`: lỗi chứng chỉ/TLS; `timeout`;
 *   `connection_refused`; `connection_error`: lỗi kết nối khác.
 */
export type SendOutcome =
  | { status: 'ok' | 'http_status'; httpStatus: number; snippet: string }
  | {
      status:
        | 'ssrf_blocked'
        | 'dns'
        | 'tls'
        | 'timeout'
        | 'connection_refused'
        | 'connection_error';
    };

/** Port gửi một request webhook ra ngoài (adapter: `adapters/http-sender`). */
export interface WebhookSender {
  /** Gửi một lần, không retry. Không ném lỗi: mọi thất bại là một `SendOutcome`. */
  send(request: SendRequest): Promise<SendOutcome>;
}
