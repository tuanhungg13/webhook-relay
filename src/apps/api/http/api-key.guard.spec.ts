import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticateApiKey } from '../../../features/access/authenticate-api-key.use-case.js';
import { ApiError } from '../../../platform/http/api-error.js';
import { ApiKeyGuard, extractBearerKey } from './api-key.guard.js';

describe('extractBearerKey', () => {
  it.each([
    ['Bearer sk_x', 'sk_x'],
    ['bearer sk_x', 'sk_x'],
    ['BEARER sk_x', 'sk_x'],
  ])('extracts the key from %j', (header, key) => {
    expect(extractBearerKey(header)).toBe(key);
  });

  it.each(['Basic sk_x', 'Bearer', 'Bearer ', 'Bearer a b', ''])(
    'rejects %j',
    (header) => {
      expect(extractBearerKey(header)).toBeNull();
    },
  );

  it('rejects a missing header', () => {
    expect(extractBearerKey(undefined)).toBeNull();
  });
});

describe('ApiKeyGuard', () => {
  /** Dựng ExecutionContext tối thiểu chỉ mang header Authorization. */
  function contextWith(authorization: string | undefined): ExecutionContext {
    const request = {
      header: (name: string) =>
        name === 'authorization' ? authorization : undefined,
    };
    return {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  function setup(result: Awaited<ReturnType<AuthenticateApiKey['execute']>>) {
    const execute = vi.fn().mockResolvedValue(result);
    const guard = new ApiKeyGuard(new Reflector(), {
      execute,
    } as unknown as AuthenticateApiKey);
    return { guard, execute };
  }

  it.each(['Basic x', 'Bearer', undefined])(
    'rejects %j with 401 without calling the use case',
    async (header) => {
      const { guard, execute } = setup(null);
      await expect(
        guard.canActivate(contextWith(header)),
      ).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('rejects an unknown or revoked key with the 401 ApiError', async () => {
    const { guard } = setup(null);
    const error = await guard
      .canActivate(contextWith('Bearer sk_nope'))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it('lets a valid key through and passes the key to the use case', async () => {
    const { guard, execute } = setup({
      appId: 'app_x' as never,
      keyPrefix: 'sk_AbCdE',
    });
    await expect(
      guard.canActivate(contextWith('Bearer sk_real')),
    ).resolves.toBe(true);
    expect(execute).toHaveBeenCalledWith({ apiKey: 'sk_real' });
  });
});
