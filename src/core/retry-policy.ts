/** Hệ số jitter thấp nhất: delay thật ít nhất bằng 90% delay trong lịch (RTY-01). */
const JITTER_MIN = 0.9;
/** Độ rộng khoảng jitter: hệ số chạy từ 0,9 tới 1,1. */
const JITTER_SPAN = 0.2;

/**
 * Trạng thái mới của delivery sau một lần gửi (spec 07, bảng cập nhật delivery):
 * thành công, hẹn lần thử sau lúc `nextAttemptAt`, hoặc hết lượt (đi vào DLQ).
 */
export type DeliveryDecision =
  | { status: 'succeeded' }
  | { status: 'pending'; nextAttemptAt: Date }
  | { status: 'failed'; reason: 'exhausted' };

/**
 * Quyết định số phận delivery sau một attempt. Mọi lỗi đều retry, kể cả 4xx (WRK-10).
 *
 * `attemptCount` là số attempt ĐÃ tính cả lần này. Lỗi ở attempt thứ n (n ≤ số phần tử của
 * `retryDelaysMs`) thì hẹn lại sau `retryDelaysMs[n-1]` nhân hệ số jitter ngẫu nhiên 0,9..1,1,
 * để nhiều delivery cùng lỗi một lúc không ùa về cùng một lúc (RTY-01). Lỗi ở attempt thứ
 * `retryDelaysMs.length + 1` là hết lượt (`MAX_ATTEMPTS`). `random` trả số trong [0, 1],
 * truyền vào để test cố định được.
 */
export function decideAfterAttempt(input: {
  succeeded: boolean;
  attemptCount: number;
  now: Date;
  retryDelaysMs: readonly number[];
  random: () => number;
}): DeliveryDecision {
  const { succeeded, attemptCount, now, retryDelaysMs, random } = input;
  if (succeeded) return { status: 'succeeded' };
  const delayMs = retryDelaysMs[attemptCount - 1];
  if (delayMs === undefined) return { status: 'failed', reason: 'exhausted' };
  const jitter = JITTER_MIN + JITTER_SPAN * random();
  // Làm tròn về mili giây nguyên: Postgres và `Date` đều chỉ giữ tới mili giây.
  return {
    status: 'pending',
    nextAttemptAt: new Date(now.getTime() + Math.round(delayMs * jitter)),
  };
}
