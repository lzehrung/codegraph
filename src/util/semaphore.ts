/**
 * A simple semaphore implementation for bounding concurrent operations.
 * Unlike mapLimit which only limits task starts, this tracks actual outstanding operations.
 */

export class Semaphore {
  private permits: number;
  private waitQueue: Array<() => void> = [];

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
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }

  /**
   * Execute a function while holding a permit
   */
  async withPermit<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Get current number of available permits
   */
  available(): number {
    return this.permits;
  }

  /**
   * Get number of waiters in queue
   */
  waiting(): number {
    return this.waitQueue.length;
  }
}

/**
 * Map over items with bounded concurrency using a semaphore.
 * Unlike basic mapLimit, this correctly handles nested async operations.
 */
export async function mapLimitSemaphore<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, semaphore: Semaphore) => Promise<R>,
): Promise<R[]> {
  const semaphore = new Semaphore(limit);
  const results = await Promise.all(items.map((item) => semaphore.withPermit(() => fn(item, semaphore))));
  return results;
}

/**
 * Global I/O semaphore for file operations.
 * Prevents EMFILE errors on systems with limited file descriptors.
 */
let globalIOSemaphore: Semaphore | null = null;

export function getIOSemaphore(limit = 100): Semaphore {
  if (!globalIOSemaphore) {
    globalIOSemaphore = new Semaphore(limit);
  }
  return globalIOSemaphore;
}

/**
 * Reset the global I/O semaphore (useful for testing)
 */
export function resetIOSemaphore(): void {
  globalIOSemaphore = null;
}
