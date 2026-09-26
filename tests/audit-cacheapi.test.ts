import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  buildSymbolGraphDetailed,
  findReferences,
  getUnresolvedImports,
  goToDefinition,
  type BuildReport,
} from "../src/index.js";
import { createAgentSession } from "../src/agent/session.js";
import { workspaceSymbolsWithSession } from "../src/agent/workspace-symbols.js";
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

async function expectWarmMatchesCold(root: string, consumer: string, warm: ProjectIndex): Promise<string[]> {
  const cold = await buildProjectIndex(root, { cache: "off" });
  const warmTargets = edgeTargets(warm, consumer);
  expect(warmTargets).toEqual(edgeTargets(cold, consumer));
  return warmTargets;
}

function expectNoReprocessedFiles(report: BuildReport): void {
  expect(report.files?.parsed ?? 0).toBe(0);
  expect(report.files?.changed ?? 0).toBe(0);
}

describe("G1: warm disk-cache build reacts when a file starts or stops resolving an import", () => {
  it("reparses nothing when an unrelated file is deleted", async () => {
    const root = await mkTmpDir("cg-audit-g1-unrelated-delete-");
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
    const root = await mkTmpDir("cg-audit-g1-add-delete-");
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

  it("auto-refreshes a warm agent session so a newly added file resolves a previously unresolved import", async () => {
    const root = await mkTmpDir("cg-audit-g1-session-");
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
    const root = await mkTmpDir("cg-audit-g1-python-");
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

  it("resolves a C quoted #include once the header is added, and unresolves it again once deleted", async () => {
    const root = await mkTmpDir("cg-audit-g1-c-include-");
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

  it("resolves a tsconfig path alias once the target file is added, and unresolves it again once deleted", async () => {
    const root = await mkTmpDir("cg-audit-g1-ts-alias-");
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
});

describe("G2: dependency-manifest discovery stays confined to --root without a Git boundary", () => {
  it("ignores a manifest above --root but honors manifests at or inside --root", async () => {
    const outerRoot = await mkTmpDir("cg-audit-g2-");
    try {
      const projectRoot = path.join(outerRoot, "inner");
      const srcDir = path.join(projectRoot, "src");
      await fsp.mkdir(srcDir, { recursive: true });
      await fsp.writeFile(
        path.join(outerRoot, "package.json"),
        JSON.stringify({ dependencies: { "definitely-fake-outer-only-pkg": "1.0.0" } }),
        "utf8",
      );
      // Deliberately no manifest directly at `projectRoot` itself: the manifest search must
      // still stop there (not reach `outerRoot`) instead of only stopping by accident because
      // it found a manifest immediately. The in-root manifest sits one level further in, so
      // reaching it still requires walking from the importer up to (and including) the root.
      await fsp.writeFile(
        path.join(srcDir, "package.json"),
        JSON.stringify({ dependencies: { "definitely-fake-in-root-pkg": "1.0.0" } }),
        "utf8",
      );
      await fsp.writeFile(
        path.join(srcDir, "app.ts"),
        [
          'import a from "definitely-fake-outer-only-pkg";',
          'import b from "definitely-fake-in-root-pkg";',
          'import c from "definitely-fake-nowhere-pkg";',
          "export const use = [a, b, c];",
          "",
        ].join("\n"),
        "utf8",
      );

      const index = await buildProjectIndex(projectRoot, { cache: "off" });
      const unresolved = getUnresolvedImports(index.graph, { projectRoot }).map((entry) => entry.name);

      // Outside-root manifest ignored: the declared-only-outside package stays unresolved,
      // exactly like the decoy package that is declared nowhere at all.
      expect(unresolved).toContain("definitely-fake-outer-only-pkg");
      expect(unresolved).toContain("definitely-fake-nowhere-pkg");
      // In-root manifest honored: a package declared inside --root is not unresolved.
      expect(unresolved).not.toContain("definitely-fake-in-root-pkg");
    } finally {
      await fsp.rm(outerRoot, { recursive: true, force: true });
    }
  });
});

describe("G6: agent session freshness under a manual policy never claims fresh without evidence", () => {
  it("reports an explicit unchecked state instead of a false fresh claim after an on-disk edit", async () => {
    const root = await mkTmpDir("cg-audit-g6-");
    try {
      const mathFile = path.join(root, "math.ts");
      const original = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
      const edited =
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n" +
        "export function sub(a: number, b: number): number {\n  return a - b;\n}\n";
      await fsp.writeFile(mathFile, original, "utf8");

      const manualSession = createAgentSession({
        root,
        buildOptions: { cache: "off" },
        freshness: { policy: "manual" },
      });
      await manualSession.loadProject({ symbolGraph: "skip" });

      // Decoy/control: the identical edit under "check" policy is a real, honest check, so a
      // manual-only bug cannot masquerade as expected behavior for every policy.
      const checkSession = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "check" } });
      await checkSession.loadProject({ symbolGraph: "skip" });

      await fsp.writeFile(mathFile, edited, "utf8");

      const manualFreshness = await manualSession.checkFreshness!();
      expect(manualFreshness.state).not.toBe("fresh");
      expect(manualFreshness).toEqual({
        state: "unchecked",
        reason: "freshness policy is manual; call invalidate() explicitly after edits",
      });

      const checkFreshness = await checkSession.checkFreshness!();
      expect(checkFreshness.state).toBe("stale");

      // Manual truly does not auto-invalidate: loadProject keeps serving the stale snapshot.
      // That is unchanged by the fix -- only the dishonest "fresh" label is fixed.
      const manualSnapshot = await manualSession.loadProject({ symbolGraph: "skip" });
      const manualExports = [...manualSnapshot.index.byFile.values()][0]!.exports.flatMap((entry) =>
        entry.type === "local" ? [entry.exportedAs] : [],
      );
      expect(manualExports).not.toContain("sub");

      manualSession.invalidate();
      checkSession.invalidate();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the real workspaceSymbolsWithSession consumer honest under manual policy", async () => {
    const root = await mkTmpDir("cg-audit-g6-consumer-");
    try {
      const mathFile = path.join(root, "math.ts");
      await fsp.writeFile(
        mathFile,
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
        "utf8",
      );
      const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });

      const before = await workspaceSymbolsWithSession(session, { root, query: "add", limit: 20 });
      expect(before.symbols.some((symbol) => symbol.name === "add")).toBe(true);

      await fsp.writeFile(
        mathFile,
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n" +
          "export function sub(a: number, b: number): number {\n  return a - b;\n}\n",
        "utf8",
      );

      const after = await workspaceSymbolsWithSession(session, { root, query: "sub", limit: 20 });
      expect(after.freshness).toEqual({
        state: "unchecked",
        reason: "freshness policy is manual; call invalidate() explicitly after edits",
      });
      // The audited defect: symbols is still missing "sub" because manual truly does not
      // auto-invalidate; the fix only requires the freshness label to stop lying about it.
      expect(after.symbols.some((symbol) => symbol.name === "sub")).toBe(false);

      session.invalidate();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
