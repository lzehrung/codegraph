import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { pushAll, replaceContents } from "../src/util/collections.js";
import { compareStrings } from "../src/util/strings.js";

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

const ORDER_VALUES = [
  "facts/seed.sql",
  "facts/schema.sql",
  "cherry",
  "honey",
  "llama",
  "lizard",
  "a-2",
  "a2",
  "a10",
  "Alpha",
  "alpha",
  "caf\u00e9",
  "cafe\u0301",
  "\u00e4",
  "z",
];
const ORDER_LOCALES = ["cs_CZ", "sk_SK", "sq_AL", "th_TH", "tr_TR", "sv_SE"];

describe("compareStrings", () => {
  it("preserves en-US collation rather than code-unit or numeric ordering", () => {
    const expected = [...ORDER_VALUES].sort((left, right) => left.localeCompare(right, "en-US"));
    expect([...ORDER_VALUES].sort(compareStrings)).toEqual(expected);
    expect(compareStrings("a10", "a2")).toBeLessThan(0);
    expect(compareStrings("caf\u00e9", "cafe\u0301")).toBe(0);
  });

  it.each<Intl.CollatorOptions>([
    { numeric: true },
    { sensitivity: "base" },
    { sensitivity: "accent", caseFirst: "upper" },
    { ignorePunctuation: true, numeric: true },
    { usage: "search", sensitivity: "case", caseFirst: "lower" },
    { localeMatcher: "lookup", collation: "emoji" },
  ])("retains explicit comparison options %j", (options) => {
    const expected = [...ORDER_VALUES].sort(new Intl.Collator("en-US", options).compare);
    const actual = [...ORDER_VALUES].sort((left, right) => compareStrings(left, right, options));
    expect(actual).toEqual(expected);
  });

  it("reuses a collator for equivalent option sets and responds to mutated option values", () => {
    const RealCollator = Intl.Collator;
    const constructor = vi.spyOn(Intl, "Collator").mockImplementation(function (locales, options) {
      return new RealCollator(locales, options);
    });
    const options: Intl.CollatorOptions = {
      usage: "search",
      localeMatcher: "lookup",
      collation: "emoji",
      numeric: true,
      caseFirst: "upper",
      sensitivity: "case",
      ignorePunctuation: true,
    };
    try {
      compareStrings("a10", "a2");
      compareStrings("a10", "a2", {});
      expect(constructor).not.toHaveBeenCalled();
      expect(compareStrings("a10", "a2", options)).toBeGreaterThan(0);
      compareStrings("a10", "a2", {
        ignorePunctuation: true,
        sensitivity: "case",
        caseFirst: "upper",
        numeric: true,
        collation: "emoji",
        localeMatcher: "lookup",
        usage: "search",
      });
      expect(constructor).toHaveBeenCalledTimes(1);
      options.numeric = false;
      expect(compareStrings("a10", "a2", options)).toBeLessThan(0);
      expect(constructor).toHaveBeenCalledTimes(2);
    } finally {
      constructor.mockRestore();
    }
  });

  it.each(ORDER_LOCALES)("is independent of a child process's %s default locale", (locale) => {
    const moduleUrl = pathToFileURL(path.resolve("dist/util/strings.js")).href;
    const script = [
      `import { compareStrings } from ${JSON.stringify(moduleUrl)};`,
      `const values = ${JSON.stringify(ORDER_VALUES)};`,
      "console.log(JSON.stringify({ locale: new Intl.Collator().resolvedOptions().locale, values: values.sort(compareStrings) }));",
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, LC_ALL: `${locale}.UTF-8`, LANG: `${locale}.UTF-8` },
    });
    expect(result.status, result.stderr).toBe(0);
    const actual = JSON.parse(result.stdout) as { locale: string; values: string[] };
    expect(actual.values).toEqual([...ORDER_VALUES].sort(compareStrings));
    if (process.platform === "linux") expect(actual.locale.slice(0, 2)).toBe(locale.slice(0, 2));
  });
});
