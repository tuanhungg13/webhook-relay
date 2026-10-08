import { decideAfterAttempt } from './retry-policy.js';

/** Lịch retry mặc định của spec 08 tính bằng mili giây: 5s,5m,30m,2h,5h,10h,10h. */
const DELAYS = [
  5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 36_000_000,
];
const NOW = new Date('2026-10-08T10:00:00Z');

/** Gọi `decideAfterAttempt` với lịch mặc định và `random` cố định. */
const decide = (succeeded: boolean, attemptCount: number, random = 0.5) =>
  decideAfterAttempt({
    succeeded,
    attemptCount,
    now: NOW,
    retryDelaysMs: DELAYS,
    random: () => random,
  });

describe('decideAfterAttempt', () => {
  it.each([1, 4, 8])(
    'marks a 2xx as succeeded, whatever the attempt count (U1: %i)',
    (attemptCount) => {
      expect(decide(true, attemptCount)).toEqual({ status: 'succeeded' });
    },
  );

  it.each([1, 2, 3, 4, 5, 6, 7])(
    'schedules failed attempt %i at delay[n-1] × jitter 0.9..1.1 (U2)',
    (attemptCount) => {
      const delay = DELAYS[attemptCount - 1]!;
      const at = (random: number) => decide(false, attemptCount, random);
      expect(at(0)).toEqual({
        status: 'pending',
        nextAttemptAt: new Date(NOW.getTime() + Math.round(delay * 0.9)),
      });
      expect(at(0.5)).toEqual({
        status: 'pending',
        nextAttemptAt: new Date(NOW.getTime() + delay),
      });
      expect(at(1)).toEqual({
        status: 'pending',
        nextAttemptAt: new Date(NOW.getTime() + Math.round(delay * 1.1)),
      });
    },
  );

  it('fails as exhausted after the last attempt (U3)', () => {
    expect(decide(false, 8)).toEqual({ status: 'failed', reason: 'exhausted' });
    expect(
      decideAfterAttempt({
        succeeded: false,
        attemptCount: 1,
        now: NOW,
        retryDelaysMs: [],
        random: () => 0.5,
      }),
    ).toEqual({ status: 'failed', reason: 'exhausted' });
  });

  it('rounds the jittered delay to whole milliseconds', () => {
    const decision = decideAfterAttempt({
      succeeded: false,
      attemptCount: 1,
      now: NOW,
      retryDelaysMs: [7],
      random: () => 0.123,
    });
    if (decision.status !== 'pending') throw new Error(decision.status);
    expect(Number.isInteger(decision.nextAttemptAt.getTime())).toBe(true);
  });
});
