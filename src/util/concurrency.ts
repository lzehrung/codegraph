/**
 * A simple semaphore implementation for bounding concurrent operations.
 */
export class Semaphore {
  private permits: number;
  private waitQueue: Array<(() => void) | undefined> = [];
  private waitQueueHead = 0;

  constructor(permits: number) {
    if (!Number.isFinite(permits) || permits < 1) {
      throw new Error(`Semaphore permits must be a positive number, got: ${permits}`);
    }
    this.permits = Math.floor(permits);
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    const next = this.waitQueue[this.waitQueueHead];
    if (next) {
      this.waitQueue[this.waitQueueHead] = undefined;
      this.waitQueueHead += 1;
      next();
      if (this.waitQueueHead > 1024 && this.waitQueueHead * 2 > this.waitQueue.length) {
        this.waitQueue = this.waitQueue.slice(this.waitQueueHead);
        this.waitQueueHead = 0;
      }
    } else {
      this.permits++;
    }
  }

  async withPermit<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  available(): number {
    return this.permits;
  }

  waiting(): number {
    return this.waitQueue.length - this.waitQueueHead;
  }
}

/**
 * Map over items with bounded concurrency, preserving input order.
 * Invalid limits are treated as 1. The returned promise rejects on the first
 * worker rejection and stops starting new work.
 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (!items.length) return [];
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let activeCount = 0;
  let resolveAll: (() => void) | null = null;
  let rejectAll: ((err: unknown) => void) | null = null;
  let aborted = false;

  const startNext = (): void => {
    if (aborted) return;
    while (activeCount < safeLimit && nextIndex < items.length) {
      if (aborted) return;
      const index = nextIndex++;
      const item = items[index]!;
      activeCount++;

      Promise.resolve()
        .then(() => fn(item))
        .then((result) => {
          activeCount--;
          if (aborted) return;
          results[index] = result;
          if (nextIndex < items.length) {
            startNext();
          } else if (activeCount === 0 && resolveAll) {
            resolveAll();
          }
        })
        .catch((err) => {
          activeCount--;
          if (aborted) return;
          aborted = true;
          if (rejectAll) rejectAll(err);
        });
    }
  };

  return new Promise<R[]>((resolve, reject) => {
    resolveAll = () => resolve(results);
    rejectAll = reject;
    startNext();
    if (!aborted && nextIndex >= items.length && activeCount === 0) {
      resolve(results);
    }
  });
}

/**
 * Map over items with bounded concurrency using a semaphore.
 */
export async function mapLimitSemaphore<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, semaphore: Semaphore) => Promise<R>,
): Promise<R[]> {
  const semaphore = new Semaphore(limit);
  return await Promise.all(items.map((item) => semaphore.withPermit(() => fn(item, semaphore))));
}

let globalIOSemaphore: Semaphore | null = null;

export function getIOSemaphore(limit = 100): Semaphore {
  if (!globalIOSemaphore) {
    globalIOSemaphore = new Semaphore(limit);
  }
  return globalIOSemaphore;
}

export function resetIOSemaphore(): void {
  globalIOSemaphore = null;
}
