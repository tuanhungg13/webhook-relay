import type { Logger } from '../platform/logger.js';
import { NestLogger } from './nest-logger.js';

function fakeLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  };
}

describe('NestLogger', () => {
  it('maps the trailing string parameter to the context field', () => {
    const pino = fakeLogger();
    new NestLogger(pino as unknown as Logger).log('started', 'NestFactory');

    expect(pino.info).toHaveBeenCalledWith(
      { context: 'NestFactory' },
      'started',
    );
  });

  it('keeps the stack trace when error receives (message, stack, context)', () => {
    const pino = fakeLogger();
    new NestLogger(pino as unknown as Logger).error(
      'failed',
      'Error: x\n    at y',
      'ExceptionsHandler',
    );

    expect(pino.error).toHaveBeenCalledWith(
      { stack: 'Error: x\n    at y', context: 'ExceptionsHandler' },
      'failed',
    );
  });

  it('logs Error instances under err', () => {
    const pino = fakeLogger();
    const error = new Error('boom');
    new NestLogger(pino as unknown as Logger).warn(error);

    expect(pino.warn).toHaveBeenCalledWith({ err: error }, 'boom');
  });
});
