import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildProjectIndex,
  buildProjectIndexFromFiles,
  buildProjectIndexIncremental,
  findReferences,
  goToDefinition,
  listSymbols,
  resolveSymbolId,
} from "../src/index.js";
import { previewRenameInSnapshot } from "../src/agent/rename-preview.js";
import type { AgentProjectSnapshot } from "../src/agent/session.js";
import { supportForFileWithoutHeaderSample } from "../src/languages.js";
import { getCachedReferenceCandidateFiles, moduleExportProbeNames } from "../src/indexer/navigation-references.js";
import { resolveExport } from "../src/indexer/navigation-resolve.js";
import {
  coverageFacts,
  exportEdgeIndex,
  localExportsNamed,
  namespaceReexportOwners,
  referenceModuleTable,
  reverseReachableModules,
} from "../src/indexer/reference-query-index.js";
import type { ProjectIndex, SymbolDef } from "../src/indexer/types.js";
import { fileIdentityKey } from "../src/util/paths.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";
import { exportedNamesOf, referenceCandidatesByFullScan, relativeTo } from "./helpers/reference-candidate-oracle.js";

const roots = createTempRootRegistry();

afterEach(async () => {
  await roots.cleanup();
});

async function writeProject(files: Record<string, string>): Promise<string> {
  const root = await roots.create("cg-reference-candidates-");
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, text, "utf8");
  }
  return root.replace(/\\/g, "/");
}

function definitionOf(index: ProjectIndex, name: string, fileSuffix: string): SymbolDef {
  const symbol = listSymbols(index).find((item) => item.name === name && item.file.endsWith(fileSuffix));
  const def = symbol ? resolveSymbolId(index, symbol.id) : undefined;
  if (!def) throw new Error(`no definition ${name} in ${fileSuffix}`);
  return def;
}

/** The files a lookup of `def` lists as candidates, relative to `root`. */
function candidateFilesOf(index: ProjectIndex, root: string, def: SymbolDef): string[] {
  const languageId = supportForFileWithoutHeaderSample(def.file, index.languageExtensions)?.id ?? "unknown";
  const names = exportedNamesOf(index, def);
  return getCachedReferenceCandidateFiles(index, def, names.length ? names : [def.localName], false, languageId).map(
    (file) => relativeTo(root, file),
  );
}

/**
 * An index object of its own over the same modules, with empty export and scope caches and no per-index table built:
 * what one side resolved is not visible to the other, and every lookup starts cold. `resolveExport` caches the
 * answers of the modules it passes through, so a comparison that shares one index lets the first side decide what
 * the second sees and hides any difference in the order the two sides probe modules.
 */
function coldClone(index: ProjectIndex): ProjectIndex {
  return { ...index, exportCache: new Map(), scopeCache: new Map() };
}

const CYCLE_DEFINITION = "export function foo(): number {\n  return 1;\n}\n";

/**
 * Re-export cycles in which a module's answer for a name depends on which module of the cycle is probed first: the
 * module probed first answers through the other, which is mid-resolution and answers nothing, and the cache keeps that
 * nothing for the other. The first module of each cycle in file order is the one the consumer imports, or the one
 * that is not, so both probe orders occur.
 */
const CYCLE_PROJECTS: Record<string, Record<string, string>> = {
  "star cycle, the importer's module sorts first": {
    "a.ts": 'export * from "./b";\n',
    "b.ts": 'export * from "./a";\nexport * from "./def";\n',
    "def.ts": CYCLE_DEFINITION,
    "consumer.ts": 'import { foo } from "./a";\nexport const x = foo();\n',
  },
  "star cycle, the importer's module sorts last": {
    "m2.ts": 'export * from "./m1";\n',
    "m1.ts": 'export * from "./m2";\nexport * from "./def";\n',
    "def.ts": CYCLE_DEFINITION,
    "consumer.ts": 'import { foo } from "./m2";\nexport const x = foo();\n',
  },
  "named cycle, the importer's module sorts first": {
    "a.ts": 'export { foo } from "./b";\n',
    "b.ts": 'export { foo } from "./a";\nexport * from "./def";\n',
    "def.ts": CYCLE_DEFINITION,
    "consumer.ts": 'import { foo } from "./a";\nexport const x = foo();\n',
  },
  "named cycle, the importer's module sorts last": {
    "m2.ts": 'export { foo } from "./m1";\n',
    "m1.ts": 'export { foo } from "./m2";\nexport * from "./def";\n',
    "def.ts": CYCLE_DEFINITION,
    "consumer.ts": 'import { foo } from "./m2";\nexport const x = foo();\n',
  },
  "three-module star cycle": {
    "x.ts": 'export * from "./y";\n',
    "y.ts": 'export * from "./z";\n',
    "z.ts": 'export * from "./x";\nexport * from "./def";\n',
    "def.ts": CYCLE_DEFINITION,
    "use-x.ts": 'import { foo } from "./x";\nexport const a = foo();\n',
    "use-y.ts": 'import { foo } from "./y";\nexport const b = foo();\n',
  },
};

function denseStarProject(): Record<string, string> {
  const files: Record<string, string> = {
    "def.ts": "export function target(): number { return 1; }\n",
    "decoy.ts": "export function target(): number { return 2; }\n",
    "hidden.ts": "function target(): number { return 3; }\nexport const hiddenCall = target();\n",
    "shadow.ts": 'export * from "./m0";\nexport { target } from "./decoy";\n',
    "ambiguous.ts": 'export * from "./m0";\nexport * from "./decoy";\n',
    "consumer.ts": [
      'import { target } from "./m0";',
      'import { target as localTarget } from "./m1";',
      'import { forwarded } from "./m0";',
      'import * as ns from "./m0";',
      'import { target as shadowed } from "./shadow";',
      'import { target as ambiguous } from "./ambiguous";',
      "export const direct = target();",
      "export const aliased = localTarget();",
      "export const forwardedCall = forwarded();",
      "export const member = ns.target();",
      "export const shadowedCall = shadowed();",
      "export const ambiguousCall = ambiguous();",
      "export function local(target: () => number) { return target(); }",
      "",
    ].join("\n"),
  };
  for (let module = 0; module < 10; module += 1) {
    const exports: string[] = [];
    for (let neighbor = 0; neighbor < 10; neighbor += 1) {
      if (module !== neighbor) exports.push(`export * from "./m${neighbor}";`);
    }
    if (module === 2) exports.push('export * from "./hidden";');
    if (module === 3) exports.push('export { target as masked } from "./decoy";');
    if (module === 4) exports.push('export * from "./absent";');
    if (module === 9) {
      exports.push('export * from "./def";');
      exports.push('export { target as forwarded } from "./def";');
    }
    files[`m${module}.ts`] = `${exports.join("\n")}\n`;
  }
  return files;
}

const CHAIN_PROJECT: Record<string, string> = {
  "src/def.ts": "export function helper(value: number): number {\n  return value + 1;\n}\nexport const other = 2;\n",
  "src/deep.ts": 'export * from "./def";\n',
  "src/barrel.ts": 'export * from "./deep";\n',
  "src/alias.ts": 'export { helper as aliasedHelper } from "./def";\n',
  "src/ns.ts": 'export * as defNs from "./def";\n',
  "src/ns-outer.ts": 'export * as outer from "./ns";\n',
  "src/use-barrel.ts": 'import { helper } from "./barrel";\nexport const a = helper(1);\n',
  "src/use-alias.ts": 'import { aliasedHelper } from "./alias";\nexport const b = aliasedHelper(2);\n',
  "src/use-ns.ts": 'import { defNs } from "./ns";\nexport const c = defNs.helper(3);\n',
  "src/use-ns-star.ts": 'import * as n from "./ns";\nexport const d = n.defNs.helper(4);\n',
  "src/use-outer.ts": 'import { outer } from "./ns-outer";\nexport const e = outer.defNs.helper(5);\n',
  "src/use-direct.ts": 'import { helper } from "./def";\nexport const f = helper(6);\n',
  "src/decoy.ts": "export function helper(value: number): number {\n  return value;\n}\nexport const g = helper(7);\n",
  "src/unrelated.ts": 'import { other } from "./def";\nexport const h = other;\n',
  "docs/notes.md": "See [the helper](../src/def.ts) for details.\n",
};

describe("reference candidate selection", () => {
  it("lists the importers of a definition through star, named, and namespace re-export chains and not a same-named decoy", async () => {
    const root = await writeProject(CHAIN_PROJECT);
    const index = await buildProjectIndex(root, { cache: "off" });
    const def = definitionOf(index, "helper", "src/def.ts");

    expect(candidateFilesOf(index, root, def)).toEqual([
      "docs/notes.md",
      "src/alias.ts",
      "src/barrel.ts",
      "src/deep.ts",
      "src/ns-outer.ts",
      "src/ns.ts",
      "src/unrelated.ts",
      "src/use-alias.ts",
      "src/use-barrel.ts",
      "src/use-direct.ts",
      "src/use-ns-star.ts",
      "src/use-ns.ts",
      "src/use-outer.ts",
    ]);

    const result = await findReferences(index, { def });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect([...new Set(result.references.map((reference) => relativeTo(root, reference.file)))].sort()).toEqual([
      "src/alias.ts",
      "src/def.ts",
      "src/use-alias.ts",
      "src/use-barrel.ts",
      "src/use-direct.ts",
      "src/use-ns-star.ts",
      "src/use-ns.ts",
      "src/use-outer.ts",
    ]);
    expect(result.referenceCoverage?.state).toBe("complete");
  });

  it("lists exactly what a scan of every module lists, for every definition of the sample and edge projects", async () => {
    const testsDirectory = path.resolve(process.cwd(), "tests");
    const projectRoots: string[] = [];
    for (const sample of [
      "c",
      "cpp",
      "csharp",
      "go",
      "java",
      "json-imports",
      "kotlin",
      "monorepo",
      "complex-monorepo",
      "python",
      "python_ns",
      "ruby",
      "rust",
      "scss-modules",
      "svelte",
      "swift",
      "tsx",
      "typescript",
      "vue",
      "zig",
    ]) {
      projectRoots.push(path.join(testsDirectory, "samples", sample));
    }
    for (const language of await fsp.readdir(path.join(testsDirectory, "edge-corpus"), { withFileTypes: true })) {
      if (!language.isDirectory()) continue;
      const languageRoot = path.join(testsDirectory, "edge-corpus", language.name);
      for (const scenario of await fsp.readdir(languageRoot, { withFileTypes: true })) {
        if (scenario.isDirectory()) projectRoots.push(path.join(languageRoot, scenario.name));
      }
    }
    for (const files of Object.values(CYCLE_PROJECTS)) projectRoots.push(await writeProject(files));

    let compared = 0;
    const mismatches: string[] = [];
    for (const projectRoot of projectRoots) {
      const index = await buildProjectIndex(projectRoot, { cache: "off" });
      expect(index.referenceCandidates, projectRoot).toBeDefined();
      for (const module of index.byFile.values()) {
        for (const def of module.locals) {
          const languageId = supportForFileWithoutHeaderSample(def.file, index.languageExtensions)?.id ?? "unknown";
          if (languageId === "php") continue;
          const exported = exportedNamesOf(index, def);
          const nameSets = [exported.length || def.isMember ? exported : [def.localName]];
          if (def.isMember) nameSets.push([def.localName]);
          for (const names of nameSets) {
            const expected = referenceCandidatesByFullScan(coldClone(index), def, names, languageId);
            const actual = getCachedReferenceCandidateFiles(coldClone(index), def, names, false, languageId);
            compared += 1;
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
              mismatches.push(
                `${relativeTo(testsDirectory, def.file)} ${def.localName} [${names.join(",")}]: expected ${expected
                  .map((file) => relativeTo(testsDirectory, file))
                  .join(" ")}, got ${actual.map((file) => relativeTo(testsDirectory, file)).join(" ")}`,
              );
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
    expect(mismatches).toEqual([]);
  }, 120_000);

  it("lists every PHP file of the index, sorted, for a PHP definition", async () => {
    const root = await writeProject({
      "src/b-service.php": "<?php\nnamespace App;\nclass Service {}\n",
      "src/a-consumer.php": "<?php\nnamespace Other;\nclass Consumer {}\n",
      "src/notes.ts": "export const x = 1;\n",
    });
    const index = await buildProjectIndex(root, { cache: "off" });
    const def = definitionOf(index, "Service", "src/b-service.php");

    const candidates = getCachedReferenceCandidateFiles(index, def, ["Service"], true, "php").map((file) =>
      relativeTo(root, file),
    );

    expect(candidates).toEqual(["src/a-consumer.php", "src/b-service.php"]);
    expect(getCachedReferenceCandidateFiles(index, def, ["Service"], true, "php")).toBe(
      referenceModuleTable(index).phpFiles,
    );
  });
});

/** A module table whose iterations a test can count; `index.byFile` is the one table every whole-project scan walks. */
class CountingMap<K, V> extends Map<K, V> {
  iterations = 0;

  override values(): MapIterator<V> {
    this.iterations += 1;
    return super.values();
  }

  override entries(): MapIterator<[K, V]> {
    this.iterations += 1;
    return super.entries();
  }

  override keys(): MapIterator<K> {
    this.iterations += 1;
    return super.keys();
  }

  override forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
    this.iterations += 1;
    super.forEach(callback, thisArg);
  }

  override [Symbol.iterator](): MapIterator<[K, V]> {
    this.iterations += 1;
    return super[Symbol.iterator]();
  }
}

const MEMBER_PROJECT: Record<string, string> = {
  ...CHAIN_PROJECT,
  "src/widget.ts":
    "export class Widget {\n  render(): number {\n    return 1;\n  }\n  size = 2;\n}\nexport function make(): Widget {\n  return new Widget();\n}\n",
  "src/use-widget.ts":
    'import { Widget, make } from "./widget";\nexport const w = new Widget().render() + make().render();\n',
  "src/widget-barrel.ts": 'export * from "./widget";\n',
  "src/use-widget-barrel.ts": 'import { Widget } from "./widget-barrel";\nexport const v = new Widget().size;\n',
};

describe("per-index reference structures", () => {
  it("builds each structure once per index, and a lookup after the first does not walk the module table", async () => {
    const root = await writeProject(MEMBER_PROJECT);
    const index = await buildProjectIndex(root, { cache: "off" });
    const counting = new CountingMap(index.byFile);
    index.byFile = counting;

    const lookups = [
      definitionOf(index, "helper", "src/def.ts"),
      definitionOf(index, "Widget", "src/widget.ts"),
      definitionOf(index, "render", "src/widget.ts"),
      definitionOf(index, "other", "src/def.ts"),
      definitionOf(index, "make", "src/widget.ts"),
      definitionOf(index, "size", "src/widget.ts"),
    ];
    // The first lookups of each kind build what they need: the member lookups the module table and coverage facts.
    for (const def of lookups.slice(0, 3)) await findReferences(index, { def });
    expect(counting.iterations).toBeGreaterThan(0);
    const warmEdges = exportEdgeIndex(index);
    const warmTable = referenceModuleTable(index);
    const warmFacts = coverageFacts(index);

    counting.iterations = 0;
    for (const def of lookups) {
      for (const maxReferences of [undefined, 3]) {
        const result = await findReferences(index, { def }, maxReferences ? { maxReferences } : undefined);
        expect(result.status).toBe("ok");
      }
    }
    expect(counting.iterations).toBe(0);
    // Reused, not rebuilt.
    expect(exportEdgeIndex(index)).toBe(warmEdges);
    expect(referenceModuleTable(index)).toBe(warmTable);
    expect(coverageFacts(index)).toBe(warmFacts);
    expect(counting.iterations).toBe(0);
  });

  it("drops a structure with the index object and rebuilds it when the module table is replaced", async () => {
    const root = await writeProject(CHAIN_PROJECT);
    const index = await buildProjectIndex(root, { cache: "off" });
    const other = await buildProjectIndex(root, { cache: "off" });

    const edges = exportEdgeIndex(index);
    expect(exportEdgeIndex(other)).not.toBe(edges);
    const table = referenceModuleTable(index);
    expect(table.entries.map((entry) => relativeTo(root, entry.file))).toEqual(
      [...index.byFile.values()].map((module) => relativeTo(root, module.file)).sort((a, b) => a.localeCompare(b)),
    );

    index.byFile = new Map([...index.byFile].slice(1));
    expect(referenceModuleTable(index)).not.toBe(table);
    expect(referenceModuleTable(index).entries.length).toBe(table.entries.length - 1);
  });

  it("finds the modules that re-export a file, directly or through other re-exporters", async () => {
    const root = await writeProject(CHAIN_PROJECT);
    const index = await buildProjectIndex(root, { cache: "off" });
    const definitionFile = definitionOf(index, "helper", "src/def.ts").file;

    const reached = reverseReachableModules(index, [definitionFile], { danglingNames: ["helper"] });
    expect(reached.modules.map((module) => relativeTo(root, module.file)).sort()).toEqual([
      "src/alias.ts",
      "src/barrel.ts",
      "src/deep.ts",
      "src/def.ts",
      "src/ns-outer.ts",
      "src/ns.ts",
    ]);
    expect(reached.keys.has(fileIdentityKey(definitionFile))).toBe(true);

    const owners = namespaceReexportOwners(index, new Set([fileIdentityKey(definitionFile)]));
    expect(owners.map((module) => relativeTo(root, module.file))).toEqual(["src/ns.ts"]);
    expect(localExportsNamed(index, "helper").map(({ module }) => relativeTo(root, module.file))).toEqual([
      "src/decoy.ts",
      "src/def.ts",
    ]);
  });

  it("starts from empty structures when an incremental build returns a new index with another importer", async () => {
    const root = await writeProject({
      "src/lib.ts": "export function shared(): number {\n  return 1;\n}\n",
      "src/barrel.ts": 'export * from "./lib";\n',
      "src/early.ts": 'import { shared } from "./barrel";\nexport const early = shared();\n',
    });
    const cacheDir = await roots.create("cg-reference-candidates-cache-");
    const options = { cache: "disk", cacheDir, threads: 1 } as const;
    const before = await buildProjectIndexIncremental(root, options);
    const beforeDef = definitionOf(before, "shared", "src/lib.ts");
    expect(candidateFilesOf(before, root, beforeDef)).toEqual(["src/barrel.ts", "src/early.ts"]);
    const beforeEdges = exportEdgeIndex(before);

    await fsp.writeFile(
      path.join(root, "src/late.ts"),
      'import { shared } from "./barrel";\nexport const late = shared();\n',
    );
    await fsp.writeFile(path.join(root, "src/second-barrel.ts"), 'export { shared as renamed } from "./lib";\n');
    await fsp.writeFile(
      path.join(root, "src/late-alias.ts"),
      'import { renamed } from "./second-barrel";\nexport const lateAlias = renamed();\n',
    );
    const after = await buildProjectIndexIncremental(root, options);
    const afterDef = definitionOf(after, "shared", "src/lib.ts");

    expect(after).not.toBe(before);
    expect(exportEdgeIndex(after)).not.toBe(beforeEdges);
    expect(candidateFilesOf(after, root, afterDef)).toEqual([
      "src/barrel.ts",
      "src/early.ts",
      "src/late-alias.ts",
      "src/late.ts",
      "src/second-barrel.ts",
    ]);
    const result = await findReferences(after, { def: afterDef });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(new Set(result.references.map((reference) => relativeTo(root, reference.file)))).toEqual(
      new Set(["src/early.ts", "src/late-alias.ts", "src/late.ts", "src/lib.ts", "src/second-barrel.ts"]),
    );
    // The earlier index still answers for the files it indexed.
    expect(candidateFilesOf(before, root, beforeDef)).toEqual(["src/barrel.ts", "src/early.ts"]);
  });
});

describe("reference coverage of a member lookup", () => {
  const files: Record<string, string> = {
    "0-broken.ts": "export const early = <render;\n",
    "a-first.ts": "export class Box {\n  render(): number {\n    return 1;\n  }\n}\n",
    "b-user.ts": 'import { Box } from "./a-first";\nexport const x = new Box().render();\n',
    "c-broken.ts": "export const broken = <render;\n",
    "d-other.ts": "export const fine = 1;\n",
    "z-broken.ts": "export const alsoBroken = <render;\n",
  };

  async function coverageOf(
    maxReferences: number | undefined,
  ): Promise<{ reasons: readonly string[]; affected: string[] }> {
    const root = await writeProject(files);
    const index = await buildProjectIndex(root, { cache: "off" });
    const def = definitionOf(index, "render", "a-first.ts");
    const result = await findReferences(index, { def }, maxReferences ? { maxReferences } : undefined);
    if (result.status !== "ok") throw new Error(`lookup failed: ${result.reason}`);
    const coverage = result.referenceCoverage;
    if (coverage?.state !== "partial") return { reasons: [], affected: [] };
    return {
      reasons: coverage.reasons ?? [],
      affected: (coverage.affectedFiles ?? []).map((file) => relativeTo(root, file)),
    };
  }

  it("reports every file with a syntax error when the receiver scan visits the whole project", async () => {
    expect(await coverageOf(undefined)).toEqual({
      reasons: ["parse_error"],
      affected: ["0-broken.ts", "c-broken.ts", "z-broken.ts"],
    });
    expect(await coverageOf(3)).toEqual({
      reasons: ["parse_error"],
      affected: ["0-broken.ts", "c-broken.ts", "z-broken.ts"],
    });
  });

  it("reports only the files the receiver scan reached before the reference limit", async () => {
    expect(await coverageOf(1)).toEqual({ reasons: ["parse_error", "truncated"], affected: ["0-broken.ts"] });
  });
});

describe("lookups through a star-export cycle on a cold index", () => {
  const files = CYCLE_PROJECTS["star cycle, the importer's module sorts first"]!;

  it("lists the importer of a module that star-exports its own star exporter", async () => {
    const root = await writeProject(files);
    const index = await buildProjectIndex(root, { cache: "off" });
    const def = definitionOf(index, "foo", "def.ts");

    // `a.ts` and `b.ts` star-export each other and `b.ts` also star-exports `def.ts`. A scan of every module probes
    // `a.ts` first and caches its answer; probing `b.ts` first cuts `a.ts` short and caches nothing for it.
    expect(candidateFilesOf(index, root, def)).toEqual(["a.ts", "b.ts", "consumer.ts"]);
    const result = await findReferences(index, { def });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect([...new Set(result.references.map((reference) => relativeTo(root, reference.file)))].sort()).toEqual([
      "consumer.ts",
      "def.ts",
    ]);
    expect(result.referenceCoverage?.state).toBe("complete");
  });

  it("probes the reachable modules in the order a scan of every module visits them", async () => {
    const root = await writeProject(files);
    const index = await buildProjectIndex(root, { cache: "off" });
    const def = definitionOf(index, "foo", "def.ts");

    const reached = reverseReachableModules(index, [def.file], { danglingNames: ["foo"] });

    const scanOrder = [...index.byFile.values()].filter((module) => reached.modules.includes(module));
    expect(reached.modules.map((module) => relativeTo(root, module.file))).toEqual(["a.ts", "b.ts", "def.ts"]);
    expect(reached.modules).toEqual(scanOrder);
  });

  it("previews a rename that reaches the importer through the cycle", async () => {
    const root = await writeProject(files);
    // A session snapshot would load the symbol graph, which resolves exports module by module before the rename
    // runs; this snapshot holds the cold index alone, so the rename's own lookup is the first to probe the cycle.
    const projectFiles = Object.keys(files)
      .sort()
      .map((name) => path.join(root, name).replace(/\\/g, "/"));
    const index = await buildProjectIndexFromFiles(root, projectFiles, { cache: "off", keepParsed: true });
    const snapshot: AgentProjectSnapshot = {
      root,
      files: projectFiles,
      index,
      fileGraph: index.graph,
      symbolGraph: { nodes: new Map(), edges: [] },
      analysis: {
        mode: "semantic",
        backend: "unknown",
        parserDegradedFiles: 0,
        nativeFilesUsed: 0,
        nativeFilesFellBack: 0,
        label: "semantic",
      },
    };

    const preview = await previewRenameInSnapshot(snapshot, { root, handle: "def.ts::foo", newName: "renamed" });

    const edited = new Set(
      preview.edits.map((edit) => (path.isAbsolute(edit.file) ? relativeTo(root, edit.file) : edit.file)),
    );
    expect([...edited].sort()).toEqual(["consumer.ts", "def.ts"]);
    expect(preview.edits.filter((edit) => edit.file.endsWith("consumer.ts")).map((edit) => edit.kind)).toContain(
      "import",
    );
  });
});

describe("dense star-export candidate discovery", () => {
  it("visits each reachable star edge at most once while retaining DFS alias order", async () => {
    const root = await writeProject(denseStarProject());
    const index = await buildProjectIndex(root, { cache: "off" });
    const start = index.byFile.get(fileIdentityKey(path.join(root, "m0.ts")));
    if (!start) throw new Error("Expected the first star-export module");
    const starEdges = [...index.byFile.values()].reduce(
      (count, module) => count + module.exports.filter((entry) => entry.type === "exportStar").length,
      0,
    );
    class BoundedReads<K, V> extends Map<K, V> {
      reads = 0;
      override get(key: K): V | undefined {
        this.reads += 1;
        if (this.reads > starEdges) throw new Error(`Repeated star traversal: more than ${starEdges} module reads`);
        return super.get(key);
      }
    }
    const reads = new BoundedReads(index.byFile);
    index.byFile = reads;
    // A candidate name is not proof of an export: `masked` resolves to the decoy.
    expect(moduleExportProbeNames(index, start, ["target"])).toEqual(["target", "forwarded", "masked"]);
    expect(reads.reads).toBeLessThanOrEqual(starEdges);
  }, 30_000);

  it("keeps cold and repeated references and rename edits for aliases, without shadowed or ambiguous decoys", async () => {
    const files = denseStarProject();
    const root = await writeProject(files);
    const projectFiles = Object.keys(files).map((name) => path.join(root, name).replace(/\\/g, "/"));
    const index = await buildProjectIndexFromFiles(root, projectFiles, { cache: "off", keepParsed: true });
    const def = definitionOf(index, "target", "def.ts");
    const hiddenFile = path.join(root, "hidden.ts");
    const hiddenLocal = resolveExport(index, hiddenFile, "target");
    expect(hiddenLocal?.kind).toBe("resolved");
    if (hiddenLocal?.kind === "resolved") {
      expect(fileIdentityKey(hiddenLocal.def.file)).toBe(fileIdentityKey(hiddenFile));
    }
    expect(resolveExport(index, hiddenFile, "target", { allowLocalFallback: false })).toBeNull();
    const forwarded = resolveExport(index, path.join(root, "m0.ts"), "target");
    expect(forwarded?.kind).toBe("resolved");
    if (forwarded?.kind === "resolved") {
      expect(fileIdentityKey(forwarded.def.file)).toBe(fileIdentityKey(def.file));
    }
    const directCall = await goToDefinition(index, {
      file: path.join(root, "consumer.ts"),
      line: 7,
      column: 23,
    });
    expect(directCall.status).toBe("ok");
    if (directCall.status === "ok") {
      expect(fileIdentityKey(directCall.definition.file)).toBe(fileIdentityKey(def.file));
    }
    const cold = await findReferences(index, { def });
    const repeated = await findReferences(index, { def });
    expect(cold.status).toBe("ok");
    expect(repeated).toEqual(cold);
    if (cold.status !== "ok") return;
    expect([...new Set(cold.references.map((ref) => relativeTo(root, ref.file)))].sort()).toEqual([
      "consumer.ts",
      "def.ts",
      "m9.ts",
    ]);
    expect(
      cold.references
        .filter((ref) => relativeTo(root, ref.file) === "consumer.ts" && ref.range.start.line >= 7)
        .map((ref) => ref.range.start.line),
    ).toEqual([7, 8, 9, 10]);

    const snapshot: AgentProjectSnapshot = {
      root,
      files: projectFiles,
      index: coldClone(index),
      fileGraph: index.graph,
      symbolGraph: { nodes: new Map(), edges: [] },
      analysis: {
        mode: "semantic",
        backend: "unknown",
        parserDegradedFiles: 0,
        nativeFilesUsed: 0,
        nativeFilesFellBack: 0,
        label: "semantic",
      },
    };
    const preview = await previewRenameInSnapshot(snapshot, {
      root,
      handle: "def.ts::target",
      newName: "renamedTarget",
    });
    expect(
      preview.edits
        .filter((edit) => edit.file === "consumer.ts")
        .map((edit) => [edit.range.start.line, edit.oldText, edit.kind]),
    ).toEqual([
      [1, "target", "import"],
      [2, "target", "import"],
      [7, "target", "reference"],
      [10, "target", "reference"],
    ]);
    expect(
      preview.edits.filter((edit) => edit.file !== "consumer.ts").map((edit) => [edit.file, edit.oldText, edit.kind]),
    ).toEqual([
      ["def.ts", "target", "definition"],
      ["m9.ts", "target", "export"],
    ]);
  }, 30_000);
});
