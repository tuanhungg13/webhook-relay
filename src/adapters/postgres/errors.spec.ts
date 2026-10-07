import pg from 'pg';
import { isDatabaseUnavailable } from './errors.js';

/** Dựng lỗi giống hệt lỗi Postgres trả về: `DatabaseError` mang mã SQLSTATE trong `code`. */
function databaseError(code: string): pg.DatabaseError {
  const error = new pg.DatabaseError('boom', 0, 'error');
  error.code = code;
  return error;
}

describe('isDatabaseUnavailable', () => {
  it.each(['57014', '08006', '57P01', '53300', '25P03'])(
    'treats SQLSTATE %s as unavailable',
    (code) => {
      expect(isDatabaseUnavailable(databaseError(code))).toBe(true);
    },
  );

  it('does not treat a constraint violation (23505) as unavailable', () => {
    expect(isDatabaseUnavailable(databaseError('23505'))).toBe(false);
  });

  it('recognises an AggregateError with ECONNREFUSED (Postgres is down)', () => {
    const error = Object.assign(new AggregateError([], 'refused'), {
      code: 'ECONNREFUSED',
    });
    expect(isDatabaseUnavailable(error)).toBe(true);
  });

  it.each([
    'Connection terminated due to connection timeout',
    'timeout exceeded when trying to connect',
    'Client has encountered a connection error and is not queryable',
  ])('recognises the pg message %j', (message) => {
    expect(isDatabaseUnavailable(new Error(message))).toBe(true);
  });

  it.each([new TypeError('x is not a function'), 'text', null, undefined])(
    'ignores unrelated value %j',
    (value) => {
      expect(isDatabaseUnavailable(value)).toBe(false);
    },
  );
});
