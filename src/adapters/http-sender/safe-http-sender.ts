import http from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import { validateEndpointUrl } from '../../core/endpoint-url.js';
import { checkHost } from '../../core/host-check.js';
import { type Cidr, isIpLiteral } from '../../core/ip-policy.js';
import type { HostResolver } from '../../features/endpoints/ports/host-resolver.port.js';
import type {
  SendOutcome,
  SendRequest,
  WebhookSender,
} from '../../features/delivery/ports/webhook-sender.port.js';

/** Thời hạn mở kết nối TCP (spec 07, bảng HTTP client). */
const CONNECT_TIMEOUT_MS = 3000;
/** Thời hạn tổng cho một lần gửi, từ lúc mở kết nối tới khi có đủ phản hồi. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Phần phản hồi giữ lại làm `response_snippet`: 1 KiB. */
const RESPONSE_SNIPPET_BYTES = 1024;
/** Số kết nối keep-alive rảnh tối đa mỗi host. */
const MAX_FREE_SOCKETS = 10;
/** Cổng mặc định của https. */
const HTTPS_PORT = 443;
/** Cổng mặc định của http (chỉ dùng khi `ALLOW_INSECURE_HTTP`). */
const HTTP_PORT = 80;
/** Scheme https của `URL.protocol`; scheme còn lại đã được `validateEndpointUrl` kiểm. */
const HTTPS_PROTOCOL = 'https:';

/** Mã lỗi TLS/chứng chỉ của Node và OpenSSL (SEC-09). */
const TLS_ERROR_CODE =
  /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|ERR_OSSL_)/;

/** Thứ bộ gửi cần; hai timeout chỉ để test rút ngắn. */
export interface SafeHttpSenderOptions {
  resolver: HostResolver;
  allowlist: readonly Cidr[];
  /** Cho phép URL `http://` (chỉ dev/test, `ALLOW_INSECURE_HTTP`); mặc định chỉ https. */
  allowInsecureHttp?: boolean;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/**
 * Bộ gửi webhook chống SSRF (SEC-01..04, SEC-09). Tự phân giải host, kiểm MỌI IP, ghim IP đầu
 * tiên rồi kết nối thẳng tới IP đó với `Host`/`servername` là tên gốc. Không có lần phân giải
 * thứ hai nên DNS rebinding không có chỗ chen vào; host là IP viết thẳng cũng đi cùng đường.
 * Không theo redirect, không dùng proxy từ môi trường (Agent riêng không có `proxyEnv`),
 * luôn xác minh chứng chỉ.
 */
export class SafeHttpSender implements WebhookSender {
  private readonly httpAgent = new http.Agent({
    keepAlive: true,
    maxFreeSockets: MAX_FREE_SOCKETS,
  });
  private readonly httpsAgent = new https.Agent({
    keepAlive: true,
    maxFreeSockets: MAX_FREE_SOCKETS,
  });

  constructor(private readonly options: SafeHttpSenderOptions) {}

  /** Gửi một lần; mọi thất bại trả về dưới dạng `SendOutcome`, không ném lỗi. */
  async send(request: SendRequest): Promise<SendOutcome> {
    // URL lưu trong DB không được tin (SEC-02): kiểm lại cả luật tĩnh (scheme, cổng, user:pass@).
    // Sai luật thì bị chặn như SSRF, chưa mở kết nối nào.
    const staticError = validateEndpointUrl(request.url, {
      allowInsecureHttp: this.options.allowInsecureHttp ?? false,
    });
    const url = staticError === null ? URL.parse(request.url) : null;
    if (!url) return { status: 'ssrf_blocked' };
    const check = await checkHost(
      url.hostname,
      (host) => this.options.resolver.resolve(host),
      this.options.allowlist,
    );
    switch (check.status) {
      case 'blocked':
        return { status: 'ssrf_blocked' };
      case 'unresolved':
        return { status: 'dns' };
      case 'ok':
        // ponytail: chỉ thử IP đầu tiên; thử IP kế tiếp (happy eyeballs) khi đo thấy cần.
        return this.post(url, check.address, request);
    }
  }

  /** Mở kết nối tới `address` (đã kiểm) và gửi POST; trả khi có phản hồi, lỗi hoặc hết giờ. */
  private post(
    url: URL,
    address: string,
    request: SendRequest,
  ): Promise<SendOutcome> {
    const secure = url.protocol === HTTPS_PROTOCOL;
    return new Promise((resolve) => {
      const timers: NodeJS.Timeout[] = [];
      let settled = false;
      /** Chốt kết quả đúng một lần và dọn timer; bên gọi tự hủy request nếu cần. */
      const settle = (outcome: SendOutcome) => {
        if (settled) return;
        settled = true;
        timers.forEach(clearTimeout);
        resolve(outcome);
      };

      const req = (secure ? https : http).request({
        agent: secure ? this.httpsAgent : this.httpAgent,
        host: address,
        port: url.port || (secure ? HTTPS_PORT : HTTP_PORT),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          ...withoutHost(request.headers),
          host: url.host,
          'content-length': request.body.length,
        },
        // Chứng chỉ xác minh theo tên gốc, không theo IP đã ghim (SEC-09).
        // Host là IP viết thẳng thì không đặt servername (SNI không nhận IP).
        servername: isIpLiteral(url.hostname) ? undefined : url.hostname,
      });
      /** Chốt kết quả rồi hủy request (timeout, đã đủ snippet). */
      const abort = (outcome: SendOutcome) => {
        settle(outcome);
        req.destroy();
      };

      timers.push(
        setTimeout(
          () => abort({ status: 'timeout' }),
          this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
        ),
      );
      req.on('socket', (socket) =>
        this.watchConnect(socket, timers, () => abort({ status: 'timeout' })),
      );
      req.on('error', (error: NodeJS.ErrnoException) =>
        settle(classifyError(error)),
      );
      req.on('response', (res) => readResponse(res, settle, abort));
      req.end(request.body);
    });
  }

  /** Đóng các kết nối keep-alive đang rảnh; gọi khi tiến trình tắt. */
  close(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  /** Socket mới chưa nối xong thì đặt timer kết nối; nối xong (`connect`) thì hủy timer. */
  private watchConnect(
    socket: Socket,
    timers: NodeJS.Timeout[],
    onTimeout: () => void,
  ): void {
    if (!socket.connecting) return;
    const timer = setTimeout(
      onTimeout,
      this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    );
    timers.push(timer);
    socket.once('connect', () => clearTimeout(timer));
  }
}

/**
 * Đọc tối đa `RESPONSE_SNIPPET_BYTES` đầu của phản hồi. Đủ 1 KiB thì `abort` (bỏ phần còn
 * lại, không đọc hết phản hồi lớn); hết phản hồi sớm hơn thì `settle`.
 */
function readResponse(
  res: http.IncomingMessage,
  settle: (outcome: SendOutcome) => void,
  abort: (outcome: SendOutcome) => void,
): void {
  const chunks: Buffer[] = [];
  let length = 0;
  /** Kết quả theo mã HTTP, kèm phần đầu phản hồi đã đọc. */
  const outcome = (): SendOutcome => {
    const httpStatus = res.statusCode ?? 0;
    return {
      status: httpStatus >= 200 && httpStatus < 300 ? 'ok' : 'http_status',
      httpStatus,
      snippet: Buffer.concat(chunks)
        .subarray(0, RESPONSE_SNIPPET_BYTES)
        .toString('utf8'),
    };
  };
  res.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
    length += chunk.length;
    if (length >= RESPONSE_SNIPPET_BYTES) abort(outcome());
  });
  res.on('end', () => settle(outcome()));
  res.on('error', (error: NodeJS.ErrnoException) =>
    settle(classifyError(error)),
  );
}

/** Bỏ header `Host` (không phân biệt hoa thường) của caller: bộ gửi tự đặt theo URL. */
function withoutHost(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'host'),
  );
}

/** Đổi lỗi socket của Node ra nhãn kết quả; lỗi lạ rơi vào `connection_error` để không mất dấu. */
export function classifyError(error: NodeJS.ErrnoException): SendOutcome {
  const code = error.code ?? '';
  if (code === 'ECONNREFUSED') return { status: 'connection_refused' };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { status: 'dns' };
  if (code === 'ETIMEDOUT') return { status: 'timeout' };
  if (TLS_ERROR_CODE.test(code)) return { status: 'tls' };
  return { status: 'connection_error' };
}
