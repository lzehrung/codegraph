import { describe, expect, it } from "vitest";
import { mapLimit } from "../src/util/concurrency.js";

describe("mapLimit", () => {
  it("treats non-positive concurrency as single-threaded work instead of hanging", async () => {
    await expect(mapLimit([1, 2, 3], 0, async (value) => value * 2)).resolves.toEqual([2, 4, 6]);
    await expect(mapLimit([1, 2, 3], -5, async (value) => value * 3)).resolves.toEqual([3, 6, 9]);
  });

  it("treats non-finite concurrency as single-threaded work instead of hanging", async () => {
    await expect(mapLimit([1, 2, 3], Number.NaN, async (value) => value * 4)).resolves.toEqual([4, 8, 12]);
    await expect(mapLimit([1, 2, 3], Number.POSITIVE_INFINITY, async (value) => value * 5)).resolves.toEqual([
      5, 10, 15,
    ]);
  });

  it("preserves input order while running work concurrently", async () => {
    const started: number[] = [];
    const result = await mapLimit([30, 10, 20], 2, async (value) => {
      started.push(value);
      await new Promise((resolve) => setTimeout(resolve, value));
      return value / 10;
    });

    expect(started.slice(0, 2)).toEqual([30, 10]);
    expect(result).toEqual([3, 1, 2]);
  });

  it("rejects on worker failure and stops starting queued work", async () => {
    const started: number[] = [];
    await expect(
      mapLimit([1, 2, 3, 4], 2, async (value) => {
        started.push(value);
        if (value === 2) throw new Error("boom");
        await new Promise((resolve) => setTimeout(resolve, 10));
        return value;
      }),
    ).rejects.toThrow("boom");

    expect(started).toEqual([1, 2]);
  });

  it("converts synchronous worker throws into promise rejections", async () => {
    const started: number[] = [];
    await expect(
      mapLimit([1, 2, 3], 1, (value) => {
        started.push(value);
        if (value === 2) throw new Error("sync boom");
        return Promise.resolve(value);
      }),
    ).rejects.toThrow("sync boom");

    expect(started).toEqual([1, 2]);
  });
});
