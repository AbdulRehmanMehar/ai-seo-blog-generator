import { sleep } from './sleep.js';

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > opts.retries) throw err;

      const message = err instanceof Error ? err.message : String(err);
      const retryDelayMatch = message.match(/"retryDelay"\s*:\s*"(\d+)s"/);
      if (retryDelayMatch?.[1]) {
        const seconds = Number(retryDelayMatch[1]);
        if (Number.isFinite(seconds) && seconds > 0) {
          await sleep(Math.min(opts.maxDelayMs, seconds * 1000));
          continue;
        }
      }

      const backoff = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 250);
      await sleep(backoff + jitter);
    }
  }
}
