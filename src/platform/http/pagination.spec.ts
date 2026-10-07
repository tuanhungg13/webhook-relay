import { z } from 'zod';
import { ApiError } from './api-error.js';
import { decodeCursor, encodeCursor, paginationQuery } from './pagination.js';

describe('paginationQuery', () => {
  const schema = z.object(paginationQuery);

  it('defaults limit to 20 and leaves cursor out', () => {
    expect(schema.parse({})).toEqual({ limit: 20 });
  });

  it.each([
    ['1', 1],
    ['100', 100],
  ])('accepts limit=%s', (limit, expected) => {
    expect(schema.parse({ limit }).limit).toBe(expected);
  });

  it.each(['0', '101', 'abc', '1.5', ''])('rejects limit=%j', (limit) => {
    expect(schema.safeParse({ limit }).success).toBe(false);
  });
});

describe('cursor', () => {
  /** Bộ đọc ID giả: chỉ nhận chuỗi bắt đầu bằng `ep_`. */
  const parseEp = (id: string) => (id.startsWith('ep_') ? id : null);

  it('round-trips an id', () => {
    const cursor = encodeCursor('ep_123');
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, parseEp)).toBe('ep_123');
  });

  it.each([
    ['not base64 json', 'garbage!'],
    ['json without id', Buffer.from('{"x":1}').toString('base64url')],
    ['id of the wrong kind', encodeCursor('evt_123')],
    ['non-string id', Buffer.from('{"id":5}').toString('base64url')],
    ['json null', Buffer.from('null').toString('base64url')],
  ])('rejects %s with 422', (_case, cursor) => {
    expect(() => decodeCursor(cursor, parseEp)).toThrow(ApiError);
    try {
      decodeCursor(cursor, parseEp);
    } catch (error) {
      expect((error as ApiError).status).toBe(422);
      expect((error as ApiError).code).toBe('validation_failed');
    }
  });
});
