import { z } from 'zod';
import { ApiError } from './api-error.js';
import { parseWith } from './validate.js';

describe('parseWith', () => {
  const schema = z
    .object({
      name: z.string().max(3),
      tags: z.array(z.string()).min(1),
    })
    .strict();

  it('returns the parsed value when valid', () => {
    expect(parseWith(schema, { name: 'abc', tags: ['x'] })).toEqual({
      name: 'abc',
      tags: ['x'],
    });
  });

  it('throws 422 validation_failed with one detail per field, without echoing values', () => {
    const input = { name: 'super-secret-value', tags: [], extra: 1 };
    let thrown: unknown;
    try {
      parseWith(schema, input);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    const error = thrown as ApiError;
    expect(error.status).toBe(422);
    expect(error.code).toBe('validation_failed');
    const details = error.details as { field: string; message: string }[];
    expect(details.map((d) => d.field).sort()).toEqual(['', 'name', 'tags']);
    expect(JSON.stringify(details)).not.toContain('super-secret-value');
  });

  it('reports a missing body as a single root error', () => {
    expect(() => parseWith(schema, undefined)).toThrow(ApiError);
  });
});
