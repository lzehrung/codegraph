import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
import type { ProjectIndex } from "../src/indexer/types.js";
import { fileIdentityKey, normalizePath } from "../src/util/paths.js";
import { columnOf } from "./languages/callable-consumer-fixtures.js";
import { mkTmpDir } from "./helpers/filesystem.js";

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

  // The added file's stem (`beta`) never matches the imported module name (`shared`), so the
  // stem check cannot see the new declaration; the declared-container comparison has to. Disk
  // exercises the manifest path, memory the no-manifest path.
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

  // The stem filter sees only the filename (Helpers), while the import names the declaration
  // (p.Widget), so only the declaration-language extension rule can trigger re-resolution.
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

  // Without a manifest there is no previous file set: a deleted duplicate declarer leaves no
  // cache miss behind, and a rewritten one only proves itself changed, never what it declared.
  // Surviving rows (deleted files) and stale rows (changed files) close both gaps.
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
});
