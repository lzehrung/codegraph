import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  buildProjectIndex,
  buildProjectIndexFromFiles,
  buildProjectIndexIncremental,
  buildSymbolGraphDetailed,
  findReferences,
  getUnresolvedImports,
  goToDefinition,
  type BuildReport,
} from "../src/index.js";
import { createAgentSession } from "../src/agent/session.js";
import {
  cacheDatabasePath,
  cacheRelativePath,
  closeDiskCacheDatabase,
  memoryCacheLostPayloads,
  peekCachedModule,
  tryLoadFromCache,
  writeToCache,
} from "../src/indexer/build-cache/module-cache.js";
import type { ProjectIndex } from "../src/indexer/types.js";
import { fileIdentityKey, normalizePath } from "../src/util/paths.js";
import { columnOf, writeFixtureFiles } from "./languages/callable-consumer-fixtures.js";
import { mkTmpDir } from "./helpers/filesystem.js";
import { csharpInheritedAliasCase } from "./helpers/csharp-inherited-alias-fixture.js";
import { runGit as git } from "./helpers/git.js";
import {
  DUPLICATE_DECLARATION_FIXTURES,
  expectDuplicateRemovalMatchesColdBuilds,
  withDuplicateDeclarations,
} from "./helpers/duplicate-declaration-import-fixture.js";
import {
  RESTORED_DECLARATION_FIXTURES,
  declarationImportTargets,
  withRestoredDeclarationImport,
} from "./helpers/restored-declaration-import-fixture.js";

import {
  PHP_PATH_IMPORT_FORMS,
  PHP_PATH_MAPPINGS,
  phpPathFallbackFixture,
  PHP_INCOMPLETE_DECLARATION_SOURCES,
} from "./helpers/php-path-fallback-fixture.js";
import { clearMemoryCache } from "../src/indexer/build-cache.js";
import { PHP_INCOMPLETE_DECLARATION_IDENTITY } from "../src/indexer/php-namespace-symbols.js";
const DISK_BUILD = { cache: "disk" as const };

/** Consumer edges as comparable strings, independent of the temporary root. */
function edgeTargets(index: ProjectIndex, file: string): string[] {
  return index.graph.edges
    .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(file))
    .map((edge) => (edge.to.type === "file" ? `file:${normalizePath(edge.to.path)}` : `external:${edge.to.name}`))
    .sort();
}

async function expectWarmMatchesCold(
  root: string,
  consumer: string,
  warm: ProjectIndex,
  options: Parameters<typeof buildProjectIndex>[1] = {},
): Promise<string[]> {
  const cold = await buildProjectIndex(root, { ...options, cache: "off" });
  const warmTargets = edgeTargets(warm, consumer);
  expect(warmTargets).toEqual(edgeTargets(cold, consumer));
  return warmTargets;
}

function expectNoReprocessedFiles(report: BuildReport, addedFiles = 0): void {
  expect((report.files?.parsed ?? 0) - addedFiles).toBe(0);
  expect((report.files?.changed ?? 0) - addedFiles).toBe(0);
}

type AddedImportFixtureFile = {
  relativePath: string;
  contents: string;
};

type AddedExternalImportFixture = {
  name: string;
  consumerRelativePath: string;
  consumerLines: readonly string[];
  targetRelativePath: string;
  targetContents: string;
  initialFiles: readonly AddedImportFixtureFile[];
  queryLine: number;
  queryNeedle: string;
};

const ADDED_EXTERNAL_IMPORT_FIXTURES = [
  {
    name: "Java",
    consumerRelativePath: "p/Main.java",
    consumerLines: ["package p;", "import p.Item;", "class Main {", "  Item item = new Item();", "}", ""],
    targetRelativePath: "p/Item.java",
    targetContents: "package p;\npublic class Item {}\n",
    initialFiles: [],
    queryLine: 4,
    queryNeedle: "Item item",
  },
  {
    name: "Kotlin",
    consumerRelativePath: "p/Main.kt",
    consumerLines: ["package p", "import p.Item", "fun use(item: Item): Item = item", ""],
    targetRelativePath: "p/Item.kt",
    targetContents: "package p\nclass Item\n",
    initialFiles: [],
    queryLine: 3,
    queryNeedle: "Item):",
  },
  {
    name: "Rust",
    consumerRelativePath: "src/consumer.rs",
    consumerLines: ["use crate::foo::Thing;", "", "pub fn run() {", "    Thing::hit();", "}", ""],
    targetRelativePath: "src/foo.rs",
    targetContents: ["pub struct Thing;", "impl Thing {", "    pub fn hit() {}", "}", ""].join("\n"),
    initialFiles: [
      { relativePath: "Cargo.toml", contents: '[package]\nname = "cache-probe"\nversion = "0.1.0"\n' },
      { relativePath: "src/lib.rs", contents: "pub mod consumer;\npub mod foo;\n" },
    ],
    queryLine: 4,
    queryNeedle: "hit",
  },
  {
    name: "C#",
    consumerRelativePath: "Program.cs",
    consumerLines: ["using P;", "class Program {", "  static int Run() => Thing.Value();", "}", ""],
    targetRelativePath: "p/Thing.cs",
    targetContents: "namespace P;\npublic class Thing { public static int Value() => 1; }\n",
    initialFiles: [],
    queryLine: 3,
    queryNeedle: "Thing",
  },
  {
    name: "Go",
    consumerRelativePath: "main.go",
    consumerLines: [
      "package probe",
      'import "example.com/probe/thing"',
      "func run() int {",
      "  return thing.Value()",
      "}",
      "",
    ],
    targetRelativePath: "thing/widget.go",
    targetContents: "package thing\nfunc Value() int { return 1 }\n",
    initialFiles: [{ relativePath: "go.mod", contents: "module example.com/probe\n\ngo 1.22\n" }],
    queryLine: 4,
    queryNeedle: "Value",
  },
] satisfies readonly AddedExternalImportFixture[];

function importBindings(index: ProjectIndex, file: string): Array<{ kind: string; resolved: unknown }> {
  return (index.byFile.get(fileIdentityKey(file))?.imports ?? []).map((binding) => ({
    kind: binding.kind,
    resolved: typeof binding.resolved === "string" ? normalizePath(binding.resolved) : binding.resolved,
  }));
}

async function writeFixtureFile(root: string, relativePath: string, contents: string): Promise<string> {
  const file = path.join(root, relativePath);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, contents, "utf8");
  return file;
}

describe("warm disk-cache build reacts when a file starts or stops resolving an import", () => {
  it("reparses nothing when an unrelated file is deleted", async () => {
    const root = await mkTmpDir("cg-unrelated-delete-");
    try {
      const tsFile = path.join(root, "main.ts");
      const scssFile = path.join(root, "main.scss");
      const unrelated = path.join(root, "note.ts");
      await fsp.writeFile(tsFile, 'import "./missing";\nexport const value = 1;\n', "utf8");
      await fsp.writeFile(scssFile, '@import "./missing";\n', "utf8");
      await fsp.writeFile(unrelated, "export const note = 1;\n", "utf8");

      const initial = await buildProjectIndexIncremental(root, DISK_BUILD);
      expect(edgeTargets(initial, tsFile)).toContain("external:./missing");
      expect(edgeTargets(initial, scssFile)).toContain("external:./missing");

      await fsp.unlink(unrelated);
      const report: BuildReport = { timings: {} };
      const warm = await buildProjectIndexIncremental(root, { ...DISK_BUILD, report });
      expectNoReprocessedFiles(report);
      expect(edgeTargets(warm, tsFile)).toEqual(edgeTargets(initial, tsFile));
      expect(edgeTargets(warm, scssFile)).toEqual(edgeTargets(initial, scssFile));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a previously unresolved relative import once the target file is added, and unresolves it again once deleted", async () => {
    const root = await mkTmpDir("cg-add-delete-");
    try {
      const p = path.join(root, "p.ts");
      const decoy = path.join(root, "decoy.ts");
      const q = path.join(root, "q.ts");
      const otherQ = path.join(root, "other", "q.ts");
      const pLines = ['import { q } from "./q";', "export function run(): number {", "  return q();", "}", ""];
      await fsp.writeFile(p, pLines.join("\n"), "utf8");
      await fsp.writeFile(
        decoy,
        ['import z from "definitely-not-a-real-package";', "export const zVal = z;", ""].join("\n"),
        "utf8",
      );

      const initial = await buildProjectIndexIncremental(root, DISK_BUILD);
      expect(getUnresolvedImports(initial.graph, { projectRoot: root }).map((entry) => entry.name)).toContain("./q");

      // A same-named file in an unrelated directory arrives alongside the real one: only the
      // sibling `q.ts` may resolve `./q` from `p.ts`.
      const qLines = ["export function q(): number {", "  return 42;", "}", ""];
      await fsp.mkdir(path.dirname(otherQ), { recursive: true });
      await fsp.writeFile(q, qLines.join("\n"), "utf8");
      await fsp.writeFile(otherQ, ["export function q(): number {", "  return 999;", "}", ""].join("\n"), "utf8");

      const warm = await buildProjectIndexIncremental(root, DISK_BUILD);
      const targets = await expectWarmMatchesCold(root, p, warm);

      expect(targets).toContain(`file:${normalizePath(q)}`);
      expect(targets.some((target) => target.endsWith("/other/q.ts"))).toBe(false);
      expect(targets).not.toContain("external:./q");

      const warmUnresolved = getUnresolvedImports(warm.graph, { projectRoot: root }).map((entry) => entry.name);
      expect(warmUnresolved).not.toContain("./q");
      expect(warmUnresolved).toContain("definitely-not-a-real-package"); // decoy stays unresolved

      const gotoWarm = await goToDefinition(warm, { file: p, line: 3, column: columnOf(pLines, 3, "q(") });
      expect(gotoWarm.status).toBe("ok");
      if (gotoWarm.status !== "ok") throw new Error("expected goToDefinition to resolve after q.ts was added");
      expect(normalizePath(gotoWarm.definition.file)).toBe(normalizePath(q));

      const refsWarm = await findReferences(warm, { file: q, line: 1, column: columnOf(qLines, 1, "q(") });
      expect(refsWarm.status).toBe("ok");
      if (refsWarm.status !== "ok") throw new Error("expected findReferences to resolve after q.ts was added");
      expect(refsWarm.references.some((reference) => normalizePath(reference.file) === normalizePath(p))).toBe(true);
      expect(refsWarm.referenceCoverage.state).toBe("complete");

      const detailed = await buildSymbolGraphDetailed(warm);
      const qNode = [...detailed.nodes.values()].find((node) => node.file === normalizePath(q) && node.name === "q");
      const runNode = [...detailed.nodes.values()].find(
        (node) => node.file === normalizePath(p) && node.name === "run",
      );
      expect(qNode).toBeTruthy();
      expect(runNode).toBeTruthy();
      expect(
        detailed.edges.some((edge) => edge.label === "calls" && edge.from === runNode!.id && edge.to === qNode!.id),
      ).toBe(true);

      // A genuine no-change warm rebuild must not reprocess anything.
      const noChangeReport: BuildReport = { timings: {} };
      await buildProjectIndexIncremental(root, { ...DISK_BUILD, report: noChangeReport });
      expectNoReprocessedFiles(noChangeReport);

      // Deleting the resolving file must unresolve the import again, matching a cold build.
      await fsp.rm(q);
      await fsp.rm(otherQ);
      const warmAfterDelete = await buildProjectIndexIncremental(root, DISK_BUILD);
      const targetsAfterDelete = await expectWarmMatchesCold(root, p, warmAfterDelete);
      expect(targetsAfterDelete).toEqual(["external:./q"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { scenario: "an extensionless specifier", specifier: "./q", targetRelativePath: "q.ts" },
    { scenario: "a dotted literal stem", specifier: "./data.model", targetRelativePath: "data.model.ts" },
    {
      scenario: "a JavaScript compatibility-family specifier",
      specifier: "./data.js",
      targetRelativePath: "data.ts",
    },
  ])("keeps added-file re-resolution aligned with resolver extension rules for $scenario", async (fixture) => {
    const root = await mkTmpDir("cg-added-stem-");
    try {
      const main = path.join(root, "main.ts");
      const target = path.join(root, fixture.targetRelativePath);
      const mainLines = [
        `import { q } from "${fixture.specifier}";`,
        "export function run(): number {",
        "  return q();",
        "}",
        "",
      ];
      const targetLines = ["export function q(): number {", "  return 1;", "}", ""];
      await fsp.writeFile(main, mainLines.join("\n"), "utf8");

      const initial = await buildProjectIndexIncremental(root, DISK_BUILD);
      expect(edgeTargets(initial, main)).toEqual([`external:${fixture.specifier}`]);

      await fsp.writeFile(target, targetLines.join("\n"), "utf8");
      const warm = await buildProjectIndexIncremental(root, DISK_BUILD);
      const targets = await expectWarmMatchesCold(root, main, warm);
      expect(targets).toEqual([`file:${normalizePath(target)}`]);
      expect(targets).not.toContain(`external:${fixture.specifier}`);

      const goto = await goToDefinition(warm, { file: main, line: 3, column: columnOf(mainLines, 3, "q(") });
      expect(goto.status).toBe("ok");
      if (goto.status !== "ok") throw new Error("expected goToDefinition to resolve after the target was added");
      expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(target));

      const refs = await findReferences(warm, { file: target, line: 1, column: columnOf(targetLines, 1, "q(") });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") throw new Error("expected findReferences to resolve after the target was added");
      expect(refs.references.some((reference) => fileIdentityKey(reference.file) === fileIdentityKey(main))).toBe(true);
      expect(refs.referenceCoverage.state).toBe("complete");

      const detailed = await buildSymbolGraphDetailed(warm);
      const qNode = [...detailed.nodes.values()].find(
        (node) => node.file === normalizePath(target) && node.name === "q",
      );
      const runNode = [...detailed.nodes.values()].find(
        (node) => node.file === normalizePath(main) && node.name === "run",
      );
      expect(qNode).toBeTruthy();
      expect(runNode).toBeTruthy();
      expect(
        detailed.edges.some((edge) => edge.label === "calls" && edge.from === runNode!.id && edge.to === qNode!.id),
      ).toBe(true);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
  it("auto-refreshes a warm agent session so a newly added file resolves a previously unresolved import", async () => {
    const root = await mkTmpDir("cg-session-");
    try {
      const p = path.join(root, "p.ts");
      const pLines = ['import { q } from "./q";', "export function run(): number {", "  return q();", "}", ""];
      await fsp.writeFile(p, pLines.join("\n"), "utf8");

      const session = createAgentSession({ root, buildOptions: { cache: "disk" }, freshness: { policy: "auto" } });
      const before = await session.loadProject({ symbolGraph: "skip" });
      expect(getUnresolvedImports(before.fileGraph, { projectRoot: root }).map((entry) => entry.name)).toContain("./q");

      const q = path.join(root, "q.ts");
      await fsp.writeFile(q, "export function q(): number {\n  return 42;\n}\n", "utf8");

      const freshness = await session.checkFreshness!();
      expect(freshness.state).toBe("refreshed");

      const after = await session.loadProject({ symbolGraph: "skip" });
      expect(getUnresolvedImports(after.fileGraph, { projectRoot: root }).map((entry) => entry.name)).not.toContain(
        "./q",
      );

      const goto = await goToDefinition(after.index, { file: p, line: 3, column: columnOf(pLines, 3, "q(") });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") {
        expect(normalizePath(goto.definition.file)).toBe(normalizePath(q));
      }

      session.invalidate();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a Python absolute package import once the target module is added, and unresolves it again once deleted", async () => {
    const root = await mkTmpDir("cg-python-");
    try {
      const main = path.join(root, "main.py");
      const util = path.join(root, "pkg", "util.py");
      const otherUtil = path.join(root, "other", "util.py");
      const mainLines = ["import pkg.util", "", "result = pkg.util.helper()", ""];
      await fsp.writeFile(main, mainLines.join("\n"), "utf8");

      const initial = await buildProjectIndexIncremental(root, DISK_BUILD);
      expect(getUnresolvedImports(initial.graph, { projectRoot: root }).map((entry) => entry.name)).toContain(
        "pkg.util",
      );

      // A same-named module in an unrelated directory arrives alongside the real one: only
      // `pkg/util.py` may resolve `pkg.util`.
      const utilLines = ["def helper():", "    return 42", ""];
      await fsp.mkdir(path.dirname(util), { recursive: true });
      await fsp.mkdir(path.dirname(otherUtil), { recursive: true });
      await fsp.writeFile(util, utilLines.join("\n"), "utf8");
      await fsp.writeFile(otherUtil, ["def helper():", "    return 999", ""].join("\n"), "utf8");

      const warm = await buildProjectIndexIncremental(root, DISK_BUILD);
      const targets = await expectWarmMatchesCold(root, main, warm);

      expect(targets).toContain(`file:${normalizePath(util)}`);
      expect(targets.some((target) => target.endsWith("/other/util.py"))).toBe(false);

      const warmUnresolved = getUnresolvedImports(warm.graph, { projectRoot: root }).map((entry) => entry.name);
      expect(warmUnresolved).not.toContain("pkg.util");

      const gotoWarm = await goToDefinition(warm, { file: main, line: 1, column: columnOf(mainLines, 1, "pkg") });
      expect(gotoWarm.status).toBe("ok");
      if (gotoWarm.status !== "ok") throw new Error("expected goToDefinition to resolve after pkg/util.py was added");
      expect(normalizePath(gotoWarm.definition.file)).toBe(normalizePath(util));

      const refsWarm = await findReferences(warm, { file: util, line: 1, column: columnOf(utilLines, 1, "helper") });
      expect(refsWarm.status).toBe("ok");
      if (refsWarm.status !== "ok") throw new Error("expected findReferences to resolve after pkg/util.py was added");
      expect(refsWarm.references.some((reference) => normalizePath(reference.file) === normalizePath(util))).toBe(true);

      const noChangeReport: BuildReport = { timings: {} };
      await buildProjectIndexIncremental(root, { ...DISK_BUILD, report: noChangeReport });
      expectNoReprocessedFiles(noChangeReport);

      await fsp.rm(util);
      await fsp.rm(otherUtil);
      const warmAfterDelete = await buildProjectIndexIncremental(root, DISK_BUILD);
      const targetsAfterDelete = await expectWarmMatchesCold(root, main, warmAfterDelete);
      expect(targetsAfterDelete).toEqual(["external:pkg.util"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { scenario: "already exists", hasPackageDirectory: true },
    { scenario: "is created with the module", hasPackageDirectory: false },
  ])("re-resolves a top-level namespace import when its directory $scenario", async ({ hasPackageDirectory }) => {
    const root = await mkTmpDir("cg-py-namespace-root-");
    try {
      const mainLines = ["from pkg import name", "", "def run():", "    return name.value()", ""];
      const main = await writeFixtureFile(root, "main.py", mainLines.join("\n"));
      const decoy = await writeFixtureFile(root, "other/name.py", "def value():\n    return -1\n");
      if (hasPackageDirectory) await fsp.mkdir(path.join(root, "pkg"));

      const initial = await buildProjectIndexIncremental(root, DISK_BUILD);
      expect(edgeTargets(initial, main)).toContain("external:pkg");

      const target = await writeFixtureFile(root, "pkg/name.py", "def value():\n    return 1\n");
      const warm = await buildProjectIndexIncremental(root, DISK_BUILD);
      const cold = await buildProjectIndex(root, { cache: "off" });
      expect(importBindings(cold, main)).toEqual([{ kind: "namespace", resolved: normalizePath(target) }]);
      expect(importBindings(warm, main)).toEqual(importBindings(cold, main));
      expect(edgeTargets(warm, main)).toEqual(edgeTargets(cold, main));

      for (const index of [cold, warm]) {
        const goto = await goToDefinition(index, {
          file: main,
          line: 4,
          column: columnOf(mainLines, 4, "value"),
        });
        expect(goto.status).toBe("ok");
        if (goto.status !== "ok") throw new Error("expected the namespace submodule to resolve");
        expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(target));
        expect(fileIdentityKey(goto.definition.file)).not.toBe(fileIdentityKey(decoy));
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
  it("re-resolves `from pkg import sub` once a namespace subpackage directory gains a module", async () => {
    const root = await mkTmpDir("cg-py-namespace-sub-");
    try {
      const main = path.join(root, "main.py");
      await fsp.mkdir(path.join(root, "pkg"), { recursive: true });
      await fsp.writeFile(path.join(root, "pkg", "__init__.py"), "", "utf8");
      await fsp.writeFile(main, ["from pkg import sub", "", "def run():", "    return sub", ""].join("\n"), "utf8");

      await buildProjectIndexIncremental(root, DISK_BUILD);
      // `pkg/sub/` has no __init__.py: a PEP 420 namespace directory one level below the package.
      await fsp.mkdir(path.join(root, "pkg", "sub"), { recursive: true });
      await fsp.writeFile(path.join(root, "pkg", "sub", "thing.py"), "def value():\n    return 1\n", "utf8");

      const warm = await buildProjectIndexIncremental(root, DISK_BUILD);
      const cold = await buildProjectIndex(root, { cache: "off" });
      const bindings = (index: ProjectIndex) =>
        (index.byFile.get(fileIdentityKey(main))?.imports ?? []).map((imp) => ({
          kind: imp.kind,
          resolved: typeof imp.resolved === "string" ? normalizePath(imp.resolved) : imp.resolved,
        }));
      expect(bindings(cold).some((binding) => binding.kind === "namespace")).toBe(true);
      expect(bindings(warm)).toEqual(bindings(cold));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("re-resolves `from pkg import mod` once the submodule file is added beside an existing package", async () => {
    const root = await mkTmpDir("cg-py-submodule-");
    try {
      const main = path.join(root, "main.py");
      const init = path.join(root, "pkg", "__init__.py");
      const relativeUser = path.join(root, "pkg", "user.py");
      const submodule = path.join(root, "pkg", "mod.py");
      await fsp.mkdir(path.dirname(init), { recursive: true });
      await fsp.writeFile(init, "", "utf8");
      await fsp.writeFile(
        main,
        ["from pkg import mod", "", "def run():", "    return mod.value()", ""].join("\n"),
        "utf8",
      );
      await fsp.writeFile(
        relativeUser,
        ["from . import mod", "", "def use():", "    return mod.value()", ""].join("\n"),
        "utf8",
      );

      await buildProjectIndexIncremental(root, DISK_BUILD);
      await fsp.writeFile(submodule, "def value():\n    return 1\n", "utf8");

      const warm = await buildProjectIndexIncremental(root, DISK_BUILD);
      const cold = await buildProjectIndex(root, { cache: "off" });
      for (const [file, line] of [
        [main, 4],
        [relativeUser, 4],
      ] as const) {
        const bindings = (index: ProjectIndex) =>
          (index.byFile.get(fileIdentityKey(file))?.imports ?? []).map((imp) => ({
            kind: imp.kind,
            resolved: typeof imp.resolved === "string" ? normalizePath(imp.resolved) : imp.resolved,
          }));
        expect(bindings(warm)).toEqual(bindings(cold));
        const column = "    return mod.value()".indexOf("value") + 1;
        const target = await goToDefinition(warm, { file, line, column });
        expect(target.status).toBe("ok");
        if (target.status === "ok") expect(fileIdentityKey(target.definition.file)).toBe(fileIdentityKey(submodule));
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps both unresolved include forms so a header added beside the includer resolves the quoted form", async () => {
    const root = await mkTmpDir("cg-c-include-forms-");
    try {
      const main = path.join(root, "src", "main.c");
      const header = path.join(root, "src", "x.h");
      // The angle form comes first, so a form-blind dedup would keep only it, and an angle
      // include never searches the includer's directory.
      await fsp.mkdir(path.dirname(main), { recursive: true });
      await fsp.writeFile(
        main,
        ["#include <x.h>", '#include "x.h"', "int main(void) { return 0; }", ""].join("\n"),
        "utf8",
      );

      await buildProjectIndexIncremental(root, DISK_BUILD);
      await fsp.writeFile(header, "int x(void);\n", "utf8");

      const warm = await buildProjectIndexIncremental(root, DISK_BUILD);
      const targets = await expectWarmMatchesCold(root, main, warm);
      expect(targets).toContain(`file:${normalizePath(header)}`);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a C quoted #include once the header is added, and unresolves it again once deleted", async () => {
    const root = await mkTmpDir("cg-c-include-");
    try {
      const main = path.join(root, "main.c");
      const lib = path.join(root, "lib.h");
      const otherLib = path.join(root, "other", "lib.h");
      const mainLines = ['#include "lib.h"', "int use(void) {", "  return helper();", "}", ""];
      await fsp.writeFile(main, mainLines.join("\n"), "utf8");

      const initial = await buildProjectIndexIncremental(root, DISK_BUILD);
      expect(getUnresolvedImports(initial.graph, { projectRoot: root }).map((entry) => entry.name)).toContain("lib.h");

      // A same-named header in an unrelated directory arrives alongside the real one: a
      // quoted include must only bind to the sibling `lib.h`.
      const libLines = ["int helper(void);", ""];
      await fsp.mkdir(path.dirname(otherLib), { recursive: true });
      await fsp.writeFile(lib, libLines.join("\n"), "utf8");
      await fsp.writeFile(otherLib, ["int helper(void);", ""].join("\n"), "utf8");

      const warm = await buildProjectIndexIncremental(root, DISK_BUILD);
      const targets = await expectWarmMatchesCold(root, main, warm);

      expect(targets).toContain(`file:${normalizePath(lib)}`);
      expect(targets.some((target) => target.endsWith("/other/lib.h"))).toBe(false);
      expect(targets).not.toContain("external:lib.h");

      const warmUnresolved = getUnresolvedImports(warm.graph, { projectRoot: root }).map((entry) => entry.name);
      expect(warmUnresolved).not.toContain("lib.h");

      const gotoWarm = await goToDefinition(warm, { file: main, line: 3, column: columnOf(mainLines, 3, "helper(") });
      expect(gotoWarm.status).toBe("ok");
      if (gotoWarm.status !== "ok") throw new Error("expected goToDefinition to resolve after lib.h was added");
      expect(normalizePath(gotoWarm.definition.file)).toBe(normalizePath(lib));

      const refsWarm = await findReferences(warm, { file: lib, line: 1, column: columnOf(libLines, 1, "helper(") });
      expect(refsWarm.status).toBe("ok");
      if (refsWarm.status !== "ok") throw new Error("expected findReferences to resolve after lib.h was added");
      expect(refsWarm.references.some((reference) => normalizePath(reference.file) === normalizePath(main))).toBe(true);

      const noChangeReport: BuildReport = { timings: {} };
      await buildProjectIndexIncremental(root, { ...DISK_BUILD, report: noChangeReport });
      expectNoReprocessedFiles(noChangeReport);

      await fsp.rm(lib);
      await fsp.rm(otherLib);
      const warmAfterDelete = await buildProjectIndexIncremental(root, DISK_BUILD);
      const targetsAfterDelete = await expectWarmMatchesCold(root, main, warmAfterDelete);
      expect(targetsAfterDelete).toEqual(["external:lib.h"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
  it("re-resolves a cached quoted include from a resolution hint when a sibling header takes precedence", async () => {
    const root = await mkTmpDir("cg-c-hint-supersedes-");
    try {
      const main = path.join(root, "src", "main.c");
      const hintedHeader = path.join(root, "include", "foo.h");
      const siblingHeader = path.join(root, "src", "foo.h");
      const build = { ...DISK_BUILD, graph: { resolutionHints: ["include"] } };
      const mainLines = ['#include "foo.h"', "int run(void) { return selected(); }", ""];
      const hintedLines = ["int selected(void) { return 2; }", ""];
      const siblingLines = ["int selected(void) { return 1; }", ""];
      await writeFixtureFile(root, "include/foo.h", hintedLines.join("\n"));
      await writeFixtureFile(root, "src/main.c", mainLines.join("\n"));

      const initial = await buildProjectIndexIncremental(root, build);
      expect(edgeTargets(initial, main)).toEqual([`file:${normalizePath(hintedHeader)}`]);

      await writeFixtureFile(root, "src/foo.h", siblingLines.join("\n"));
      const warm = await buildProjectIndexIncremental(root, build);
      const targets = await expectWarmMatchesCold(root, main, warm, { graph: build.graph });
      expect(targets).toEqual([`file:${normalizePath(siblingHeader)}`]);

      const goto = await goToDefinition(warm, { file: main, line: 2, column: columnOf(mainLines, 2, "selected(") });
      expect(goto.status).toBe("ok");
      if (goto.status !== "ok") throw new Error("expected goToDefinition to use the sibling header");
      expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(siblingHeader));

      const refs = await findReferences(warm, {
        file: siblingHeader,
        line: 1,
        column: columnOf(siblingLines, 1, "selected("),
      });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") throw new Error("expected findReferences to use the sibling header");
      expect(refs.references.some((reference) => fileIdentityKey(reference.file) === fileIdentityKey(main))).toBe(true);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a tsconfig path alias once the target file is added, and unresolves it again once deleted", async () => {
    const root = await mkTmpDir("cg-ts-alias-");
    try {
      await fsp.writeFile(
        path.join(root, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["lib/*"] } } }, null, 2),
        "utf8",
      );
      const main = path.join(root, "main.ts");
      const util = path.join(root, "lib", "util.ts");
      const otherUtil = path.join(root, "other", "util.ts");
      const mainLines = [
        'import { fn } from "@lib/util";',
        "export function run(): number {",
        "  return fn();",
        "}",
        "",
      ];
      await fsp.writeFile(main, mainLines.join("\n"), "utf8");

      const initial = await buildProjectIndexIncremental(root, DISK_BUILD);
      expect(getUnresolvedImports(initial.graph, { projectRoot: root }).map((entry) => entry.name)).toContain(
        "@lib/util",
      );

      // A same-named file in an unrelated directory arrives alongside the real one: the alias
      // must only bind to the configured `lib/util.ts`.
      const utilLines = ["export function fn(): number {", "  return 1;", "}", ""];
      await fsp.mkdir(path.dirname(util), { recursive: true });
      await fsp.mkdir(path.dirname(otherUtil), { recursive: true });
      await fsp.writeFile(util, utilLines.join("\n"), "utf8");
      await fsp.writeFile(otherUtil, ["export function fn(): number {", "  return 999;", "}", ""].join("\n"), "utf8");

      const warm = await buildProjectIndexIncremental(root, DISK_BUILD);
      const targets = await expectWarmMatchesCold(root, main, warm);

      expect(targets).toContain(`file:${normalizePath(util)}`);
      expect(targets.some((target) => target.endsWith("/other/util.ts"))).toBe(false);
      expect(targets).not.toContain("external:@lib/util");

      const warmUnresolved = getUnresolvedImports(warm.graph, { projectRoot: root }).map((entry) => entry.name);
      expect(warmUnresolved).not.toContain("@lib/util");

      const gotoWarm = await goToDefinition(warm, { file: main, line: 3, column: columnOf(mainLines, 3, "fn(") });
      expect(gotoWarm.status).toBe("ok");
      if (gotoWarm.status !== "ok") throw new Error("expected goToDefinition to resolve after lib/util.ts was added");
      expect(normalizePath(gotoWarm.definition.file)).toBe(normalizePath(util));

      const refsWarm = await findReferences(warm, { file: util, line: 1, column: columnOf(utilLines, 1, "fn(") });
      expect(refsWarm.status).toBe("ok");
      if (refsWarm.status !== "ok") throw new Error("expected findReferences to resolve after lib/util.ts was added");
      expect(refsWarm.references.some((reference) => normalizePath(reference.file) === normalizePath(main))).toBe(true);
      expect(refsWarm.referenceCoverage.state).toBe("complete");

      const noChangeReport: BuildReport = { timings: {} };
      await buildProjectIndexIncremental(root, { ...DISK_BUILD, report: noChangeReport });
      expectNoReprocessedFiles(noChangeReport);

      await fsp.rm(util);
      await fsp.rm(otherUtil);
      const warmAfterDelete = await buildProjectIndexIncremental(root, DISK_BUILD);
      const targetsAfterDelete = await expectWarmMatchesCold(root, main, warmAfterDelete);
      expect(targetsAfterDelete).toEqual(["external:@lib/util"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a tsconfig alias whose second fallback target is the file that was added", async () => {
    const root = await mkTmpDir("cg-ts-alias-fallback-");
    try {
      await fsp.writeFile(
        path.join(root, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["missing/miss-*", "real/pre-*"] } } }),
        "utf8",
      );
      const main = path.join(root, "main.ts");
      const target = path.join(root, "real", "pre-foo.ts");
      await fsp.writeFile(
        main,
        ['import { fn } from "@lib/foo";', "export const run = (): number => fn();", ""].join("\n"),
        "utf8",
      );

      const initial = await buildProjectIndexIncremental(root, DISK_BUILD);
      expect(getUnresolvedImports(initial.graph, { projectRoot: root }).map((entry) => entry.name)).toContain(
        "@lib/foo",
      );

      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, "export function fn(): number {\n  return 1;\n}\n", "utf8");

      const warm = await buildProjectIndexIncremental(root, DISK_BUILD);
      const targets = await expectWarmMatchesCold(root, main, warm);
      expect(targets).toContain(`file:${normalizePath(target)}`);
      expect(targets).not.toContain("external:@lib/foo");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
  it.each([
    {
      scenario: "a tsconfig path fallback",
      specifier: "@lib/foo",
      initialRelativePath: "second/foo.ts",
      addedRelativePath: "first/foo.ts",
      tsconfig: JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["first/*", "second/*"] } },
      }),
    },
    {
      scenario: "a directory index import",
      specifier: "./foo",
      initialRelativePath: "foo/index.ts",
      addedRelativePath: "foo.ts",
      tsconfig: undefined,
    },
  ])("matches a cold build when $scenario is superseded by an added file", async (fixture) => {
    const root = await mkTmpDir("cg-added-supersedes-");
    try {
      if (fixture.tsconfig) await writeFixtureFile(root, "tsconfig.json", fixture.tsconfig);
      const main = path.join(root, "main.ts");
      const initialTarget = await writeFixtureFile(
        root,
        fixture.initialRelativePath,
        "export function selected(): number { return 2; }\n",
      );
      const preferredTarget = path.join(root, fixture.addedRelativePath);
      const mainLines = [
        `import { selected } from "${fixture.specifier}";`,
        "export function run(): number {",
        "  return selected();",
        "}",
        "",
      ];
      const targetLines = ["export function selected(): number {", "  return 1;", "}", ""];
      await fsp.writeFile(main, mainLines.join("\n"), "utf8");

      const initial = await buildProjectIndexIncremental(root, DISK_BUILD);
      expect(edgeTargets(initial, main)).toEqual([`file:${normalizePath(initialTarget)}`]);

      await fsp.mkdir(path.dirname(preferredTarget), { recursive: true });
      await fsp.writeFile(preferredTarget, targetLines.join("\n"), "utf8");
      const warm = await buildProjectIndexIncremental(root, DISK_BUILD);
      const targets = await expectWarmMatchesCold(root, main, warm);
      expect(targets).toEqual([`file:${normalizePath(preferredTarget)}`]);

      const goto = await goToDefinition(warm, { file: main, line: 3, column: columnOf(mainLines, 3, "selected(") });
      expect(goto.status).toBe("ok");
      if (goto.status !== "ok") throw new Error("expected goToDefinition to use the added higher-priority target");
      expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(preferredTarget));

      const refs = await findReferences(warm, {
        file: preferredTarget,
        line: 1,
        column: columnOf(targetLines, 1, "selected("),
      });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") throw new Error("expected findReferences to use the added higher-priority target");
      expect(refs.references.some((reference) => fileIdentityKey(reference.file) === fileIdentityKey(main))).toBe(true);
      expect(refs.referenceCoverage.state).toBe("complete");

      const detailed = await buildSymbolGraphDetailed(warm);
      const selectedNode = [...detailed.nodes.values()].find(
        (node) => node.file === normalizePath(preferredTarget) && node.name === "selected",
      );
      const runNode = [...detailed.nodes.values()].find(
        (node) => node.file === normalizePath(main) && node.name === "run",
      );
      expect(selectedNode).toBeTruthy();
      expect(runNode).toBeTruthy();
      expect(
        detailed.edges.some(
          (edge) => edge.label === "calls" && edge.from === runNode!.id && edge.to === selectedNode!.id,
        ),
      ).toBe(true);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves an extensionless import once its .d.ts declaration file is added", async () => {
    const root = await mkTmpDir("cg-dts-");
    try {
      const main = path.join(root, "main.ts");
      const target = path.join(root, "types", "shape.d.ts");
      await fsp.writeFile(
        main,
        [
          'import type { Shape } from "./types/shape";',
          "export const area = (shape: Shape): number => shape.w;",
          "",
        ].join("\n"),
        "utf8",
      );

      const initial = await buildProjectIndexIncremental(root, DISK_BUILD);
      expect(getUnresolvedImports(initial.graph, { projectRoot: root }).map((entry) => entry.name)).toContain(
        "./types/shape",
      );

      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, "export interface Shape {\n  w: number;\n}\n", "utf8");

      const warm = await buildProjectIndexIncremental(root, DISK_BUILD);
      const targets = await expectWarmMatchesCold(root, main, warm);
      expect(targets).toContain(`file:${normalizePath(target)}`);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it.each(ADDED_EXTERNAL_IMPORT_FIXTURES)(
    "matches a cold build when a $name external import starts resolving after its target is added",
    async (fixture) => {
      const root = await mkTmpDir(`cg-added-${fixture.name.toLowerCase()}-`);
      try {
        for (const initialFile of fixture.initialFiles) {
          await writeFixtureFile(root, initialFile.relativePath, initialFile.contents);
        }
        const consumer = await writeFixtureFile(root, fixture.consumerRelativePath, fixture.consumerLines.join("\n"));

        const initial = await buildProjectIndexIncremental(root, DISK_BUILD);
        expect(edgeTargets(initial, consumer).some((target) => target.startsWith("external:"))).toBe(true);

        const target = await writeFixtureFile(root, fixture.targetRelativePath, fixture.targetContents);
        const warm = await buildProjectIndexIncremental(root, DISK_BUILD);
        const cold = await buildProjectIndex(root, { cache: "off" });
        expect(importBindings(warm, consumer)).toEqual(importBindings(cold, consumer));

        const targetDefinition = await goToDefinition(warm, {
          file: consumer,
          line: fixture.queryLine,
          column: columnOf(fixture.consumerLines, fixture.queryLine, fixture.queryNeedle),
        });
        expect(targetDefinition.status).toBe("ok");
        if (targetDefinition.status !== "ok") {
          throw new Error(`expected ${fixture.name} goToDefinition to resolve after its target was added`);
        }
        expect(fileIdentityKey(targetDefinition.definition.file)).toBe(fileIdentityKey(target));
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("does not reparse a cached Go importer when an added file has a different directory and stem", async () => {
    const root = await mkTmpDir("cg-go-unrelated-add-");
    try {
      await writeFixtureFile(root, "go.mod", "module example.com/probe\n\ngo 1.22\n");
      const main = await writeFixtureFile(
        root,
        "main.go",
        ["package probe", 'import "example.com/probe/thing"', "func run() { thing.Value() }", ""].join("\n"),
      );
      const initial = await buildProjectIndexIncremental(root, DISK_BUILD);
      expect(edgeTargets(initial, main)).toContain("external:example.com/probe/thing");

      await writeFixtureFile(root, "other/decoy.go", "package other\nfunc Decoy() {}\n");
      const report: BuildReport = { timings: {} };
      const warm = await buildProjectIndexIncremental(root, { ...DISK_BUILD, report });

      expectNoReprocessedFiles(report, 1);
      expect(edgeTargets(warm, main)).toEqual(edgeTargets(initial, main));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("warm module-cache builds never reuse import bindings resolved against an older file set", () => {
  /** Import binding targets of a module as comparable strings. */
  function bindingTargets(index: ProjectIndex, file: string): string[] {
    const mod = index.byFile.get(fileIdentityKey(file));
    return (mod?.imports ?? [])
      .map((binding) =>
        typeof binding.resolved === "string"
          ? `file:${normalizePath(binding.resolved)}`
          : `external:${binding.resolved?.external ?? ""}`,
      )
      .sort();
  }

  for (const cache of ["disk", "memory"] as const) {
    it(`follows a moved and an added import target like a cold build (${cache} cache)`, async () => {
      const root = await mkTmpDir(`cg-module-cache-move-${cache}-`);
      try {
        const use = path.join(root, "use.ts");
        const useLines = ['import { x } from "./a";', 'import { z } from "./b";', "export const y = x() + z();", ""];
        await fsp.writeFile(path.join(root, "a.ts"), "export function x() { return 1; }\n", "utf8");
        await fsp.writeFile(use, useLines.join("\n"), "utf8");
        const initial = await buildProjectIndex(root, { cache });
        expect(bindingTargets(initial, use)).toEqual([
          "external:./b",
          `file:${normalizePath(path.join(root, "a.ts"))}`,
        ]);

        // Move a.ts to a/index.ts and add b.ts; use.ts itself does not change.
        await fsp.mkdir(path.join(root, "a"));
        await fsp.rename(path.join(root, "a.ts"), path.join(root, "a", "index.ts"));
        await fsp.writeFile(path.join(root, "b.ts"), "export function z() { return 3; }\n", "utf8");
        const warm = await buildProjectIndex(root, { cache });
        const cold = await buildProjectIndex(root, { cache: "off" });
        expect(bindingTargets(warm, use)).toEqual(bindingTargets(cold, use));
        expect(edgeTargets(warm, use)).toEqual(edgeTargets(cold, use));
        expect(bindingTargets(warm, use)).toEqual([
          `file:${normalizePath(path.join(root, "a", "index.ts"))}`,
          `file:${normalizePath(path.join(root, "b.ts"))}`,
        ]);
        const gotoWarm = await goToDefinition(warm, { file: use, line: 3, column: columnOf(useLines, 3, "x(") });
        expect(gotoWarm.status === "ok" ? normalizePath(gotoWarm.definition.file) : null).toBe(
          normalizePath(path.join(root, "a", "index.ts")),
        );

        // With nothing changed, the next warm build reuses every cached module.
        const report: BuildReport = { timings: {} };
        await buildProjectIndex(root, { cache, report });
        expect(report.files?.cached).toBe(report.files?.total);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  }

  it("follows a moved and an added import target with an explicit file list and no manifest (disk cache)", async () => {
    const root = await mkTmpDir("cg-module-cache-move-files-");
    const cacheDir = await mkTmpDir("cg-module-cache-move-files-cache-");
    try {
      const use = path.join(root, "use.ts");
      const useLines = ['import { x } from "./a";', 'import { z } from "./b";', "export const y = x() + z();", ""];
      await fsp.writeFile(path.join(root, "a.ts"), "export function x() { return 1; }\n", "utf8");
      await fsp.writeFile(use, useLines.join("\n"), "utf8");
      await buildProjectIndexFromFiles(root, [use, path.join(root, "a.ts")], { cache: "disk", cacheDir });

      await fsp.mkdir(path.join(root, "a"));
      await fsp.rename(path.join(root, "a.ts"), path.join(root, "a", "index.ts"));
      await fsp.writeFile(path.join(root, "b.ts"), "export function z() { return 3; }\n", "utf8");
      const files = [use, path.join(root, "a", "index.ts"), path.join(root, "b.ts")];
      const warm = await buildProjectIndexFromFiles(root, files, { cache: "disk", cacheDir });
      const cold = await buildProjectIndexFromFiles(root, files, { cache: "off" });
      expect(bindingTargets(warm, use)).toEqual(bindingTargets(cold, use));
      expect(bindingTargets(warm, use)).toEqual([
        `file:${normalizePath(path.join(root, "a", "index.ts"))}`,
        `file:${normalizePath(path.join(root, "b.ts"))}`,
      ]);

      const report: BuildReport = { timings: {} };
      await buildProjectIndexFromFiles(root, files, { cache: "disk", cacheDir, report });
      expect(report.files?.cached).toBe(report.files?.total);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.rm(cacheDir, { recursive: true, force: true });
    }
  });

  for (const cache of ["disk", "memory"] as const) {
    it(`re-answers a C# alias use when its base class gains or loses the member that hides the alias (${cache} cache)`, async () => {
      const root = await mkTmpDir(`cg-module-cache-inherited-alias-${cache}-`);
      try {
        const testCase = csharpInheritedAliasCase("inherited field declared in another file");
        const baseWithMember = testCase.files["Base.cs"]!;
        for (const [name, source] of Object.entries(testCase.files)) {
          await fsp.writeFile(path.join(root, name), name === "Base.cs" ? "class Base { }\n" : source, "utf8");
        }
        const use = path.join(root, "Use.cs");
        const column = columnOf(testCase.lines, testCase.line, "Run");
        const answer = async (index: ProjectIndex): Promise<string> => {
          const result = await goToDefinition(index, { file: use, line: testCase.line, column });
          return result.status === "ok" ? path.basename(result.definition.file) : result.status;
        };
        expect(await answer(await buildProjectIndex(root, { cache }))).toBe("N.cs");
        // Use.cs does not change; its base class now declares a field named like the alias.
        await fsp.writeFile(path.join(root, "Base.cs"), baseWithMember, "utf8");
        const hidden = await buildProjectIndex(root, { cache });
        expect(await answer(hidden)).toBe("Decoy.cs");
        expect(await answer(await buildProjectIndex(root, { cache: "off" }))).toBe("Decoy.cs");
        const graph = await buildSymbolGraphDetailed(hidden);
        const runCallFiles = graph.edges.flatMap((edge) => {
          const to = graph.nodes.get(edge.to);
          return edge.label === "calls" && to?.name === "Run" ? [path.basename(to.file)] : [];
        });
        expect(runCallFiles).toEqual(["Decoy.cs"]);
        // Removing the field restores the alias, as a cold build agrees.
        await fsp.writeFile(path.join(root, "Base.cs"), "class Base { }\n", "utf8");
        expect(await answer(await buildProjectIndex(root, { cache }))).toBe("N.cs");
        expect(await answer(await buildProjectIndex(root, { cache: "off" }))).toBe("N.cs");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  }

  it("rebinds a C# using directive when the only declaring file is renamed (disk cache)", async () => {
    const root = await mkTmpDir("cg-module-cache-csharp-rename-");
    try {
      const use = path.join(root, "Use.cs");
      const useLines = [
        "using P;",
        "namespace Q;",
        "public class Use {",
        "  public object B() => new Other();",
        "}",
        "",
      ];
      await fsp.writeFile(path.join(root, "Other.cs"), "namespace P;\npublic class Other { }\n", "utf8");
      await fsp.writeFile(use, useLines.join("\n"), "utf8");
      await buildProjectIndex(root, DISK_BUILD);
      await fsp.rename(path.join(root, "Other.cs"), path.join(root, "Moved.cs"));
      const warm = await buildProjectIndex(root, DISK_BUILD);
      const result = await goToDefinition(warm, { file: use, line: 4, column: columnOf(useLines, 4, "Other") });
      expect(result.status === "ok" ? path.basename(result.definition.file) : null).toBe("Moved.cs");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("rebinds a C# using directive when another file's namespace declaration changes (disk cache)", async () => {
    const root = await mkTmpDir("cg-module-cache-csharp-namespace-");
    try {
      const use = path.join(root, "Use.cs");
      const useLines = [
        "using P;",
        "namespace Q;",
        "public class Use {",
        "  public object B() => new Other();",
        "}",
        "",
      ];
      await fsp.writeFile(path.join(root, "Aaa.cs"), "namespace P;\npublic class Other { }\n", "utf8");
      await fsp.mkdir(path.join(root, "sub"));
      await fsp.writeFile(path.join(root, "sub", "Bbb.cs"), "namespace Z;\npublic class Other { }\n", "utf8");
      await fsp.writeFile(use, useLines.join("\n"), "utf8");
      await buildProjectIndex(root, DISK_BUILD);
      // Use.cs does not change; namespace P moves from Aaa.cs to sub/Bbb.cs in another directory.
      await fsp.writeFile(path.join(root, "Aaa.cs"), "namespace R;\npublic class Other { }\n", "utf8");
      await fsp.writeFile(path.join(root, "sub", "Bbb.cs"), "namespace P;\npublic class Other { }\n", "utf8");
      const warm = await buildProjectIndex(root, DISK_BUILD);
      const result = await goToDefinition(warm, { file: use, line: 4, column: columnOf(useLines, 4, "Other") });
      expect(result.status === "ok" ? path.basename(result.definition.file) : null).toBe("Bbb.cs");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("re-resolves a C# using directive when an existing file starts declaring its namespace (disk cache)", async () => {
    const root = await mkTmpDir("cg-module-cache-new-declaration-");
    try {
      const use = path.join(root, "Use.cs");
      const mix = path.join(root, "b", "Mix.cs");
      const useLines = ["using N;", "namespace Q;", "public class Use {", "  public object B() => new Mix();", "}", ""];
      await fsp.mkdir(path.join(root, "a"));
      await fsp.mkdir(path.dirname(mix));
      await fsp.writeFile(path.join(root, "a", "First.cs"), "namespace N;\npublic class First { }\n", "utf8");
      await fsp.writeFile(mix, "namespace Other;\npublic class Mix { }\n", "utf8");
      await fsp.writeFile(use, useLines.join("\n"), "utf8");
      const initial = await buildProjectIndex(root, DISK_BUILD);
      const before = await goToDefinition(initial, { file: use, line: 4, column: columnOf(useLines, 4, "Mix") });
      expect(before.status).toBe("not_found");
      // Use.cs does not change; b/Mix.cs now declares namespace N.
      await fsp.writeFile(mix, "namespace N;\npublic class Mix { }\n", "utf8");
      const warm = await buildProjectIndex(root, DISK_BUILD);
      const result = await goToDefinition(warm, { file: use, line: 4, column: columnOf(useLines, 4, "Mix") });
      expect(result.status === "ok" ? path.basename(result.definition.file) : null).toBe("Mix.cs");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a C++ module import from the survivor when one duplicate declaration is deleted (disk cache)", async () => {
    const root = await mkTmpDir("cg-module-cache-cpp-dupe-");
    try {
      await fsp.writeFile(path.join(root, "alpha.cpp"), "export module shared;\n", "utf8");
      await fsp.writeFile(path.join(root, "beta.cpp"), "export module shared;\n", "utf8");
      await fsp.writeFile(path.join(root, "main.cpp"), "import shared;\n", "utf8");
      await buildProjectIndex(root, DISK_BUILD);
      await fsp.rm(path.join(root, "beta.cpp"));
      const warm = await buildProjectIndex(root, DISK_BUILD);
      const cold = await buildProjectIndex(root, { cache: "off" });
      expect(edgeTargets(warm, path.join(root, "main.cpp"))).toEqual(edgeTargets(cold, path.join(root, "main.cpp")));
      expect(edgeTargets(warm, path.join(root, "main.cpp")).some((target) => target.endsWith("/alpha.cpp"))).toBe(true);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  // The stem of the added file (`beta`) never matches the module name (`shared`).
  // Only the declared-container comparison sees the new declaration.
  // Disk covers the manifest path. Memory covers the no-manifest path.
  for (const cache of ["disk", "memory"] as const) {
    it(`returns a C++ module import to unresolved when a second declaration makes it ambiguous (${cache} cache)`, async () => {
      const root = await mkTmpDir(`cg-module-cache-cpp-ambiguous-${cache}-`);
      try {
        const main = path.join(root, "main.cpp");
        await fsp.writeFile(path.join(root, "alpha.cpp"), "export module shared;\n", "utf8");
        await fsp.writeFile(main, "import shared;\n", "utf8");
        const resolved = await buildProjectIndex(root, { cache });
        expect(edgeTargets(resolved, main).some((target) => target.endsWith("/alpha.cpp"))).toBe(true);

        await fsp.writeFile(path.join(root, "beta.cpp"), "export module shared;\n", "utf8");
        const warm = await buildProjectIndex(root, { cache });
        const targets = await expectWarmMatchesCold(root, main, warm);
        expect(targets).toEqual(["external:shared"]);
        // The cached module's own bindings must agree with the graph, not just its edges.
        const cold = await buildProjectIndex(root, { cache: "off" });
        expect(bindingTargets(warm, main)).toEqual(bindingTargets(cold, main));
        expect(bindingTargets(warm, main)).toEqual(["external:shared"]);

        // With nothing changed, the next warm build reuses every cached module.
        const report: BuildReport = { timings: {} };
        await buildProjectIndex(root, { cache, report });
        expect(report.files?.cached).toBe(report.files?.total);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  }

  // The import names the declaration (`p.Widget`), not the filename (`Helpers`).
  // Only the extension rule for declaration languages triggers re-resolution.
  for (const cache of ["disk", "memory"] as const) {
    it(`resolves a declaration-named import added under an unrelated filename (${cache} cache)`, async () => {
      const root = await mkTmpDir(`cg-module-cache-decl-name-${cache}-`);
      try {
        const main = path.join(root, "p", "Main.kt");
        const mainLines = ["package p", "import p.Widget", "fun use(w: Widget): Widget = w", ""];
        await writeFixtureFile(root, `p/Main.kt`, mainLines.join(`\n`));
        const unresolved = await buildProjectIndex(root, { cache });
        expect(bindingTargets(unresolved, main)).toEqual(["external:p.Widget"]);

        await writeFixtureFile(root, "p/Helpers.kt", "package p\nclass Widget\n");
        const warm = await buildProjectIndex(root, { cache });
        const targets = await expectWarmMatchesCold(root, main, warm);
        expect(targets).toEqual(["file:" + normalizePath(path.join(root, "p", "Helpers.kt"))]);
        expect(bindingTargets(warm, main)).toEqual(["file:" + normalizePath(path.join(root, "p", "Helpers.kt"))]);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  }

  // Without a manifest, a deleted declarer leaves no cache miss.
  // A rewritten declarer does not show what it declared.
  // Surviving rows and stale rows supply both.
  it("resolves a C++ module import from the survivor when one duplicate declaration is deleted (memory cache)", async () => {
    const root = await mkTmpDir("cg-module-cache-cpp-dupe-memory-");
    try {
      await fsp.writeFile(path.join(root, "alpha.cpp"), "export module shared;\n", "utf8");
      await fsp.writeFile(path.join(root, "beta.cpp"), "export module shared;\n", "utf8");
      const main = path.join(root, "main.cpp");
      await fsp.writeFile(main, "import shared;\n", "utf8");
      const ambiguous = await buildProjectIndex(root, { cache: "memory" });
      expect(bindingTargets(ambiguous, main)).toEqual(["external:shared"]);

      await fsp.rm(path.join(root, "beta.cpp"));
      const warm = await buildProjectIndex(root, { cache: "memory" });
      const targets = await expectWarmMatchesCold(root, main, warm);
      expect(targets).toEqual(["file:" + normalizePath(path.join(root, "alpha.cpp"))]);
      const cold = await buildProjectIndex(root, { cache: "off" });
      expect(bindingTargets(warm, main)).toEqual(bindingTargets(cold, main));
      expect(bindingTargets(warm, main).length).toBeGreaterThan(0);
      for (const target of bindingTargets(warm, main)) {
        expect(target).toBe("file:" + normalizePath(path.join(root, "alpha.cpp")));
      }
      // The rebuild retired the deletion, so the next build reuses every module.
      const report: BuildReport = { timings: {} };
      await buildProjectIndex(root, { cache: "memory", report });
      expect(report.files?.cached).toBe(report.files?.total);
      expect(report.cache).toMatchObject({ mode: "memory", misses: 0 });
      expect(report.cache?.hits).toBe(report.files?.total);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a C++ module import from the survivor when a duplicate declaration is rewritten (memory cache)", async () => {
    const root = await mkTmpDir("cg-module-cache-cpp-rewrite-memory-");
    try {
      await fsp.writeFile(path.join(root, "alpha.cpp"), "export module shared;\n", "utf8");
      await fsp.writeFile(path.join(root, "beta.cpp"), "export module shared;\n", "utf8");
      const main = path.join(root, "main.cpp");
      await fsp.writeFile(main, "import shared;\n", "utf8");
      const ambiguous = await buildProjectIndex(root, { cache: "memory" });
      expect(bindingTargets(ambiguous, main)).toEqual(["external:shared"]);

      await fsp.writeFile(path.join(root, "beta.cpp"), "export module other;\n", "utf8");
      const warm = await buildProjectIndex(root, { cache: "memory" });
      const targets = await expectWarmMatchesCold(root, main, warm);
      expect(targets).toEqual(["file:" + normalizePath(path.join(root, "alpha.cpp"))]);
      const cold = await buildProjectIndex(root, { cache: "off" });
      expect(bindingTargets(warm, main)).toEqual(bindingTargets(cold, main));
      expect(bindingTargets(warm, main).length).toBeGreaterThan(0);
      for (const target of bindingTargets(warm, main)) {
        expect(target).toBe("file:" + normalizePath(path.join(root, "alpha.cpp")));
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  // Two files declare `P`, so the alias binding has no `resolved` target.
  // The importer must still count as unresolved.
  it("binds a C# namespace alias to the survivor when a duplicate declaration is deleted (memory cache)", async () => {
    const root = await mkTmpDir("cg-module-cache-csharp-alias-memory-");
    try {
      await fsp.writeFile(path.join(root, "Aaa.cs"), "namespace P;\npublic class Aaa {}\n", "utf8");
      await fsp.writeFile(path.join(root, "Bbb.cs"), "namespace P;\npublic class Bbb {}\n", "utf8");
      const main = path.join(root, "Use.cs");
      await fsp.writeFile(main, "using X = P;\nclass Use {\n  X.Aaa Make() => new X.Aaa();\n}\n", "utf8");
      const ambiguous = await buildProjectIndex(root, { cache: "memory" });
      expect(bindingTargets(ambiguous, main)).toEqual(["external:"]);

      await fsp.rm(path.join(root, "Bbb.cs"));
      const warm = await buildProjectIndex(root, { cache: "memory" });
      const cold = await buildProjectIndex(root, { cache: "off" });
      expect(bindingTargets(warm, main)).toEqual(bindingTargets(cold, main));
      expect(bindingTargets(warm, main)).toEqual(["file:" + normalizePath(path.join(root, "Aaa.cs"))]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  // The memory cache holds 5,000 payloads. After the payload of `alpha.cpp` is evicted,
  // its rewrite is not a cache hit and not a stale row, so its old declaration is unknown.
  // The importer must re-resolve.
  it("re-resolves a C++ importer when the declarer's evicted payload was rewritten (memory cache)", async () => {
    const root = await mkTmpDir("cg-module-cache-cpp-evicted-");
    try {
      const alpha = path.join(root, "alpha.cpp");
      const main = path.join(root, "main.cpp");
      await fsp.writeFile(alpha, "export module shared;\n", "utf8");
      await fsp.writeFile(main, "import shared;\n", "utf8");
      const first = await buildProjectIndex(root, { cache: "memory" });
      expect([...new Set(bindingTargets(first, main))]).toEqual(["file:" + normalizePath(alpha)]);

      // Touch main so it is the newest row, then fill the cache so exactly alpha is evicted.
      const cacheKeyOf = (file: string): string => normalizePath(file);
      const mainRow = peekCachedModule(root, cacheKeyOf(main), { cache: "memory" });
      expect(mainRow).not.toBeNull();
      expect(tryLoadFromCache(root, cacheKeyOf(main), mainRow!.sig, { cache: "memory" })).not.toBeNull();
      for (let i = 0; i < 4999; i += 1) {
        const filler = "/filler/f-" + i + ".ts";
        writeToCache(root, filler, "sig", { file: filler, exports: [], imports: [], locals: [] }, { cache: "memory" });
      }
      expect(peekCachedModule(root, cacheKeyOf(alpha), { cache: "memory" })).toBeNull();
      expect(peekCachedModule(root, cacheKeyOf(main), { cache: "memory" })).not.toBeNull();

      await fsp.writeFile(alpha, "export module other;\n", "utf8");
      const warm = await buildProjectIndex(root, { cache: "memory" });
      const cold = await buildProjectIndex(root, { cache: "off" });
      expect(bindingTargets(warm, main)).toEqual(bindingTargets(cold, main));
      expect([...new Set(bindingTargets(warm, main))]).toEqual(["external:shared"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  // The old row of a changed file cannot be decoded, so its previous declaration is unknown.
  // Without a manifest, nothing else invalidates the importer.
  it("re-resolves a C++ importer when a rewritten declarer's old row is undecodable (disk cache, no manifest)", async () => {
    const root = await mkTmpDir("cg-module-cache-cpp-corrupt-");
    const cacheDir = await mkTmpDir("cg-module-cache-cpp-corrupt-cache-");
    const opts = { cache: "disk" as const, cacheDir };
    try {
      const alpha = path.join(root, "alpha.cpp");
      const beta = path.join(root, "beta.cpp");
      const main = path.join(root, "main.cpp");
      await fsp.writeFile(alpha, "export module shared;\n", "utf8");
      await fsp.writeFile(beta, "export module shared;\n", "utf8");
      await fsp.writeFile(main, "import shared;\n", "utf8");
      const files = [alpha, beta, main];
      const ambiguous = await buildProjectIndexFromFiles(root, files, opts);
      expect(bindingTargets(ambiguous, main)).toEqual(["external:shared"]);

      closeDiskCacheDatabase(root, opts);
      const db = new DatabaseSync(cacheDatabasePath(root, opts, "index-cache.sqlite"));
      try {
        const updated = db
          .prepare("UPDATE module_cache SET payload = ? WHERE file = ?")
          .run(Buffer.from("not a module payload"), cacheRelativePath(root, beta));
        expect(Number(updated.changes)).toBe(1);
      } finally {
        db.close();
      }

      await fsp.writeFile(beta, "export module other;\n", "utf8");
      const warm = await buildProjectIndexFromFiles(root, files, opts);
      const cold = await buildProjectIndexFromFiles(root, files, { cache: "off" });
      expect(bindingTargets(warm, main)).toEqual(bindingTargets(cold, main));
      expect([...new Set(bindingTargets(warm, main))]).toEqual(["file:" + normalizePath(alpha)]);
    } finally {
      closeDiskCacheDatabase(root, opts);
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.rm(cacheDir, { recursive: true, force: true });
    }
  });

  // The LRU is shared by all projects, so another project can evict these rows.
  // After a complete build restores them, unchanged builds must reuse every module.
  it("reuses every module again after a complete build restores rows another project evicted (memory cache)", async () => {
    const root = await mkTmpDir("cg-module-cache-cpp-restored-");
    const other = await mkTmpDir("cg-module-cache-cpp-restored-other-");
    try {
      const main = path.join(root, "main.cpp");
      await fsp.writeFile(path.join(root, "alpha.cpp"), "export module shared;\n", "utf8");
      await fsp.writeFile(main, "import shared;\n", "utf8");
      await buildProjectIndex(root, { cache: "memory" });
      for (let i = 0; i < 5000; i += 1) {
        const filler = "/filler/f-" + i + ".ts";
        writeToCache(other, filler, "sig", { file: filler, exports: [], imports: [], locals: [] }, { cache: "memory" });
      }
      expect(memoryCacheLostPayloads(root)).toBe(true);

      const rebuilt = await buildProjectIndex(root, { cache: "memory" });
      expect([...new Set(bindingTargets(rebuilt, main))]).toEqual([
        "file:" + normalizePath(path.join(root, "alpha.cpp")),
      ]);
      expect(memoryCacheLostPayloads(root)).toBe(false);

      const report: BuildReport = { timings: {} };
      await buildProjectIndex(root, { cache: "memory", report });
      expect(report.files?.cached).toBe(report.files?.total);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.rm(other, { recursive: true, force: true });
    }
  });

  // `from . import mod` already targets `__init__.py`.
  // Without a manifest, only the cached bindings identify the importer.
  it("re-resolves a relative Python from-import once the submodule is added (memory cache)", async () => {
    const root = await mkTmpDir("cg-module-cache-py-relative-memory-");
    try {
      const user = path.join(root, "pkg", "user.py");
      await fsp.mkdir(path.join(root, "pkg"), { recursive: true });
      await fsp.writeFile(path.join(root, "pkg", "__init__.py"), "", "utf8");
      await fsp.writeFile(user, "from . import mod\n\ndef use():\n    return mod.value()\n", "utf8");
      const before = await buildProjectIndex(root, { cache: "memory" });
      const initInitial = normalizePath(path.join(root, "pkg", "__init__.py"));
      expect(bindingTargets(before, user)).toEqual(["file:" + initInitial]);

      const submodule = path.join(root, "pkg", "mod.py");
      await fsp.writeFile(submodule, "def value():\n    return 1\n", "utf8");
      const warm = await buildProjectIndex(root, { cache: "memory" });
      const cold = await buildProjectIndex(root, { cache: "off" });
      expect(bindingTargets(warm, user)).toEqual(bindingTargets(cold, user));
      expect(bindingTargets(warm, user)).toEqual(["file:" + normalizePath(submodule)]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  // A build over a file list omits `main.cpp`, so it must not consume the deletion of `beta.cpp`.
  // The later build that includes `main.cpp` still needs it.
  it("keeps a deleted declarer's evidence when a scoped build omits its importers (memory cache)", async () => {
    const root = await mkTmpDir("cg-module-cache-cpp-scoped-retire-");
    try {
      const alpha = path.join(root, "alpha.cpp");
      const beta = path.join(root, "beta.cpp");
      const main = path.join(root, "main.cpp");
      const unrelated = path.join(root, "unrelated.ts");
      await fsp.writeFile(alpha, "export module shared;\n", "utf8");
      await fsp.writeFile(beta, "export module shared;\n", "utf8");
      await fsp.writeFile(main, "import shared;\n", "utf8");
      await fsp.writeFile(unrelated, "export const value = 1;\n", "utf8");
      const memory = { cache: "memory" as const };
      const initial = await buildProjectIndexFromFiles(root, [alpha, beta, main, unrelated], memory);
      expect(bindingTargets(initial, main)).toEqual(["external:shared"]);

      await fsp.rm(beta);
      await buildProjectIndexFromFiles(root, [unrelated], memory);
      const scoped = [alpha, main];
      const warm = await buildProjectIndexFromFiles(root, scoped, memory);
      const cold = await buildProjectIndexFromFiles(root, scoped, { cache: "off" });
      expect(bindingTargets(warm, main)).toEqual(bindingTargets(cold, main));
      expect([...new Set(bindingTargets(warm, main))]).toEqual(["file:" + normalizePath(alpha)]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  // An unmapped `.h` file is C or C++ by its content. A header that imports a C++ module
  // must re-resolve like a `.cpp` importer.
  it("re-resolves a C++ header importer when a rewritten declarer's old row is undecodable (disk cache, no manifest)", async () => {
    const root = await mkTmpDir("cg-module-cache-cpp-header-");
    const cacheDir = await mkTmpDir("cg-module-cache-cpp-header-cache-");
    const opts = { cache: "disk" as const, cacheDir };
    try {
      const alpha = path.join(root, "alpha.cpp");
      const beta = path.join(root, "beta.cpp");
      const header = path.join(root, "user.h");
      await fsp.writeFile(alpha, "export module shared;\n", "utf8");
      await fsp.writeFile(beta, "export module shared;\n", "utf8");
      await fsp.writeFile(header, "import shared;\n", "utf8");
      const files = [alpha, beta, header];
      const ambiguous = await buildProjectIndexFromFiles(root, files, opts);
      expect(bindingTargets(ambiguous, header)).toEqual(["external:shared"]);

      closeDiskCacheDatabase(root, opts);
      const db = new DatabaseSync(cacheDatabasePath(root, opts, "index-cache.sqlite"));
      try {
        db.prepare("UPDATE module_cache SET payload = ? WHERE file = ?").run(
          Buffer.from("not a module payload"),
          cacheRelativePath(root, beta),
        );
      } finally {
        db.close();
      }

      await fsp.writeFile(beta, "export module other;\n", "utf8");
      const warm = await buildProjectIndexFromFiles(root, files, opts);
      const cold = await buildProjectIndexFromFiles(root, files, { cache: "off" });
      expect(bindingTargets(warm, header)).toEqual(bindingTargets(cold, header));
      expect([...new Set(bindingTargets(warm, header))]).toEqual(["file:" + normalizePath(alpha)]);
    } finally {
      closeDiskCacheDatabase(root, opts);
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.rm(cacheDir, { recursive: true, force: true });
    }
  });

  // Two files declare `N.Point`, so the alias stays external. Deleting one leaves no edge to it
  // and no declared-container entry (only C++ records those), so only the deletion itself can
  // trigger re-resolution.
  it("resolves an ambiguous C# alias from the survivor when one declarer is deleted (disk cache)", async () => {
    const root = await mkTmpDir("cg-module-cache-csharp-alias-delete-");
    try {
      const first = path.join(root, "a", "First.cs");
      const second = path.join(root, "b", "Second.cs");
      const use = path.join(root, "Use.cs");
      await fsp.mkdir(path.dirname(first));
      await fsp.mkdir(path.dirname(second));
      await fsp.writeFile(first, "namespace N;\npublic class Point { public static int Left() => 1; }\n", "utf8");
      await fsp.writeFile(second, "namespace N;\npublic class Point { public static int Left() => 2; }\n", "utf8");
      await fsp.writeFile(use, "using PT = N.Point;\nclass Use {\n  int M() => PT.Left();\n}\n", "utf8");
      const ambiguous = await buildProjectIndex(root, DISK_BUILD);
      expect(bindingTargets(ambiguous, use).every((target) => target.startsWith("external:"))).toBe(true);

      await fsp.rm(second);
      const warm = await buildProjectIndex(root, DISK_BUILD);
      const cold = await buildProjectIndex(root, { cache: "off" });
      expect(bindingTargets(warm, use)).toEqual(bindingTargets(cold, use));
      expect(bindingTargets(warm, use)).toEqual(["file:" + normalizePath(first)]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  // A cache row is persisted data. A row that names a path outside the project must not be
  // probed as a deleted declaration file, which would re-resolve every C# importer.
  it("ignores a cache row that names a path outside the project (disk cache, no manifest)", async () => {
    const root = await mkTmpDir("cg-module-cache-outside-row-");
    const cacheDir = await mkTmpDir("cg-module-cache-outside-row-cache-");
    const opts = { cache: "disk" as const, cacheDir };
    try {
      const use = path.join(root, "Use.cs");
      await fsp.writeFile(use, "using Missing.Namespace;\nclass Use {}\n", "utf8");
      const first = await buildProjectIndexFromFiles(root, [use], opts);
      expect(bindingTargets(first, use).every((target) => target.startsWith("external:"))).toBe(true);

      closeDiskCacheDatabase(root, opts);
      const db = new DatabaseSync(cacheDatabasePath(root, opts, "index-cache.sqlite"));
      try {
        const current = db.prepare("SELECT version FROM module_cache LIMIT 1").get() as { version: number };
        db.prepare("INSERT INTO module_cache(file, sig, version, payload, updated_at) VALUES (?, ?, ?, ?, ?)").run(
          "../outside/Gone.cs",
          "sig",
          current.version,
          Buffer.from("payload"),
          Date.now(),
        );
      } finally {
        db.close();
      }

      const report: BuildReport = { timings: {} };
      await buildProjectIndexFromFiles(root, [use], { ...opts, report });
      expect(report.files?.cached).toBe(report.files?.total);
    } finally {
      closeDiskCacheDatabase(root, opts);
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.rm(cacheDir, { recursive: true, force: true });
    }
  });

  // The deleted declarer's row is undecodable, so its declarations are unknown. A header that
  // imports the module is C++ by its content and must still re-resolve.
  it("re-resolves a C++ header importer when a deleted declarer's row is undecodable (disk cache, no manifest)", async () => {
    const root = await mkTmpDir("cg-module-cache-cpp-header-deleted-");
    const cacheDir = await mkTmpDir("cg-module-cache-cpp-header-deleted-cache-");
    const opts = { cache: "disk" as const, cacheDir };
    try {
      const alpha = path.join(root, "alpha.cpp");
      const beta = path.join(root, "beta.cpp");
      const header = path.join(root, "user.h");
      await fsp.writeFile(alpha, "export module shared;\n", "utf8");
      await fsp.writeFile(beta, "export module shared;\n", "utf8");
      await fsp.writeFile(header, "import shared;\n", "utf8");
      const ambiguous = await buildProjectIndexFromFiles(root, [alpha, beta, header], opts);
      expect(bindingTargets(ambiguous, header)).toEqual(["external:shared"]);

      closeDiskCacheDatabase(root, opts);
      const db = new DatabaseSync(cacheDatabasePath(root, opts, "index-cache.sqlite"));
      try {
        db.prepare("UPDATE module_cache SET payload = ? WHERE file = ?").run(
          Buffer.from("not a module payload"),
          cacheRelativePath(root, beta),
        );
      } finally {
        db.close();
      }

      await fsp.rm(beta);
      const files = [alpha, header];
      const warm = await buildProjectIndexFromFiles(root, files, opts);
      const cold = await buildProjectIndexFromFiles(root, files, { cache: "off" });
      expect(bindingTargets(warm, header)).toEqual(bindingTargets(cold, header));
      expect([...new Set(bindingTargets(warm, header))]).toEqual(["file:" + normalizePath(alpha)]);
    } finally {
      closeDiskCacheDatabase(root, opts);
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.rm(cacheDir, { recursive: true, force: true });
    }
  });
});

describe("mixed JVM wildcard cache invalidation", () => {
  const fixtures = [
    {
      importer: "Java",
      existing: { path: "java/p/Mode.java", source: "package p; public enum Mode { FAST }" },
      added: { path: "kotlin/p/Widget.kt", source: "package p\nclass Widget\n" },
      consumer: "java/client/Use.java",
      lines: ["package client;", "import p.*;", "class Use { Widget widget; Mode mode; }"],
      queryLine: 3,
      queryName: "Widget",
    },
    {
      importer: "Kotlin",
      existing: { path: "kotlin/p/Widget.kt", source: "package p\nclass Widget\n" },
      added: { path: "java/p/Mode.java", source: "package p; public enum Mode { FAST }" },
      consumer: "kotlin/app/Use.kt",
      lines: ["package app", "import p.*", "fun choose(): Mode = Mode.FAST", "fun create(): Widget = Widget()"],
      queryLine: 3,
      queryName: "Mode",
    },
  ] as const;
  for (const fixture of fixtures) {
    for (const cache of ["disk", "memory"] as const) {
      it(`rebinds ${fixture.importer} package imports after adding a file in the other JVM language (${cache} cache)`, async () => {
        const root = await mkTmpDir("cg-cross-jvm-");
        try {
          const existing = await writeFixtureFile(root, fixture.existing.path, fixture.existing.source);
          const consumer = await writeFixtureFile(root, fixture.consumer, fixture.lines.join("\n"));
          const query = {
            file: consumer,
            line: fixture.queryLine,
            column: columnOf(fixture.lines, fixture.queryLine, fixture.queryName),
          };
          const initial = await buildProjectIndex(root, { cache });
          const before = await goToDefinition(initial, query);
          expect(before.status).toBe("not_found");
          expect(edgeTargets(initial, consumer)).toContain("file:" + normalizePath(existing));

          const added = await writeFixtureFile(root, fixture.added.path, fixture.added.source);
          const warm = await buildProjectIndex(root, { cache });
          const targets = await expectWarmMatchesCold(root, consumer, warm);
          expect(targets).toContain("file:" + normalizePath(existing));
          expect(targets).toContain("file:" + normalizePath(added));
          const after = await goToDefinition(warm, query);
          expect(after.status).toBe("ok");
          if (after.status === "ok") expect(after.definition.file).toBe(normalizePath(added));
        } finally {
          await fsp.rm(root, { recursive: true, force: true });
        }
      });
    }
  }
});

describe("changed declaration files restore unresolved cached imports", () => {
  for (const cache of ["disk", "memory"] as const) {
    it.each(RESTORED_DECLARATION_FIXTURES)(
      `restores $languageId imports after a declaration returns (${cache})`,
      async (fixture) => {
        await withRestoredDeclarationImport(fixture, cache, async (project) => {
          const { owner, consumer, unrelated, decoy, initial, missing, missingCold, restored, cold, report } = project;
          const expected = [`file:${fileIdentityKey(owner)}`];
          expect(declarationImportTargets(initial, consumer)).toEqual(expected);
          expect(declarationImportTargets(missing, consumer)).toEqual([`external:${fixture.specifier}`]);
          expect(declarationImportTargets(missing, consumer)).toEqual(declarationImportTargets(missingCold, consumer));
          expect(declarationImportTargets(restored, consumer)).toEqual(expected);
          expect(declarationImportTargets(restored, consumer)).toEqual(declarationImportTargets(cold, consumer));
          expect(declarationImportTargets(restored, consumer)).not.toContain(`file:${fileIdentityKey(decoy)}`);
          expect(declarationImportTargets(restored, unrelated)).toEqual(declarationImportTargets(initial, unrelated));
          expect(
            restored.byFile
              .get(fileIdentityKey(consumer))
              ?.imports.some(
                (binding) =>
                  typeof binding.resolved === "string" && fileIdentityKey(binding.resolved) === fileIdentityKey(owner),
              ),
          ).toBe(true);
          if (cache === "disk") {
            // Only the edited declarer and the importer it restores are extracted. The same-named
            // decoy and a second unresolved importer stay cached throughout both transitions.
            expect(project.missingReport.files).toMatchObject({ parsed: 2, changed: 2, cached: 2 });
            expect(report.files).toMatchObject({ parsed: 2, changed: 2, cached: 2 });
            const unchangedReport: BuildReport = { timings: {} };
            const reopened = await buildProjectIndexIncremental(project.root, {
              cache,
              threads: 1,
              report: unchangedReport,
            });
            expect(declarationImportTargets(reopened, consumer)).toEqual(expected);
            expectNoReprocessedFiles(unchangedReport);
          }
        });
      },
    );
  }
});

describe("graph deltas restore declaration import bindings", () => {
  it.each(RESTORED_DECLARATION_FIXTURES)(
    "updates cached $languageId importer bindings through buildGraphDelta",
    async (fixture) => {
      await withRestoredDeclarationImport(
        fixture,
        "disk",
        async (project) => {
          expect(project.delta?.changedFiles).toContain(`lib/${fixture.ownerName}.${fixture.extension}`);
          expect(declarationImportTargets(project.restored, project.consumer)).toEqual(
            declarationImportTargets(project.cold, project.consumer),
          );
          expect((await goToDefinition(project.restored, project.query)).status).toBe("ok");
        },
        true,
      );
    },
  );
});

describe("PHP path-fallback cache parity", () => {
  for (const cache of ["disk", "memory"] as const) {
    for (const mapping of PHP_PATH_MAPPINGS) {
      it.each(PHP_PATH_IMPORT_FORMS.filter((form) => form.name === form.role))(
        `drops and restores the $name declaration behind a ${mapping} path (${cache})`,
        async (form) => {
          const root = await mkTmpDir("cg-php-path-cache-");
          try {
            const fixture = phpPathFallbackFixture(mapping, form, true);
            const files = await writeFixtureFiles(root, fixture.files);
            const owner = files[fixture.owner]!;
            const consumer = files["Use.php"]!;
            const options = { cache, threads: 1 };
            const initial = await buildProjectIndex(root, options);
            const expectedFile = [`file:${normalizePath(owner)}`];
            expect(edgeTargets(initial, consumer)).toEqual(expectedFile);

            for (const [source, expected] of [
              [fixture.missingSource, ["external:App\\Gadget"]],
              [fixture.ownerSource, expectedFile],
              [fixture.wrongKindSource, ["external:App\\Gadget"]],
              [fixture.ownerSource, expectedFile],
            ] as const) {
              await fsp.writeFile(owner, source, "utf8");
              if (cache === "disk") clearMemoryCache();
              const report: BuildReport = { timings: {} };
              const warm = await buildProjectIndexIncremental(root, { ...options, report });
              const cold = await buildProjectIndex(root, { cache: "off", threads: 1 });
              expect(edgeTargets(warm, consumer)).toEqual(expected);
              expect(edgeTargets(warm, consumer)).toEqual(edgeTargets(cold, consumer));
              expect(importBindings(warm, consumer)).toEqual(importBindings(cold, consumer));
              expect(edgeTargets(warm, consumer)).not.toContain(`file:${normalizePath(files["Decoy.php"]!)}`);
              const query = { file: consumer, line: 4, column: columnOf(fixture.lines, 4, "Gadget") };
              expect(await goToDefinition(warm, query)).toEqual(await goToDefinition(cold, query));
              expect((await goToDefinition(warm, query)).status).toBe(
                source === fixture.ownerSource ? "ok" : "not_found",
              );

              const unchangedReport: BuildReport = { timings: {} };
              const unchanged = await buildProjectIndexIncremental(root, { ...options, report: unchangedReport });
              expect(edgeTargets(unchanged, consumer)).toEqual(expected);
              if (cache === "disk") expectNoReprocessedFiles(unchangedReport);
            }
          } finally {
            await fsp.rm(root, { recursive: true, force: true });
          }
        },
      );
    }
  }
});

describe("PHP incomplete declaration cache parity", () => {
  for (const cache of ["disk", "memory"] as const) {
    for (const mapping of PHP_PATH_MAPPINGS) {
      for (const form of PHP_PATH_IMPORT_FORMS.filter((entry) => entry.name === entry.role)) {
        it(`matches cold ${form.role} resolution through incomplete candidates (${mapping}, ${cache})`, async () => {
          const root = await mkTmpDir("cg-php-incomplete-cache-");
          try {
            const fixture = phpPathFallbackFixture(mapping, form);
            const files = await writeFixtureFiles(root, { ...fixture.files, [fixture.owner]: fixture.missingSource });
            const owner = files[fixture.owner]!;
            const consumer = files["Use.php"]!;
            const hasPathFallback = mapping === "plain" || form.role === "class";
            const uncertainTargets = hasPathFallback ? [`file:${normalizePath(owner)}`] : ["external:App\\Gadget"];
            const options = { cache, threads: 1 };
            const initial = await buildProjectIndex(root, options);
            expect(edgeTargets(initial, consumer)).toEqual(["external:App\\Gadget"]);
            for (const { source } of PHP_INCOMPLETE_DECLARATION_SOURCES) {
              await fsp.writeFile(owner, source, "utf8");
              if (cache === "disk") clearMemoryCache();
              const uncertain = await buildProjectIndexIncremental(root, options);
              const cold = await buildProjectIndex(root, { cache: "off", threads: 1 });
              expect(edgeTargets(uncertain, consumer)).toEqual(uncertainTargets);
              expect(edgeTargets(uncertain, consumer)).toEqual(edgeTargets(cold, consumer));
              expect(importBindings(uncertain, consumer)).toEqual(importBindings(cold, consumer));
              expect(edgeTargets(uncertain, consumer)).not.toContain(`file:${normalizePath(files["Decoy.php"]!)}`);
              if (cache === "disk") clearMemoryCache();
              const unchanged = await buildProjectIndexIncremental(root, options);
              expect(edgeTargets(unchanged, consumer)).toEqual(uncertainTargets);

              await fsp.writeFile(owner, fixture.missingSource, "utf8");
              const repaired = await buildProjectIndexIncremental(root, options);
              expect(edgeTargets(repaired, consumer)).toEqual(["external:App\\Gadget"]);
            }
            await fsp.writeFile(owner, fixture.ownerSource, "utf8");
            const restored = await buildProjectIndexIncremental(root, options);
            expect(edgeTargets(restored, consumer)).toEqual([`file:${normalizePath(owner)}`]);
          } finally {
            await fsp.rm(root, { recursive: true, force: true });
          }
        });
      }
    }
  }

  it.each(["parse errors", "parser degradation"] as const)(
    "keeps uncertainty from legacy cached %s without a marker",
    async (diagnostic) => {
      const root = await mkTmpDir("cg-php-legacy-incomplete-");
      const options = { cache: "disk" as const, threads: 1 };
      try {
        const fixture = phpPathFallbackFixture("psr4");
        const source =
          diagnostic === "parse errors" ? PHP_INCOMPLETE_DECLARATION_SOURCES[0].source : fixture.missingSource;
        const files = await writeFixtureFiles(root, { ...fixture.files, [fixture.owner]: source });
        await buildProjectIndex(root, options);
        const owner = files[fixture.owner]!;
        const cached = peekCachedModule(root, owner, options);
        if (!cached?.mod.phpDeclarationNames) throw new Error("Expected cached PHP declaration facts");
        const legacy = {
          ...cached.mod,
          phpDeclarationNames: cached.mod.phpDeclarationNames.filter(
            (identity) => identity !== PHP_INCOMPLETE_DECLARATION_IDENTITY,
          ),
          parserDegraded: diagnostic === "parser degradation",
        };
        writeToCache(root, owner, cached.sig, legacy, options);
        closeDiskCacheDatabase(root, options);
        clearMemoryCache();
        const added = await writeFixtureFile(
          root,
          "Later.php",
          "<?php\nnamespace Later;\nuse App\\Gadget;\nfunction another(Gadget $value) {}\n",
        );
        const index = await buildProjectIndexIncremental(root, options);
        expect(edgeTargets(index, added)).toEqual([`file:${normalizePath(owner)}`]);
        expect(edgeTargets(index, added)).not.toContain(`file:${normalizePath(files["Decoy.php"]!)}`);
      } finally {
        closeDiskCacheDatabase(root, options);
        await fsp.rm(root, { recursive: true, force: true });
      }
    },
  );
});
describe("removed duplicate declarations resolve cached ambiguous imports", () => {
  const cases = DUPLICATE_DECLARATION_FIXTURES.flatMap((fixture) =>
    (["delete", "rename"] as const).flatMap((mutation) =>
      (["disk", "memory"] as const).map((cache) => ({ fixture, languageId: fixture.languageId, mutation, cache })),
    ),
  );

  it.each(cases)(
    "binds the survivor of a $languageId duplicate removed by $mutation, and ambiguity returns on restore ($cache)",
    async ({ fixture, mutation, cache }) => {
      await withDuplicateDeclarations(fixture, { cache, mutation, declarer: "second" }, async (project) => {
        expectDuplicateRemovalMatchesColdBuilds(fixture, project);
        if (cache !== "disk") return;
        // Only the edited duplicate and the importer it moves are extracted. PHP binds the first duplicate, so
        // removing the second one leaves its importer cached. The decoy, the survivor, and the importer of a
        // missing name stay cached throughout.
        const importerMoves = fixture.duplicatedTarget === "ambiguous";
        const extractedByRemoval = (mutation === "rename" ? 1 : 0) + (importerMoves ? 1 : 0);
        const filesAfterRemoval = mutation === "delete" ? 4 : 5;
        expect(project.removedReport.files).toMatchObject({
          total: filesAfterRemoval,
          parsed: extractedByRemoval,
          changed: extractedByRemoval,
          cached: filesAfterRemoval - extractedByRemoval,
        });
        if (mutation === "rename") {
          const extractedByRestore = importerMoves ? 2 : 1;
          expect(project.restoredReport.files?.parsed).toBeGreaterThanOrEqual(1);
          expect(project.restoredReport.files?.parsed).toBeLessThanOrEqual(2);
          if (importerMoves) {
            expect(project.restoredReport.files).toMatchObject({
              parsed: extractedByRestore,
              changed: extractedByRestore,
              cached: 5 - extractedByRestore,
            });
          }
        }
        const unchangedReport: BuildReport = { timings: {} };
        await buildProjectIndexIncremental(project.root, { cache, threads: 1, report: unchangedReport });
        expectNoReprocessedFiles(unchangedReport);
      });
    },
  );
});

/** What an importer binds and whether its lookups were complete, with every path relative to the root. */
function jvmImporterState(index: ProjectIndex, root: string, importer: string): unknown {
  const mod = index.byFile.get(fileIdentityKey(path.join(root, importer)));
  if (!mod) throw new Error(`missing module ${importer}`);
  return {
    targets: mod.imports.map((binding) =>
      typeof binding.resolved === "string" ? normalizePath(path.relative(root, binding.resolved)) : binding.resolved,
    ),
    parserDegraded: !!mod.parserDegraded,
    importLookupIncomplete: !!mod.importLookupIncomplete,
    edges: edgeTargets(index, path.join(root, importer)).map((edge) => edge.replace(normalizePath(root), "")),
  };
}

describe("Java and Kotlin declaration changes match a cold build after an incremental update", () => {
  /**
   * Applies each step (a null body deletes the file) and compares every importer with a cold build after it.
   * Returns each importer's incremental state after the initial build and after each step.
   */
  async function expectStepsMatchColdBuilds(
    cache: "disk" | "memory",
    files: Record<string, string>,
    steps: Array<Record<string, string | null>>,
    importers: string[],
    beforeStep?: (root: string, cacheDir: string) => Promise<void>,
  ): Promise<Array<Record<string, unknown>>> {
    const root = await mkTmpDir("cg-jvm-declaration-parity-");
    const cacheDir = await mkTmpDir("cg-jvm-declaration-parity-cache-");
    const build = { cache, cacheDir, threads: 1 } as const;
    const importerStates = (index: ProjectIndex): Record<string, unknown> =>
      Object.fromEntries(importers.map((importer) => [importer, jvmImporterState(index, root, importer)]));
    const states: Array<Record<string, unknown>> = [];
    try {
      await writeFixtureFiles(root, files);
      states.push(importerStates(await buildProjectIndex(root, build)));
      for (const step of steps) {
        await beforeStep?.(root, cacheDir);
        for (const [name, text] of Object.entries(step)) {
          if (text === null) await fsp.rm(path.join(root, name));
          else await writeFixtureFiles(root, { [name]: text });
        }
        const incremental = await buildProjectIndexIncremental(root, build);
        const cold = await buildProjectIndex(root, { cache: "off", threads: 1 });
        for (const importer of importers) {
          expect(jvmImporterState(incremental, root, importer)).toEqual(jvmImporterState(cold, root, importer));
        }
        states.push(importerStates(incremental));
      }
      return states;
    } finally {
      closeDiskCacheDatabase(root, build);
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.rm(cacheDir, { recursive: true, force: true });
    }
  }

  const caches = ["disk", "memory"] as const;

  // A top-level syntax error leaves a file incomplete: it may declare any name of its package. Its names do not
  // change, so only its certainty tells an importer of that package to look again.
  it.each(caches)(
    "marks a Kotlin importer incomplete when a file of its package gains a syntax error, and complete when it is fixed (%s)",
    async (cache) => {
      await expectStepsMatchColdBuilds(
        cache,
        {
          "a/A.kt": "package lib\nclass G\n",
          "b/B.kt": "package lib\nclass H\n",
          "u/Resolved.kt": "package app\nimport lib.G\nfun f() {}\n",
          "u/Missing.kt": "package app\nimport lib.Missing\nfun g() {}\n",
          "u/Wildcard.kt": "package app\nimport lib.*\nfun h() {}\n",
          "u/Other.kt": "package app\nimport elsewhere.Thing\nfun i() {}\n",
        },
        [{ "b/B.kt": "package lib\nclass H\n}\n" }, { "b/B.kt": "package lib\nclass H\n" }],
        ["u/Resolved.kt", "u/Missing.kt", "u/Wildcard.kt", "u/Other.kt"],
      );
    },
  );

  it.each(caches)(
    "resolves a Java import through an incomplete file that is named for the type, and again when it is fixed (%s)",
    async (cache) => {
      await expectStepsMatchColdBuilds(
        cache,
        {
          "b/B.java": "package lib;\n",
          "u/U.java": "package app;\nimport lib.B;\nclass U {}\n",
        },
        [{ "b/B.java": "package lib;\n}\n" }, { "b/B.java": "package lib;\n" }],
        ["u/U.java"],
      );
    },
  );

  it.each(caches)(
    "moves importers when a file whose package cannot be read gains and loses a syntax error (%s)",
    async (cache) => {
      await expectStepsMatchColdBuilds(
        cache,
        {
          "a/A.kt": "package lib\nclass G\n",
          "b/B.kt": "class H\n",
          "u/U.kt": "package app\nimport lib.G\nfun f() {}\n",
        },
        [{ "b/B.kt": "class H\n}\n" }, { "b/B.kt": "class H\n" }],
        ["u/U.kt"],
      );
    },
  );

  it.each(caches)("marks importers incomplete when an incomplete file is added or deleted (%s)", async (cache) => {
    await expectStepsMatchColdBuilds(
      cache,
      {
        "a/A.kt": "package lib\nclass G\n",
        "u/U.kt": "package app\nimport lib.G\nfun f() {}\n",
      },
      [{ "b/B.kt": "package lib\n}\n" }, { "b/B.kt": null }],
      ["u/U.kt"],
    );
  });

  // Java and Kotlin declarations are one group: deleting either duplicate lets an importer in either language bind
  // the survivor.
  it.each(caches)("binds the survivor of a Java and Kotlin duplicate deleted from either side (%s)", async (cache) => {
    const files = {
      "a/A.java": "package lib;\npublic class G {}\n",
      "b/B.kt": "package lib\nclass G\n",
      "u/FromKotlin.kt": "package app\nimport lib.G\nfun f() {}\n",
      "u/FromJava.java": "package app;\nimport lib.G;\nclass U {}\n",
    };
    await expectStepsMatchColdBuilds(cache, files, [{ "a/A.java": null }], ["u/FromKotlin.kt", "u/FromJava.java"]);
    await expectStepsMatchColdBuilds(cache, files, [{ "b/B.kt": null }], ["u/FromKotlin.kt", "u/FromJava.java"]);
  });

  // The cached module of a deleted file can be missing. Nothing then names what the file declared, so every
  // unresolved import of its language re-resolves.
  it.each(["java", "kotlin"] as const)(
    "binds the survivor of a %s duplicate that is deleted without a cached module",
    async (language) => {
      const ext = language === "java" ? "java" : "kt";
      const declarer = language === "java" ? "package lib;\npublic class G {}\n" : "package lib\nclass G\n";
      const importer =
        language === "java" ? "package app;\nimport lib.G;\nclass U {}\n" : "package app\nimport lib.G\nfun f() {}\n";
      await expectStepsMatchColdBuilds(
        "disk",
        { [`a/A.${ext}`]: declarer, [`b/B.${ext}`]: declarer, [`u/U.${ext}`]: importer },
        [{ [`b/B.${ext}`]: null }],
        [`u/U.${ext}`],
        async (root, cacheDir) => {
          const opts = { cache: "disk" as const, cacheDir };
          closeDiskCacheDatabase(root, opts);
          const db = new DatabaseSync(cacheDatabasePath(root, opts, "index-cache.sqlite"));
          try {
            const removed = db
              .prepare("DELETE FROM module_cache WHERE file = ?")
              .run(cacheRelativePath(root, path.join(root, `b/B.${ext}`)));
            expect(Number(removed.changes)).toBe(1);
          } finally {
            db.close();
          }
        },
      );
    },
  );

  // An import that resolves through a declaration can change answer when a file moves into or out of the package
  // it names. The importer has no manifest edge to that file, so only a declaration recheck reaches the importer.
  const jvmPackageLanguages = [
    { language: "java", ext: "java" },
    { language: "kotlin", ext: "kt" },
  ] as const;

  /** A file that declares class Helpers in the given package. */
  function helpersSource(language: "java" | "kotlin", pkg: string): string {
    return language === "java"
      ? `package ${pkg};\n\npublic class Helpers {\n  public static void run() {}\n}\n`
      : `package ${pkg}\n\nclass Helpers\n`;
  }

  /** A file in package app that imports the given name. */
  function importerSource(language: "java" | "kotlin", imported: string): string {
    return language === "java"
      ? `package app;\n\nimport ${imported};\n\nclass Main {}\n`
      : `package app\n\nimport ${imported}\n\nfun main() {}\n`;
  }

  for (const { language, ext } of jvmPackageLanguages) {
    const importer = `app/Main.${ext}`;
    const declarer = `x/Helpers.${ext}`;
    for (const cache of caches) {
      it(`resolves a ${language} import once a file moves into the imported package (${cache} cache)`, async () => {
        const states = await expectStepsMatchColdBuilds(
          cache,
          { [declarer]: helpersSource(language, "old"), [importer]: importerSource(language, "lib.Helpers") },
          [{ [declarer]: helpersSource(language, "lib") }],
          [importer],
        );
        expect(states).toMatchObject([
          { [importer]: { targets: [{ external: "lib.Helpers" }], edges: ["external:lib.Helpers"] } },
          { [importer]: { targets: [declarer], edges: [`file:/x/Helpers.${ext}`] } },
        ]);
      });

      it(`leaves a ${language} import external once a file moves out of the imported package (${cache} cache)`, async () => {
        const states = await expectStepsMatchColdBuilds(
          cache,
          { [declarer]: helpersSource(language, "lib"), [importer]: importerSource(language, "lib.Helpers") },
          [{ [declarer]: helpersSource(language, "old") }],
          [importer],
        );
        expect(states).toMatchObject([
          { [importer]: { targets: [declarer], edges: [`file:/x/Helpers.${ext}`] } },
          { [importer]: { targets: [{ external: "lib.Helpers" }], edges: ["external:lib.Helpers"] } },
        ]);
      });

      it(`binds a ${language} import to the survivor once one of two same-named declarations moves away (${cache} cache)`, async () => {
        const states = await expectStepsMatchColdBuilds(
          cache,
          {
            [`a/Helpers.${ext}`]: helpersSource(language, "helpers"),
            [`b/Helpers.${ext}`]: helpersSource(language, "helpers"),
            [importer]: importerSource(language, "helpers.Helpers"),
          },
          [{ [`b/Helpers.${ext}`]: helpersSource(language, "other") }],
          [importer],
        );
        expect(states).toMatchObject([
          { [importer]: { targets: [{ external: "helpers.Helpers" }], edges: ["external:helpers.Helpers"] } },
          { [importer]: { targets: [`a/Helpers.${ext}`], edges: [`file:/a/Helpers.${ext}`] } },
        ]);
      });
    }
  }
});

describe("tracked file restoration matches cold builds", () => {
  const original = 'import { left } from "./left";\nexport function value() { return left(); }\n';
  const edited = 'import { right } from "./right";\nexport function value() { return right(); }\n';
  const mainSource = 'import { value } from "./nested/value";\nexport function run() { return value(); }\n';
  const scenarios = [
    "delete and restore",
    "edit and revert",
    "edit and commit",
    "restore beside another edit",
  ] as const;
  const cases = (["disk", "memory"] as const).flatMap((cache) =>
    scenarios.map((scenario) => ({ cache, scenario, repository: true })),
  );
  cases.push(
    ...(["disk", "memory"] as const).flatMap((cache) =>
      (["delete and restore", "edit and revert"] as const).map((scenario) => ({
        cache,
        scenario,
        repository: false,
      })),
    ),
  );

  async function expectRestoredMatchesCold(root: string, warm: ProjectIndex): Promise<void> {
    const cold = await buildProjectIndex(root, { cache: "off", threads: 1, logLevel: "silent" });
    expect([...warm.byFile.keys()].sort()).toEqual([...cold.byFile.keys()].sort());
    for (const [file, mod] of cold.byFile) {
      expect(warm.byFile.get(file)?.exports).toEqual(mod.exports);
      expect(warm.byFile.get(file)?.imports).toEqual(mod.imports);
    }
    expect(new Set(warm.graph.edges)).toEqual(new Set(cold.graph.edges));
    const main = path.join(root, "src", "main.ts");
    const target = path.join(root, "src", "nested", "value.ts");
    const decoy = path.join(root, "src", "other", "value.ts");
    expect(warm.byFile.has(fileIdentityKey(target))).toBe(true);
    expect(importBindings(warm, main)).toEqual([{ kind: "named", resolved: normalizePath(target) }]);
    expect(edgeTargets(warm, main)).toEqual([`file:${normalizePath(target)}`]);
    expect(edgeTargets(warm, main)).not.toContain(`file:${normalizePath(decoy)}`);
    const goto = await goToDefinition(warm, { file: main, line: 2, column: 32 });
    expect(goto.status).toBe("ok");
    if (goto.status !== "ok") throw new Error("expected restored value to resolve");
    expect(normalizePath(goto.definition.file)).toBe(normalizePath(target));
    const references = await findReferences(warm, { file: target, line: 2, column: 17 });
    expect(references.status).toBe("ok");
    if (references.status !== "ok") throw new Error("expected restored value references");
    expect(references.referenceCoverage.state).toBe("complete");
    expect(references.references.some((reference) => fileIdentityKey(reference.file) === fileIdentityKey(main))).toBe(
      true,
    );
    expect(references.references.some((reference) => fileIdentityKey(reference.file) === fileIdentityKey(decoy))).toBe(
      false,
    );
    const graphEdges = async (index: ProjectIndex): Promise<string[]> => {
      const graph = await buildSymbolGraphDetailed(index);
      return graph.edges
        .map((edge) => {
          const from = graph.nodes.get(edge.from)!;
          const to = graph.nodes.get(edge.to)!;
          return `${from.file}::${from.name}|${edge.label}|${to.file}::${to.name}`;
        })
        .sort();
    };
    const warmEdges = await graphEdges(warm);
    expect(warmEdges).toEqual(await graphEdges(cold));
    expect(warmEdges).toContain(`${normalizePath(main)}::run|calls|${normalizePath(target)}::value`);
    expect(warmEdges.some((edge) => edge.includes(`|${normalizePath(decoy)}::value`))).toBe(false);
  }

  it.each([
    { session: false, allMisses: true },
    { session: true, allMisses: false },
    { session: true, allMisses: true },
  ])("restores memory imports with session=$session and allMisses=$allMisses", async ({ session, allMisses }) => {
    const root = await mkTmpDir("cg-memory-restored-scope-");
    const options = { cache: "memory" as const, threads: 1, logLevel: "silent" as const };
    const agentSession = session
      ? createAgentSession({ root, buildOptions: options, freshness: { policy: "auto" } })
      : undefined;
    const load = async (): Promise<ProjectIndex> => {
      if (!agentSession) return buildProjectIndexIncremental(root, options);
      agentSession.invalidate();
      return (await agentSession.loadProject({ symbolGraph: "skip" })).index;
    };
    try {
      const target = await writeFixtureFile(root, "src/nested/value.ts", original);
      const files = [
        await writeFixtureFile(root, "src/main.ts", mainSource),
        await writeFixtureFile(root, "src/nested/left.ts", "export function left() { return 1; }\n"),
        await writeFixtureFile(root, "src/nested/right.ts", "export function right() { return 2; }\n"),
        await writeFixtureFile(root, "src/other/value.ts", "export function value() { return 99; }\n"),
      ];
      git(root, ["init", "-q"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      git(root, ["add", "src"]);
      git(root, ["commit", "-qm", "base"]);
      await load();
      await fsp.unlink(target);
      if (allMisses)
        await Promise.all(files.map((file) => fsp.appendFile(file, "// edited while target is deleted\n")));
      const deleted = await load();
      expect(deleted.byFile.has(fileIdentityKey(target))).toBe(false);
      expect(edgeTargets(deleted, files[0]!)).toEqual(["external:./nested/value"]);
      git(root, ["checkout", "--", "src/nested/value.ts"]);
      await expectRestoredMatchesCold(root, await load());
    } finally {
      agentSession?.invalidate();
      clearMemoryCache();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not probe non-declaration rows omitted by a memory subset build", async () => {
    const root = await mkTmpDir("cg-memory-subset-probes-");
    const options = { cache: "memory" as const, threads: 1, logLevel: "silent" as const };
    try {
      const main = await writeFixtureFile(root, "main.ts", "export const value = 1;\n");
      const omitted = [
        await writeFixtureFile(root, "a.ts", "export const value = 2;\n"),
        await writeFixtureFile(root, "b.ts", "export const value = 3;\n"),
      ];
      await buildProjectIndex(root, options);
      const access = vi.spyOn(fsp, "access");
      const subset = await buildProjectIndexFromFiles(root, [main], options);
      expect([...subset.byFile.keys()]).toEqual([fileIdentityKey(main)]);
      const probed = access.mock.calls.map(([file]) => normalizePath(String(file)));
      for (const file of omitted) expect(probed).not.toContain(normalizePath(file));
    } finally {
      vi.restoreAllMocks();
      clearMemoryCache();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it.each(cases)("$scenario ($cache cache, Git=$repository)", async ({ cache, scenario, repository }) => {
    const root = await mkTmpDir("cg-tracked-restore-");
    const options = { cache, threads: 1, logLevel: "silent" as const };
    try {
      const target = await writeFixtureFile(root, "src/nested/value.ts", original);
      await writeFixtureFile(root, "src/main.ts", mainSource);
      await writeFixtureFile(root, "src/nested/left.ts", "export function left() { return 1; }\n");
      await writeFixtureFile(root, "src/nested/right.ts", "export function right() { return 2; }\n");
      await writeFixtureFile(root, "src/other/value.ts", "export function value() { return 99; }\n");
      const unrelated = await writeFixtureFile(root, "src/unrelated.ts", "export const unrelated = 1;\n");
      if (repository) {
        git(root, ["init", "-q"]);
        git(root, ["config", "user.email", "tests@example.com"]);
        git(root, ["config", "user.name", "Tests"]);
        git(root, ["config", "core.autocrlf", "false"]);
        git(root, ["add", "src"]);
        git(root, ["commit", "-qm", "base"]);
      }
      await buildProjectIndex(root, options);
      const deleted = scenario === "delete and restore" || scenario === "restore beside another edit";
      if (deleted) await fsp.unlink(target);
      else await fsp.writeFile(target, edited);
      const intermediate = await buildProjectIndexIncremental(root, options);
      if (deleted) {
        expect(intermediate.byFile.has(fileIdentityKey(target))).toBe(false);
        expect(edgeTargets(intermediate, path.join(root, "src/main.ts"))).toEqual(["external:./nested/value"]);
      } else {
        expect(edgeTargets(intermediate, target)).toEqual([
          `file:${normalizePath(path.join(root, "src/nested/right.ts"))}`,
        ]);
      }
      if (scenario === "edit and commit") {
        await fsp.writeFile(target, `${edited}export const committedOnly = 1;\n`);
        git(root, ["add", "src/nested/value.ts"]);
        git(root, ["commit", "-qm", "updated"]);
      } else if (repository) {
        git(root, ["checkout", "--", "src/nested/value.ts"]);
      } else {
        await fsp.writeFile(target, original);
      }
      if (scenario === "restore beside another edit") {
        await fsp.writeFile(unrelated, 'import { right } from "./nested/right";\nexport const unrelated = right();\n');
      }
      if (cache === "disk") {
        closeDiskCacheDatabase(root, options);
        clearMemoryCache();
      }
      const warm = await buildProjectIndexIncremental(root, options);
      await expectRestoredMatchesCold(root, warm);
      if (cache === "disk") {
        closeDiskCacheDatabase(root, options);
        clearMemoryCache();
      }
      const report: BuildReport = { timings: {} };
      const reloaded = await buildProjectIndexIncremental(root, { ...options, report });
      if (cache === "disk") {
        expectNoReprocessedFiles(report);
      } else {
        expect(report.files?.cached).toBe(warm.byFile.size);
        expect(report.backend?.native.filesUsed).toBe(0);
      }
      await expectRestoredMatchesCold(root, reloaded);
    } finally {
      closeDiskCacheDatabase(root, options);
      clearMemoryCache();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
