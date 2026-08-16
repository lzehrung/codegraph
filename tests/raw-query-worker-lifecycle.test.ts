import { describe, expect, it } from "vitest";
import {
  RawSqlQueryWorkerLifecycle,
  SqliteQueryCancelledError,
  type RawSqlQueryWorkerPool,
} from "../src/sqlite/rawQueryWorkerPool.js";
import type { RawQueryWorkerTask } from "../src/sqlite/rawQueryWorker.js";

const task: RawQueryWorkerTask = {
  outputPath: "fixture.sqlite",
  sql: "SELECT 1;",
  params: [],
  maxRows: 1,
  maxBytes: 1024,
  maxCellBytes: 1024,
};

function createAbortablePool(cleanup: Promise<void>): RawSqlQueryWorkerPool {
  return {
    run: async (_task, options) =>
      await new Promise((_, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      }),
    destroy: async () => await cleanup,
  };
}

describe("RawSqlQueryWorkerLifecycle", () => {
  it("caps cancelled worker cleanup slots until each worker has actually exited", async () => {
    const lifecycle = new RawSqlQueryWorkerLifecycle(2);
    const firstCleanup = Promise.withResolvers<void>();
    const secondCleanup = Promise.withResolvers<void>();
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();

    const first = lifecycle.run(task, 10_000, firstAbort.signal, () => createAbortablePool(firstCleanup.promise));
    firstAbort.abort();
    await expect(first).rejects.toBeInstanceOf(SqliteQueryCancelledError);

    const second = lifecycle.run(task, 10_000, secondAbort.signal, () => createAbortablePool(secondCleanup.promise));
    secondAbort.abort();
    await expect(second).rejects.toBeInstanceOf(SqliteQueryCancelledError);

    expect(lifecycle.state()).toEqual({ activeWorkers: 2, maxWorkers: 2 });
    await expect(lifecycle.run(task, 10_000, undefined, () => createAbortablePool(Promise.resolve()))).rejects.toThrow(
      /worker capacity/i,
    );

    firstCleanup.resolve();
    secondCleanup.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(lifecycle.state()).toEqual({ activeWorkers: 0, maxWorkers: 2 });
  });

  it("describes capacity exhaustion caused by an active query", async () => {
    const lifecycle = new RawSqlQueryWorkerLifecycle(1);
    const complete = Promise.withResolvers<{ columns: string[]; rows: Array<Array<unknown>> }>();
    const active = lifecycle.run(task, 10_000, undefined, () => ({
      run: async () => await complete.promise,
      destroy: async () => {},
    }));

    await expect(lifecycle.run(task, 10_000, undefined, () => createAbortablePool(Promise.resolve()))).rejects.toThrow(
      /active or cleaning-up worker/i,
    );

    complete.resolve({ columns: [], rows: [] });
    await expect(active).resolves.toEqual({ columns: [], rows: [] });
  });
});
