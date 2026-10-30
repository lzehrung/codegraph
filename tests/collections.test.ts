import { describe, expect, it } from "vitest";
import { pushAll, replaceContents } from "../src/util/collections.js";

// `target.push(...items)` throws `RangeError: Maximum call stack size exceeded` at roughly 125,000 elements on
// Node's default stack, which a large repository's edges or references pass.
const PAST_THE_SPREAD_LIMIT = 300_000;

function numbers(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

describe("pushAll", () => {
  it("appends a list longer than a call can take as arguments, in order", () => {
    const target = [-1];

    pushAll(target, numbers(PAST_THE_SPREAD_LIMIT));

    expect(target).toHaveLength(PAST_THE_SPREAD_LIMIT + 1);
    expect(target.slice(0, 3)).toEqual([-1, 0, 1]);
    expect(target.at(-1)).toBe(PAST_THE_SPREAD_LIMIT - 1);
  });

  it("appends any iterable and leaves the target unchanged for an empty one", () => {
    const target = [0];

    pushAll(target, new Set([1, 2]));
    pushAll(target, []);

    expect(target).toEqual([0, 1, 2]);
  });

  it("appends a copy of its own contents when given itself", () => {
    const target = [1, 2];

    pushAll(target, target);

    expect(target).toEqual([1, 2, 1, 2]);
  });
});

describe("replaceContents", () => {
  it("replaces the contents of a list another reference still holds, past the spread limit", () => {
    const target = numbers(10);
    const holder = { list: target };
    const next = numbers(PAST_THE_SPREAD_LIMIT).map((value) => value + 100);

    replaceContents(target, next);

    expect(holder.list).toBe(target);
    expect(target).toHaveLength(PAST_THE_SPREAD_LIMIT);
    expect(target[0]).toBe(100);
    expect(target.at(-1)).toBe(PAST_THE_SPREAD_LIMIT + 99);
  });

  it("shrinks to a shorter list, empties on an empty one, and keeps a list replaced with itself", () => {
    const target = numbers(5);

    replaceContents(target, target);
    expect(target).toEqual([0, 1, 2, 3, 4]);

    replaceContents(target, [9]);
    expect(target).toEqual([9]);

    replaceContents(target, []);
    expect(target).toEqual([]);
  });
});
