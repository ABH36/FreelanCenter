import { DbBusyError } from './errors';

export interface LimiterOptions {
  /** Transactions allowed to run at once; keep it at or below the client pool size. */
  concurrency: number;
  /** Waiting callers beyond this are rejected immediately. */
  maxQueue: number;
  /** A queued caller gives up after this many milliseconds. */
  queueTimeoutMs: number;
}

/**
 * FIFO concurrency limiter for interactive transactions. Spike B B-3: with an unbounded burst, Prisma's own
 * queue failed 156/300 requests with "Unable to start a transaction in the given time". Bounding the work
 * before it reaches Prisma turns overload into a fast, explicit `DbBusyError` instead of random timeouts.
 */
export class TransactionLimiter {
  private active = 0;
  private readonly waiters: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(private readonly options: LimiterOptions) {
    if (options.concurrency < 1) throw new RangeError('concurrency must be at least 1');
  }

  get stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.waiters.length };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.options.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.options.maxQueue) return Promise.reject(new DbBusyError());
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(new DbBusyError());
        }, this.options.queueTimeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve(); // the slot passes straight to the next caller
    } else {
      this.active--;
    }
  }
}
