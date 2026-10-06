import type { Logger } from './logger.js';

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/**
 * NODE-05: an unhandled rejection or uncaught exception leaves the process in an
 * unknown state, so log it and exit; the container runtime restarts the process.
 */
export function exitOnFatalErrors(logger: Logger): void {
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    process.exit(1);
  });
}

/**
 * WRK-04 / SHUTDOWN_TIMEOUT: on the first shutdown signal run `close`; if it has not
 * finished within `timeoutMs`, exit anyway so the orchestrator never has to SIGKILL us.
 */
export function shutdownGracefully(
  close: () => Promise<void>,
  options: { timeoutMs: number; logger: Logger },
): void {
  const { timeoutMs, logger } = options;
  let shuttingDown = false;

  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, timeoutMs }, 'shutting down');

    setTimeout(() => {
      logger.error({ timeoutMs }, 'shutdown timed out, forcing exit');
      process.exit(1);
    }, timeoutMs).unref();

    close().then(
      () => {
        logger.info('shutdown complete');
        process.exit(0);
      },
      (error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  };

  for (const signal of SHUTDOWN_SIGNALS) process.once(signal, onSignal);
}
