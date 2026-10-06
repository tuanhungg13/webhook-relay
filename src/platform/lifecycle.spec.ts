import type { MockInstance } from 'vitest';
import { shutdownGracefully } from './lifecycle.js';
import type { Logger } from './logger.js';

const silentLogger = { info: vi.fn(), error: vi.fn() } as unknown as Logger;

describe('shutdownGracefully', () => {
  let exit: MockInstance<typeof process.exit>;

  beforeEach(() => {
    vi.useFakeTimers();
    exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as typeof process.exit);
  });

  afterEach(() => {
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('closes once and exits 0, ignoring repeated signals', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    shutdownGracefully(close, { timeoutMs: 1_000, logger: silentLogger });

    process.emit('SIGTERM', 'SIGTERM');
    process.emit('SIGINT', 'SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('exits 1 when close fails', async () => {
    shutdownGracefully(() => Promise.reject(new Error('boom')), {
      timeoutMs: 1_000,
      logger: silentLogger,
    });

    process.emit('SIGTERM', 'SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it('forces exit 1 when close exceeds the timeout', () => {
    shutdownGracefully(() => new Promise<void>(() => undefined), {
      timeoutMs: 1_000,
      logger: silentLogger,
    });

    process.emit('SIGTERM', 'SIGTERM');
    vi.advanceTimersByTime(999);
    expect(exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
