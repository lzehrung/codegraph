import { describe, expect, it } from "vitest";
import { lruMapGet, lruMapSet } from "../src/util/lruMap.js";

describe("lruMap", () => {
  it("evicts the oldest entry when the cap is exceeded", () => {
    const map = new Map<string, number>();
    lruMapSet(map, "a", 1, 2);
    lruMapSet(map, "b", 2, 2);
    lruMapSet(map, "c", 3, 2);

    expect(map.has("a")).toBe(false);
    expect(map.get("b")).toBe(2);
    expect(map.get("c")).toBe(3);
  });

  it("refreshes entry order on get", () => {
    const map = new Map<string, number>();
    lruMapSet(map, "a", 1, 2);
    lruMapSet(map, "b", 2, 2);
    expect(lruMapGet(map, "a")).toBe(1);
    lruMapSet(map, "c", 3, 2);

    expect(map.has("b")).toBe(false);
    expect(map.get("a")).toBe(1);
    expect(map.get("c")).toBe(3);
  });

  it("refreshes undefined-valued entries on get", () => {
    const map = new Map<string, number | undefined>();
    lruMapSet(map, "a", undefined, 2);
    lruMapSet(map, "b", 2, 2);
    expect(lruMapGet(map, "a")).toBeUndefined();
    lruMapSet(map, "c", 3, 2);

    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(false);
    expect(map.get("c")).toBe(3);
  });

  it("evicts an undefined key when it is the oldest entry", () => {
    const map = new Map<string | undefined, number>();
    lruMapSet(map, undefined, 1, 2);
    lruMapSet(map, "b", 2, 2);
    lruMapSet(map, "c", 3, 2);

    expect(map.has(undefined)).toBe(false);
    expect(map.get("b")).toBe(2);
    expect(map.get("c")).toBe(3);
  });
});
