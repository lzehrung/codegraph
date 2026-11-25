import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { previewRenameWithSession } from "../src/agent/rename-preview.js";
import { createAgentSession } from "../src/agent/session.js";
import { buildProjectIndex, discoverProjectFiles, findReferences } from "../src/index.js";
import { pushAll, replaceContents } from "../src/util/collections.js";
import { compareStrings } from "../src/util/strings.js";
import { runCliOrThrow } from "./helpers/cli.js";
import { createTempProjectRoot } from "./helpers/filesystem.js";

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

describe("locale-independent public order", () => {
  const czech = new Intl.Collator("cs-CZ");
  const BUILD_OPTIONS = { cache: "off" as const, threads: 1, useNativeWorkers: false };

  it("keeps results, discovery, and cached representatives in en-US order under a Czech default", async () => {
    const root = await createTempProjectRoot("cg-locale-order-", [
      { path: "src/lib.ts", contents: "export function shared(): number {\n  return 1;\n}\n" },
      { path: "src/cherry.ts", contents: 'import { shared } from "./lib";\nexport const cherry = shared();\n' },
      { path: "src/honey.ts", contents: 'import { shared } from "./lib";\nexport const honey = shared();\n' },
      { path: "tests/cherry.test.ts", contents: 'import { shared } from "../src/lib";\nshared();\n' },
      { path: "tests/honey.test.ts", contents: 'import { shared } from "../src/lib";\nshared();\n' },
      { path: "go.mod", contents: "module example.com/fruit\n\ngo 1.22\n" },
      { path: "basket/cherry.go", contents: "package basket\n\nfunc Cherry() int { return 1 }\n" },
      { path: "basket/honey.go", contents: "package basket\n\nfunc Honey() int { return 2 }\n" },
      { path: "cherry/package.json", contents: '{ "name": "cherry" }\n' },
      { path: "honey/package.json", contents: '{ "name": "honey" }\n' },
      {
        path: "main.go",
        contents: 'package main\n\nimport "example.com/fruit/basket"\n\nfunc main() { basket.Cherry() }\n',
      },
    ]);
    const relative = (file: string) => path.relative(root, file).replaceAll("\\", "/");
    // Emulate a process whose default collation is Czech, which sorts "ch" after "h" (honey before cherry).
    const czechDefault = vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (
      this: string,
      that: string,
      locales?: Intl.LocalesArgument,
      options?: Intl.CollatorOptions,
    ) {
      const collator =
        locales === undefined && options === undefined ? czech : new Intl.Collator(locales ?? "cs-CZ", options);
      return collator.compare(this.toString(), that);
    });
    try {
      expect(["cherry", "honey"].sort((left, right) => left.localeCompare(right))).toEqual(["honey", "cherry"]);
      const index = await buildProjectIndex(root, BUILD_OPTIONS);
      const references = await findReferences(index, { file: path.join(root, "src/lib.ts"), line: 1, column: 17 });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") return;
      const sharedFiles = [
        "src/cherry.ts",
        "src/honey.ts",
        "src/lib.ts",
        "tests/cherry.test.ts",
        "tests/honey.test.ts",
      ];
      expect([...new Set(references.references.map((reference) => relative(reference.file)))]).toEqual(sharedFiles);

      const fileEdges = index.graph.edges.flatMap((edge) =>
        edge.to.type === "file" ? [[relative(edge.from), relative(edge.to.path)]] : [],
      );
      expect(fileEdges).toEqual([
        ["main.go", "basket/cherry.go"],
        ["src/cherry.ts", "src/lib.ts"],
        ["src/honey.ts", "src/lib.ts"],
        ["tests/cherry.test.ts", "src/lib.ts"],
        ["tests/honey.test.ts", "src/lib.ts"],
      ]);
      const manifests = (await discoverProjectFiles(root)).flatMap((file) =>
        path.basename(file.path) === "package.json" ? [relative(file.path)] : [],
      );
      expect(manifests).toEqual(["cherry/package.json", "honey/package.json"]);

      const session = createAgentSession({ root, useConfig: false, buildOptions: BUILD_OPTIONS });
      const renamed = await previewRenameWithSession(session, { root, handle: "src/lib.ts:1:17", newName: "common" });
      expect(renamed.safe).toBe(true);
      expect([...new Set(renamed.edits.map((edit) => edit.file))]).toEqual(sharedFiles);

      const affected = await runCliOrThrow(["affected", "--root", root, "--cache", "memory", "--json", "src/lib.ts"], {
        cwd: root,
      });
      const report = JSON.parse(affected.stdout) as { affectedTests: { file: string }[] };
      expect(report.affectedTests.map((entry) => entry.file)).toEqual(["tests/cherry.test.ts", "tests/honey.test.ts"]);
    } finally {
      czechDefault.mockRestore();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
