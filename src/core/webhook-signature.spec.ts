import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  serializeWebhookBody,
  signingSecrets,
  signWebhook,
} from './webhook-signature.js';
import { generateWebhookSecret } from './webhook-secret.js';

/** Vector chính thức của Standard Webhooks (test `sign function works`): SIG-02. */
const VECTOR_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const VECTOR_ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
const VECTOR_BODY = Buffer.from('{"test": 2432232314}');
const VECTOR_SIGNATURE = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=';
const VECTOR_SECONDS = 1614265330;

/** Secret hợp lệ dạng `whsec_` + base64 của `n` byte, dùng để thử biên độ dài khóa. */
function secretOfBytes(n: number): string {
  return 'whsec_' + randomBytes(n).toString('base64');
}

/** Tạo input ký mặc định theo vector, cho phép ghi đè từng trường. */
function input(overrides: Partial<Parameters<typeof signWebhook>[0]> = {}) {
  return {
    webhookId: VECTOR_ID,
    sentAt: new Date(VECTOR_SECONDS * 1000),
    body: VECTOR_BODY,
    secrets: [VECTOR_SECRET],
    ...overrides,
  };
}

describe('signWebhook', () => {
  it('U1: khớp vector chính thức Standard Webhooks (SIG-02)', () => {
    expect(signWebhook(input())).toEqual({
      'webhook-id': VECTOR_ID,
      'webhook-timestamp': '1614265330',
      'webhook-signature': VECTOR_SIGNATURE,
    });
  });

  it('U2: timestamp làm tròn xuống giây', () => {
    const headers = signWebhook(
      input({ sentAt: new Date(VECTOR_SECONDS * 1000 + 999) }),
    );
    expect(headers['webhook-timestamp']).toBe('1614265330');
    expect(headers['webhook-signature']).toBe(VECTOR_SIGNATURE);
  });

  it('U3: hai secret cho hai chữ ký cách nhau một dấu cách, secret đầu đứng trước', () => {
    const other = generateWebhookSecret();
    const both = signWebhook(input({ secrets: [VECTOR_SECRET, other] }));
    const alone = signWebhook(input({ secrets: [other] }));
    expect(both['webhook-signature']).toBe(
      `${VECTOR_SIGNATURE} ${alone['webhook-signature']}`,
    );
  });

  it('U4: danh sách secret rỗng thì ném lỗi', () => {
    expect(() => signWebhook(input({ secrets: [] }))).toThrow();
  });

  it.each([
    ['thiếu tiền tố', 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'],
    ['ký tự lạ', 'whsec_ab!!cd'],
    [
      'thiếu padding',
      'whsec_' + randomBytes(32).toString('base64').replace(/=+$/, ''),
    ],
    ['base64url', 'whsec_' + Buffer.alloc(32, 0xfb).toString('base64url')],
    ['có khoảng trắng', 'whsec_ ' + randomBytes(32).toString('base64')],
    ['quá ngắn (23 byte)', secretOfBytes(23)],
    ['quá dài (65 byte)', secretOfBytes(65)],
    [
      'bit thừa cuối chuỗi',
      'whsec_' + Buffer.alloc(31).toString('base64').slice(0, -3) + 'B==',
    ],
  ])(
    'U5: secret sai dạng (%s) thì ném lỗi, không lộ secret, không có cause',
    (_name, secret) => {
      let caught: unknown;
      try {
        signWebhook(input({ secrets: [secret] }));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error;
      const body = secret.slice('whsec_'.length).trim();
      expect(String(error)).not.toContain(secret);
      expect(error.stack ?? '').not.toContain(secret);
      if (body.length > 0)
        expect(String(error) + (error.stack ?? '')).not.toContain(body);
      expect(error.cause).toBeUndefined();
    },
  );

  it.each([24, 32, 64])('U5: secret %i byte hợp lệ', (n) => {
    expect(() =>
      signWebhook(input({ secrets: [secretOfBytes(n)] })),
    ).not.toThrow();
  });

  it('U5: secret do generateWebhookSecret sinh ra hợp lệ', () => {
    expect(() =>
      signWebhook(input({ secrets: [generateWebhookSecret()] })),
    ).not.toThrow();
  });

  it('U7: đổi body, id hoặc timestamp thì chữ ký khác', () => {
    const base = signWebhook(input())['webhook-signature'];
    expect(
      signWebhook(input({ body: Buffer.from('{"test": 2432232315}') }))[
        'webhook-signature'
      ],
    ).not.toBe(base);
    expect(
      signWebhook(input({ webhookId: 'msg_other' }))['webhook-signature'],
    ).not.toBe(base);
    expect(
      signWebhook(input({ sentAt: new Date((VECTOR_SECONDS + 1) * 1000) }))[
        'webhook-signature'
      ],
    ).not.toBe(base);
  });

  it('U9: sentAt không hợp lệ thì ném lỗi', () => {
    expect(() =>
      signWebhook(input({ sentAt: new Date(Number.NaN) })),
    ).toThrow();
  });

  it('tính đúng HMAC-SHA256 trên id.timestamp.body với khóa đã giải mã base64', () => {
    const secret = generateWebhookSecret();
    const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
    const expected = createHmac('sha256', key)
      .update(
        Buffer.concat([
          Buffer.from(`${VECTOR_ID}.${VECTOR_SECONDS}.`),
          VECTOR_BODY,
        ]),
      )
      .digest('base64');
    expect(signWebhook(input({ secrets: [secret] }))['webhook-signature']).toBe(
      `v1,${expected}`,
    );
  });
});

describe('serializeWebhookBody', () => {
  const createdAt = new Date('2026-10-07T10:00:00.000Z');

  it('U6: key đúng thứ tự type, timestamp, data; timestamp dạng ISO', () => {
    const body = serializeWebhookBody({
      type: 'order.created',
      createdAt,
      payload: { a: 1 },
    });
    expect(body.toString('utf8')).toBe(
      '{"type":"order.created","timestamp":"2026-10-07T10:00:00.000Z","data":{"a":1}}',
    );
  });

  it('U6: giữ key __proto__ trong data', () => {
    const payload = JSON.parse('{"__proto__":{"x":1}}') as unknown;
    const body = serializeWebhookBody({ type: 't', createdAt, payload });
    expect(body.toString('utf8')).toContain('"data":{"__proto__":{"x":1}}');
  });

  it('U6: tiếng Việt và emoji ra đúng byte UTF-8', () => {
    const body = serializeWebhookBody({
      type: 't',
      createdAt,
      payload: { s: 'Việt 😀' },
    });
    expect(body.includes(Buffer.from('Việt 😀', 'utf8'))).toBe(true);
  });

  it('U6: createdAt không hợp lệ thì ném lỗi', () => {
    expect(() =>
      serializeWebhookBody({
        type: 't',
        createdAt: new Date(Number.NaN),
        payload: {},
      }),
    ).toThrow();
  });

  it('U6: payload undefined thì ném lỗi', () => {
    expect(() =>
      serializeWebhookBody({ type: 't', createdAt, payload: undefined }),
    ).toThrow();
  });
});

describe('signingSecrets', () => {
  const now = new Date('2026-10-07T10:00:00.000Z');
  const expiresAt = new Date('2026-10-08T10:00:00.000Z');
  const current = 'whsec_current';
  const previous = 'whsec_previous';

  it('U8: không có secret cũ thì chỉ secret hiện tại', () => {
    expect(
      signingSecrets(
        {
          secret: current,
          previousSecret: null,
          previousSecretExpiresAt: null,
        },
        now,
      ),
    ).toEqual([current]);
  });

  it('U8: secret cũ còn hạn thì thêm vào sau secret hiện tại', () => {
    expect(
      signingSecrets(
        {
          secret: current,
          previousSecret: previous,
          previousSecretExpiresAt: expiresAt,
        },
        now,
      ),
    ).toEqual([current, previous]);
  });

  it('U8: đúng thời điểm hết hạn thì bỏ secret cũ', () => {
    expect(
      signingSecrets(
        {
          secret: current,
          previousSecret: previous,
          previousSecretExpiresAt: expiresAt,
        },
        expiresAt,
      ),
    ).toEqual([current]);
  });

  it('U8: quá hạn thì bỏ secret cũ', () => {
    const late = new Date(expiresAt.getTime() + 1);
    expect(
      signingSecrets(
        {
          secret: current,
          previousSecret: previous,
          previousSecretExpiresAt: expiresAt,
        },
        late,
      ),
    ).toEqual([current]);
  });

  it('U8: có secret cũ nhưng hạn null thì bỏ secret cũ', () => {
    expect(
      signingSecrets(
        {
          secret: current,
          previousSecret: previous,
          previousSecretExpiresAt: null,
        },
        now,
      ),
    ).toEqual([current]);
  });

  it('U8: có hạn nhưng secret cũ null thì chỉ secret hiện tại', () => {
    expect(
      signingSecrets(
        {
          secret: current,
          previousSecret: null,
          previousSecretExpiresAt: expiresAt,
        },
        now,
      ),
    ).toEqual([current]);
  });

  it('U9: now không hợp lệ thì ném lỗi', () => {
    expect(() =>
      signingSecrets(
        {
          secret: current,
          previousSecret: previous,
          previousSecretExpiresAt: expiresAt,
        },
        new Date(Number.NaN),
      ),
    ).toThrow();
  });

  it('U9: hạn secret cũ không hợp lệ thì ném lỗi', () => {
    expect(() =>
      signingSecrets(
        {
          secret: current,
          previousSecret: previous,
          previousSecretExpiresAt: new Date(Number.NaN),
        },
        now,
      ),
    ).toThrow();
  });
});
