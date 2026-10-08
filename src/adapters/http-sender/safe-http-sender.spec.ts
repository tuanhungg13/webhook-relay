import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeHostResolver } from '../../../test/fakes/fake-host-resolver.js';
import { parseCidrList } from '../../core/ip-policy.js';
import type { SendRequest } from '../../features/delivery/ports/webhook-sender.port.js';
import { classifyError, SafeHttpSender } from './safe-http-sender.js';

const LOOPBACK_ALLOWLIST = parseCidrList('127.0.0.0/8');

interface Received {
  method?: string;
  url?: string;
  host?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Server cục bộ ghi lại mọi request; `respond` quyết định phản hồi. */
async function listen(
  respond: (res: http.ServerResponse) => void,
  server: http.Server = http.createServer(),
): Promise<{ port: number; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  server.on('request', (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      respond(res);
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    port: (server.address() as AddressInfo).port,
    received,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

const closers: Array<() => Promise<void>> = [];
const senders: SafeHttpSender[] = [];
afterEach(async () => {
  senders.splice(0).forEach((sender) => sender.close());
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** Mở server và đăng ký đóng sau test. */
async function serve(respond: (res: http.ServerResponse) => void) {
  const server = await listen(respond);
  closers.push(server.close);
  return server;
}

function makeSender(
  resolver = new FakeHostResolver(['127.0.0.1']),
  options: Partial<ConstructorParameters<typeof SafeHttpSender>[0]> = {},
) {
  const sender = new SafeHttpSender({
    resolver,
    allowlist: LOOPBACK_ALLOWLIST,
    allowInsecureHttp: true,
    ...options,
  });
  senders.push(sender);
  return { resolver, sender };
}

const request = (url: string): SendRequest => ({
  url,
  headers: { 'webhook-id': 'msg_1', 'content-type': 'application/json' },
  body: Buffer.from('{"a":1}'),
});

describe('SafeHttpSender', () => {
  it('posts the body and headers to the pinned IP, with the original Host (I1)', async () => {
    const server = await serve((res) => res.end('hello'));
    const { sender, resolver } = makeSender();

    const outcome = await sender.send(
      request(`http://hooks.example:${server.port}/in?x=1`),
    );

    expect(outcome).toEqual({
      status: 'ok',
      httpStatus: 200,
      snippet: 'hello',
    });
    expect(resolver.calls).toEqual(['hooks.example']);
    expect(server.received).toHaveLength(1);
    expect(server.received[0]).toMatchObject({
      method: 'POST',
      url: '/in?x=1',
      host: `hooks.example:${server.port}`,
      body: '{"a":1}',
    });
    expect(server.received[0]!.headers['webhook-id']).toBe('msg_1');
  });

  it('blocks an internal IP literal without any connection (U11, I2)', async () => {
    const server = await serve((res) => res.end());
    const resolver = new FakeHostResolver();
    const sender = new SafeHttpSender({
      resolver,
      allowlist: [],
      allowInsecureHttp: true,
    });

    expect(
      await sender.send(request(`http://127.0.0.1:${server.port}/`)),
    ).toEqual({
      status: 'ssrf_blocked',
    });
    expect(server.received).toHaveLength(0);
    expect(resolver.calls).toEqual([]);
  });

  it('blocks a name that resolves to loopback, even next to a public IP (U11)', async () => {
    const server = await serve((res) => res.end());
    const resolver = new FakeHostResolver(['93.184.216.34', '127.0.0.1']);
    const sender = new SafeHttpSender({
      resolver,
      allowlist: [],
      allowInsecureHttp: true,
    });

    expect(
      await sender.send(request(`http://evil.example:${server.port}/`)),
    ).toEqual({
      status: 'ssrf_blocked',
    });
    expect(server.received).toHaveLength(0);
  });

  it('resolves exactly once per send and re-checks the next send (rebinding, KB4, U12)', async () => {
    const server = await serve((res) => res.end());
    const { sender, resolver } = makeSender();
    const url = `http://rebind.example:${server.port}/`;

    expect((await sender.send(request(url))).status).toBe('ok');
    expect(resolver.calls).toHaveLength(1);

    resolver.answer(['10.0.0.5']);
    expect((await sender.send(request(url))).status).toBe('ssrf_blocked');
    expect(resolver.calls).toHaveLength(2);
    expect(server.received).toHaveLength(1);
  });

  it('does not trust a stored URL that is not a valid http(s) URL (KB5)', async () => {
    const { sender } = makeSender();
    expect(await sender.send(request('file:///etc/passwd'))).toEqual({
      status: 'ssrf_blocked',
    });
    expect(await sender.send(request('not a url'))).toEqual({
      status: 'ssrf_blocked',
    });
  });

  it('re-checks the static rules of a stored URL: cleartext http, low port, credentials (SEC-02)', async () => {
    const server = await serve((res) => res.end());
    const { sender } = makeSender(undefined, { allowInsecureHttp: false });
    for (const url of [
      `http://a.example:${server.port}/`,
      'https://a.example:22/',
      'https://user:pw@a.example/',
    ]) {
      expect(await sender.send(request(url))).toEqual({
        status: 'ssrf_blocked',
      });
    }
    expect(server.received).toHaveLength(0);
  });

  it('replaces a caller-supplied Host header with the URL host', async () => {
    const server = await serve((res) => res.end());
    const { sender } = makeSender();
    await sender.send({
      ...request(`http://a.example:${server.port}/`),
      headers: { Host: 'evil.example' },
    });
    expect(server.received[0]!.host).toBe(`a.example:${server.port}`);
  });

  it('reports dns when the host cannot be resolved', async () => {
    const { sender } = makeSender(new FakeHostResolver(new Error('ENOTFOUND')));
    expect(await sender.send(request('http://nope.example:9999/'))).toEqual({
      status: 'dns',
    });
  });

  it('does not follow a redirect: 302 is a failed attempt (KB6, I3)', async () => {
    const target = await serve((res) => res.end());
    const redirecting = await serve((res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${target.port}/` });
      res.end();
    });
    const { sender } = makeSender();

    const outcome = await sender.send(
      request(`http://a.example:${redirecting.port}/`),
    );

    expect(outcome).toMatchObject({ status: 'http_status', httpStatus: 302 });
    expect(target.received).toHaveLength(0);
  });

  it('classifies non-2xx as http_status', async () => {
    const server = await serve((res) => {
      res.statusCode = 503;
      res.end('down');
    });
    const { sender } = makeSender();
    expect(
      await sender.send(request(`http://a.example:${server.port}/`)),
    ).toEqual({ status: 'http_status', httpStatus: 503, snippet: 'down' });
  });

  it('drops NUL bytes from the snippet, which Postgres text rejects (U16)', async () => {
    const server = await serve((res) => res.end('a\0b\0'));
    const { sender } = makeSender();
    expect(
      await sender.send(request(`http://a.example:${server.port}/`)),
    ).toEqual({ status: 'ok', httpStatus: 200, snippet: 'ab' });
  });

  it('reports a status code outside 100..599 as connection_error (U17)', async () => {
    const server = await serve((res) => {
      res.statusCode = 999;
      res.end('odd');
    });
    const { sender } = makeSender();
    expect(
      await sender.send(request(`http://a.example:${server.port}/`)),
    ).toEqual({ status: 'connection_error' });
  });

  it('cuts the snippet at 1 KiB and drops the rest of a 1 MiB response (I4)', async () => {
    const server = await serve((res) => res.end('x'.repeat(1024 * 1024)));
    const { sender } = makeSender();

    const outcome = await sender.send(
      request(`http://a.example:${server.port}/`),
    );

    if (outcome.status !== 'ok') throw new Error(outcome.status);
    expect(outcome.snippet).toHaveLength(1024);
  });

  it('times out when the server never answers (I5)', async () => {
    const server = await serve(() => undefined);
    const { sender } = makeSender(undefined, { requestTimeoutMs: 150 });
    expect(
      await sender.send(request(`http://a.example:${server.port}/`)),
    ).toEqual({ status: 'timeout' });
  });

  it('reports connection_refused for a closed port (I5)', async () => {
    const server = await listen(() => undefined);
    await server.close();
    const { sender } = makeSender();
    expect(
      await sender.send(request(`http://a.example:${server.port}/`)),
    ).toEqual({ status: 'connection_refused' });
  });

  it('ignores HTTP(S)_PROXY from the environment (SEC-04, I6)', async () => {
    const target = await serve((res) => res.end());
    const proxy = await serve((res) => res.end());
    const saved = { ...process.env };
    process.env.HTTP_PROXY =
      process.env.http_proxy = `http://127.0.0.1:${proxy.port}`;
    process.env.HTTPS_PROXY =
      process.env.https_proxy = `http://127.0.0.1:${proxy.port}`;
    try {
      const { sender } = makeSender();
      const outcome = await sender.send(
        request(`http://a.example:${target.port}/`),
      );
      expect(outcome.status).toBe('ok');
    } finally {
      process.env = saved;
    }
    expect(target.received).toHaveLength(1);
    expect(proxy.received).toHaveLength(0);
  });

  it('puts neither the URL nor its query into any outcome (SEC-13, U13)', async () => {
    const { sender } = makeSender(new FakeHostResolver(['10.0.0.5']));
    const outcome = await sender.send(
      request('https://hooks.example/in?token=SECRET123'),
    );
    expect(JSON.stringify(outcome)).not.toMatch(/SECRET123|hooks\.example/);
  });
});

describe('classifyError', () => {
  it.each([
    ['ECONNREFUSED', 'connection_refused'],
    ['ENOTFOUND', 'dns'],
    ['ETIMEDOUT', 'timeout'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls'],
    ['ECONNRESET', 'connection_error'],
  ])('maps %s to %s', (code, status) => {
    expect(classifyError(Object.assign(new Error('x'), { code }))).toEqual({
      status,
    });
  });
});

describe('SafeHttpSender over TLS (SEC-09)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whr-tls-'));
  let cert: { key: string; cert: string } | undefined;
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=other.example',
        '-keyout',
        join(dir, 'k.pem'),
        '-out',
        join(dir, 'c.pem'),
      ],
      { stdio: 'ignore' },
    );
    cert = {
      key: readFileSync(join(dir, 'k.pem'), 'utf8'),
      cert: readFileSync(join(dir, 'c.pem'), 'utf8'),
    };
  } catch {
    cert = undefined; // không có openssl: bỏ qua test này
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  it.skipIf(cert === undefined)(
    'rejects a self-signed certificate and sends no request (KB9)',
    async () => {
      const server = await listen(
        (res) => res.end(),
        https.createServer(cert!) as unknown as http.Server,
      );
      closers.push(server.close);
      const { sender } = makeSender();

      expect(
        await sender.send(request(`https://hooks.example:${server.port}/`)),
      ).toEqual({ status: 'tls' });
      expect(server.received).toHaveLength(0);
    },
  );
});
