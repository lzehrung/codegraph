import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProjectIndex } from "../../src/indexer.js";
import { findUsageReferences } from "../../src/indexer/navigation.js";
import { attachCallCompatibilityHints } from "../../src/impact/call-compatibility.js";
import type { ChangedSymbol, ImpactDiagnostics } from "../../src/impact/types.js";
import type * as Navigation from "../../src/indexer/navigation.js";
import type * as ParsedCache from "../../src/indexer/parsed-cache.js";
import type { ProjectIndex } from "../../src/indexer/types.js";

const parseRequests = vi.hoisted(() => [] as string[]);

// The usage lookup finds nothing, so every changed callable needs a verified sweep over the indexed files.
vi.mock("../../src/indexer/navigation.js", async (importOriginal: () => Promise<typeof Navigation>) => {
  const actual = await importOriginal();
  return { ...actual, findUsageReferences: vi.fn() };
});
vi.mock("../../src/indexer/parsed-cache.js", async (importOriginal: () => Promise<typeof ParsedCache>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ensureParsedContextForIndex: vi.fn((...args: Parameters<typeof actual.ensureParsedContextForIndex>) => {
      parseRequests.push(args[1]);
      return actual.ensureParsedContextForIndex(...args);
    }),
  };
});

const FILES: Record<string, string> = {
  // Two changed callables share the name `helper`; each is called from its own directory.
  "src/a/api.ts": "export function helper(a: string, b: number) { return a + b; }\n",
  "src/b/api.ts": "export function helper(a: string) { return a; }\n",
  "src/a/caller.ts": 'import { helper } from "./api";\nexport const fromA = helper("x");\n',
  "src/b/caller.ts": 'import { helper } from "./api";\nexport const fromB = helper("x");\n',
  // Spells the name without calling it, so a filter keeps the file while no callsite is found there.
  "src/scan.ts": "// helper\nexport const scanned = 1;\n",
  // Never spells the name.
  "src/other.ts": "export const other = 2;\n",
};

type Fixture = {
  root: string;
  index: ProjectIndex;
  changed: ChangedSymbol[];
};

async function buildFixture(options: { useBloomFilters: boolean }): Promise<Fixture> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-call-compat-sweep-"));
  for (const [relative, source] of Object.entries(FILES)) {
    await fsp.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fsp.writeFile(path.join(root, relative), source, "utf8");
  }
  const index = await buildProjectIndex(root, { cache: "memory", useBloomFilters: options.useBloomFilters });
  const changed = ["src/a/api.ts", "src/b/api.ts"].map((relative): ChangedSymbol => {
    const module = [...index.byFile.values()].find((entry) => entry.file.endsWith(`/${relative}`));
    const helper = module?.locals.find((local) => local.localName === "helper");
    if (!module || !helper) throw new Error(`Expected a helper definition in ${relative}`);
    return {
      id: `${module.file}#helper`,
      file: module.file,
      name: "helper",
      kind: helper.kind,
      exported: true,
      range: helper.range,
      signatureChanged: true,
    };
  });
  return { root, index, changed };
}

function parseRequestsFor(relative: string): number {
  return parseRequests.filter((file) => file.endsWith(`/${relative}`)).length;
}

function newDiagnostics(): ImpactDiagnostics {
  return {
    changedFilesTotal: 0,
    changedFilesIgnored: 0,
    changedFilesWithoutSymbols: 0,
    symbolMappingParseFailures: 0,
    refsScanned: 0,
    refsFilteredTests: 0,
    refsFilteredIgnored: 0,
    refsDroppedByMaxRefs: 0,
    fallbackSeededFiles: 0,
    fallbackSeededDependents: 0,
    changedSymbolsTotal: 0,
    changedSymbolsAnalyzed: 0,
    changedSymbolsOmitted: 0,
    referenceLookupsStarted: 0,
    referenceLookupsOmitted: 0,
    referencesRetained: 0,
    referencesOmitted: 0,
    deadlineExceeded: false,
    callCompatibility: {
      supportedLanguages: [],
      unsupportedLanguages: [],
      skippedByReason: {},
      unknownCallsites: 0,
      emittedHints: 0,
    },
  };
}

// Only the member call spells the callee outside its definition: the importers name the class, so the filter of a file
// holds the callee name only from the callee itself.
type SeparatorSweepFixture = {
  language: string;
  callee: string;
  definitionFile: string;
  files: (separator: string) => Record<string, string>;
  /** Spells another name before the separator, so neither sweep may report it as a callsite of the callee. */
  decoyFile: string;
  callsiteFiles: string[];
};

const SEPARATOR_SWEEP_FIXTURES: SeparatorSweepFixture[] = [
  {
    language: "TypeScript",
    callee: "helper",
    definitionFile: "api.ts",
    files: (separator) => ({
      "api.ts": "export class Api {\n  static helper(a: string, b: number) {\n    return a + b;\n  }\n}\n",
      "plain.ts": 'import { Api } from "./api";\nexport const plain = Api.helper("x");\n',
      "separated.ts": `import { Api } from "./api";\nexport const separated = Api.helper${separator}("x");\n`,
      "decoy.ts": `export class Other {\n  static helperTwo(a: string) {\n    return a;\n  }\n}\nexport const decoy = Other.helperTwo${separator}("x");\n`,
    }),
    decoyFile: "decoy.ts",
    callsiteFiles: ["plain.ts", "separated.ts"],
  },
  {
    language: "C#",
    callee: "Helper",
    definitionFile: "Api.cs",
    files: (separator) => ({
      "Api.cs": "public class Api {\n  public static string Helper(string a, int b) {\n    return a;\n  }\n}\n",
      "Plain.cs": 'public class Plain {\n  string v = Api.Helper("x");\n}\n',
      "Separated.cs": `public class Separated {\n  string v = Api.Helper${separator}("x");\n}\n`,
      "Decoy.cs": `public class Other {\n  public static string HelperTwo(string a) {\n    return a;\n  }\n}\npublic class Decoy {\n  string v = Other.HelperTwo${separator}("x");\n}\n`,
    }),
    decoyFile: "Decoy.cs",
    callsiteFiles: ["Plain.cs", "Separated.cs"],
  },
];

const SEPARATORS: Array<[string, string]> = [
  ["a no-break space", "\u00a0"],
  ["a line separator", "\u2028"],
  ["an ideographic space", "\u3000"],
];

const SEPARATOR_SWEEP_CASES = SEPARATOR_SWEEP_FIXTURES.flatMap((fixture) =>
  SEPARATORS.map(([name, separator]): [string, string, SeparatorSweepFixture, string] => [
    fixture.language,
    name,
    fixture,
    separator,
  ]),
);

describe("verified callsite sweeps", () => {
  const roots: string[] = [];

  beforeEach(() => {
    parseRequests.length = 0;
    vi.mocked(findUsageReferences).mockResolvedValue({ status: "not_found", reason: "test" });
  });

  afterEach(async () => {
    vi.mocked(findUsageReferences).mockReset();
    await Promise.all(
      roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
    );
  });

  it("finds each same-named callable's own callsites in one pass over the files", async () => {
    const fixture = await buildFixture({ useBloomFilters: true });
    roots.push(fixture.root);

    await attachCallCompatibilityHints(fixture.index, fixture.changed, { maxRefs: 10, projectRoot: fixture.root });

    const [fromA, fromB] = fixture.changed.map((symbol) => symbol.callCompatibility);
    expect(fromA).toEqual([
      expect.objectContaining({
        status: "likely_mismatch",
        reason: "argument_count_below_minimum",
        callsiteFile: "src/a/caller.ts",
      }),
    ]);
    expect(fromB).toEqual([expect.objectContaining({ status: "compatible", callsiteFile: "src/b/caller.ts" })]);
    // Both sweeps want the file that spells `helper`, and it is read and parsed once for the two of them.
    expect(parseRequestsFor("src/scan.ts")).toBe(1);
  });

  it("does not parse a file whose identifier filter cannot hold the callee name", async () => {
    const fixture = await buildFixture({ useBloomFilters: true });
    roots.push(fixture.root);

    await attachCallCompatibilityHints(fixture.index, fixture.changed, { maxRefs: 10, projectRoot: fixture.root });

    expect(parseRequestsFor("src/other.ts")).toBe(0);
  });

  it("parses a file that cannot be read once, and counts the failure for each sweep that searched it", async () => {
    const fixture = await buildFixture({ useBloomFilters: true });
    roots.push(fixture.root);
    await fsp.unlink(path.join(fixture.root, "src", "scan.ts"));
    const diagnostics = newDiagnostics();

    await attachCallCompatibilityHints(fixture.index, fixture.changed, {
      maxRefs: 10,
      projectRoot: fixture.root,
      diagnostics,
    });

    expect(parseRequestsFor("src/scan.ts")).toBe(1);
    expect(diagnostics.callCompatibility?.skippedByReason["parse-failed"]).toBe(fixture.changed.length);
  });

  it("still searches files without an identifier filter, with the same callsites", async () => {
    const filtered = await buildFixture({ useBloomFilters: true });
    const unfiltered = await buildFixture({ useBloomFilters: false });
    roots.push(filtered.root, unfiltered.root);

    await attachCallCompatibilityHints(filtered.index, filtered.changed, { maxRefs: 10, projectRoot: filtered.root });
    parseRequests.length = 0;
    await attachCallCompatibilityHints(unfiltered.index, unfiltered.changed, {
      maxRefs: 10,
      projectRoot: unfiltered.root,
    });

    expect(unfiltered.index.bloomFilters).toBeUndefined();
    expect(parseRequestsFor("src/other.ts")).toBe(1);
    const callsites = (fixture: Fixture) =>
      fixture.changed.map((symbol) =>
        (symbol.callCompatibility ?? []).map((hint) => [hint.status, hint.reason, hint.callsiteFile]),
      );
    expect(callsites(unfiltered)).toEqual(callsites(filtered));
  });

  it("stops a sweep at its limit with the first callsites in document order", async () => {
    const fixture = await buildFixture({ useBloomFilters: true });
    roots.push(fixture.root);
    const callerFile = path.join(fixture.root, "src", "a", "caller.ts");
    await fsp.writeFile(
      callerFile,
      'import { helper } from "./api";\nexport const one = helper("1");\nexport const two = helper("2");\nexport const three = helper("3");\n',
      "utf8",
    );
    const index = await buildProjectIndex(fixture.root, { cache: "memory" });
    const [changedA] = fixture.changed;
    if (!changedA) throw new Error("Expected a changed symbol");

    await attachCallCompatibilityHints(index, [changedA], { maxRefs: 2, projectRoot: fixture.root });

    expect(changedA.callCompatibility?.map((hint) => hint.callsiteRange.start.line)).toEqual([2, 3]);
  });

  it("still searches a file whose filter stores the callee name only in pieces", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-call-compat-sweep-ruby-"));
    roots.push(root);
    await fsp.writeFile(path.join(root, "api.rb"), "def valid?(a, b)\n  a && b\nend\n", "utf8");
    await fsp.writeFile(path.join(root, "main.rb"), 'require_relative "api"\n\nvalid?(1)\n', "utf8");
    const index = await buildProjectIndex(root, { cache: "memory" });
    const modules = [...index.byFile.values()];
    const api = modules.find((entry) => entry.file.endsWith("/api.rb"));
    const main = modules.find((entry) => entry.file.endsWith("/main.rb"));
    const predicate = api?.locals.find((local) => local.localName === "valid?");
    if (!api || !main || !predicate) throw new Error("Expected the Ruby predicate method and its caller");
    // The filter of main.rb holds `valid` but no `valid?`, so probing it with the whole name would rule the file out.
    expect(index.bloomFilters?.get(main.file)?.mightContain("valid?")).toBe(false);
    const changed: ChangedSymbol = {
      id: `${api.file}#valid?`,
      file: api.file,
      name: "valid?",
      kind: predicate.kind,
      exported: true,
      range: predicate.range,
      signatureChanged: true,
    };

    await attachCallCompatibilityHints(index, [changed], { maxRefs: 10, projectRoot: root });

    expect(changed.callCompatibility).toEqual([
      expect.objectContaining({ status: "likely_mismatch", callsiteFile: "main.rb" }),
    ]);
  });

  it.each(SEPARATOR_SWEEP_CASES)(
    "finds a %s callsite whose callee is followed by %s, as an unfiltered sweep does",
    async (_language, _name, fixture, separator) => {
      const sweepCallsites = async (useBloomFilters: boolean): Promise<{ files: string[]; decoyParses: number }> => {
        const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-call-compat-sweep-separator-"));
        roots.push(root);
        for (const [relative, source] of Object.entries(fixture.files(separator))) {
          await fsp.writeFile(path.join(root, relative), source, "utf8");
        }
        const index = await buildProjectIndex(root, { cache: "memory", useBloomFilters });
        const module = [...index.byFile.values()].find((entry) => entry.file.endsWith(`/${fixture.definitionFile}`));
        const callee = module?.locals.find((local) => local.localName === fixture.callee);
        if (!module || !callee) throw new Error(`Expected a ${fixture.callee} definition in ${fixture.definitionFile}`);
        const changed: ChangedSymbol = {
          id: `${module.file}#${fixture.callee}`,
          file: module.file,
          name: fixture.callee,
          kind: callee.kind,
          exported: true,
          range: callee.range,
          signatureChanged: true,
        };
        parseRequests.length = 0;

        await attachCallCompatibilityHints(index, [changed], { maxRefs: 10, projectRoot: root });

        return {
          files: (changed.callCompatibility ?? []).map((hint) => hint.callsiteFile).sort(),
          decoyParses: parseRequestsFor(fixture.decoyFile),
        };
      };

      const unfiltered = await sweepCallsites(false);
      const filtered = await sweepCallsites(true);

      expect(unfiltered.files).toEqual(fixture.callsiteFiles);
      expect(filtered.files).toEqual(unfiltered.files);
      // A filter that held the decoy's own name in place of the callee's rules the decoy out, so it is still never parsed.
      expect(unfiltered.decoyParses).toBe(1);
      expect(filtered.decoyParses).toBe(0);
    },
  );
});
