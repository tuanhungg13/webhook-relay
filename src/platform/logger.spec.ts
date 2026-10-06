import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const LOGGER_URL = new URL('./logger.ts', import.meta.url).href;
const LINES = 2_000;

describe('createLogger', () => {
  it('keeps every line written before the process is killed hard (OBS-03)', async () => {
    // The child logs a burst and SIGKILLs itself: no exit hook runs, so only lines already
    // written to stdout survive. An asynchronous destination loses most of them.
    const script = `
      import { createLogger } from ${JSON.stringify(LOGGER_URL)};
      const logger = createLogger({ mode: 'test', level: 'info' });
      for (let i = 0; i < ${LINES}; i++) logger.info({ i }, 'line');
      process.kill(process.pid, 'SIGKILL');
    `;
    const stdout = await runUntilKilled(script);

    expect(stdout.trim().split('\n')).toHaveLength(LINES);
  });
});

async function runUntilKilled(script: string): Promise<string> {
  try {
    await promisify(execFile)(process.execPath, [
      '--input-type=module',
      '-e',
      script,
    ]);
  } catch (error) {
    // Windows reports the kill as exit code 1 without a signal; a crash would write to stderr.
    const { stdout, stderr } = error as { stdout: string; stderr: string };
    if (stderr) throw error;
    return stdout;
  }
  throw new Error('child process was expected to be killed');
}
