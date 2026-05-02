import { describe, expect, it } from "vitest";
import { mapLimit } from "../src/util.js";

describe("mapLimit", () => {
  it("treats non-positive concurrency as single-threaded work instead of hanging", async () => {
    await expect(mapLimit([1, 2, 3], 0, async (value) => value * 2)).resolves.toEqual([2, 4, 6]);
    await expect(mapLimit([1, 2, 3], -5, async (value) => value * 3)).resolves.toEqual([3, 6, 9]);
  });
});
