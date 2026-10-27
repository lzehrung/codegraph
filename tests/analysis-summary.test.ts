import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { previewRenameWithSession, type RenamePreviewResponse } from "../src/agent/rename-preview.js";
import { searchCodegraphWithSession } from "../src/agent/search.js";
import { createAgentSession, type AgentSession } from "../src/agent/session.js";
import { workspaceSymbolsWithSession } from "../src/agent/workspace-symbols.js";
import { isAnalysisComplete, summarizeAnalysis, type AnalysisSummary } from "../src/analysis-summary.js";
import { buildProjectIndex, buildProjectIndexIncremental, type BuildOptions, type BuildReport } from "../src/index.js";
import type { ProjectIndex } from "../src/indexer.js";
import * as filePrep from "../src/languages/file-prep.js";
import { __resetNativeTreeSitterBindingForTests } from "../src/native/tree-sitter-native.js";
import { fileIdentityKey, normalizePath } from "../src/util/paths.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";
import { failNativeExtractionFor, failNativeTreeReconstructionFor } from "./helpers/native-tree.js";

const roots = createTempRootRegistry();
const sessions: AgentSession[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  __resetNativeTreeSitterBindingForTests();
  for (const session of sessions.splice(0)) session.invalidate();
  await roots.cleanup();
});

function cacheDir(root: string): string {
  return path.join(root, ".codegraph", "cache", "index-v1");
}

async function createProject(prefix: string, files: Record<string, string>): Promise<string> {
  const root = await roots.create(prefix);
  for (const [file, text] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fsp.writeFile(path.join(root, file), text, "utf8");
  }
  return root;
}

function projectFiles(): Record<string, string> {
  return {
    "src/auth.ts": "export function validateUser(token: string) {\n  return token.length > 2;\n}\n",
    "src/other.ts": "export const betaMarker = 'beta only';\n",
    "docs/guide.md": "# Security guide\n\nValidate user sessions before issuing credentials.\n",
    "package.json": '{"name":"analysis-summary-fixture"}\n',
  };
}

/** A TypeScript file past the native source limit, so native skips it with `sourceTooLarge`. */
function oversizedSource(): string {
  return `export const big = 1;\n// ${"x".repeat(9 * 1024 * 1024)}\n`;
}

/** A file whose syntax tree is unavailable once `fail` has broken native handling of sources containing `marker`. */
type TreeFailureScenario = {
  degradedFile: string;
  source: string;
  marker: string;
  fail: (marker: string) => void;
  counts: Pick<AnalysisSummary, "nativeFilesUsed" | "nativeFilesFellBack">;
};

async function build(
  root: string,
  options: Pick<BuildOptions, "logLevel"> = {},
): Promise<{ analysis: AnalysisSummary; report: BuildReport; index: ProjectIndex }> {
  const report: BuildReport = { timings: {} };
  const index = await buildProjectIndexIncremental(root, { cache: "disk", threads: 1, report, ...options });
  return { analysis: summarizeAnalysis({ index, report }), report, index };
}

/** A full-discovery build, which probes the module cache for every file instead of reconciling the manifest. */
async function buildFull(
  root: string,
  options: Pick<BuildOptions, "logLevel"> = {},
): Promise<{ analysis: AnalysisSummary; report: BuildReport; index: ProjectIndex }> {
  const report: BuildReport = { timings: {} };
  const index = await buildProjectIndex(root, { cache: "disk", threads: 1, report, ...options });
  return { analysis: summarizeAnalysis({ index, report }), report, index };
}

/** The analysis summary a new agent process reads when it loads the project. */
async function analysisInFreshSession(root: string): Promise<AnalysisSummary> {
  const session = createAgentSession({ root, buildOptions: { cache: "disk" } });
  sessions.push(session);
  return (await session.loadProject({ symbolGraph: "skip" })).analysis;
}

/** Previews renaming `small`, a healthy export, in a fresh session. The summary alone decides whether that is safe. */
async function renamePreviewInFreshSession(root: string): Promise<RenamePreviewResponse> {
  const session = createAgentSession({ root, buildOptions: { cache: "disk" } });
  sessions.push(session);
  const symbols = await workspaceSymbolsWithSession(session, { root, query: "small", exportedOnly: true });
  const target = symbols.symbols.find((symbol) => symbol.name === "small");
  if (!target) throw new Error("Expected the small export in the project index.");
  return await previewRenameWithSession(session, { root, handle: target.handle, newName: "tiny" });
}

/** Searches in a fresh session, as a new agent process would, and reports the backend each layer names. */
async function searchInFreshSession(root: string): Promise<{ analysisBackend: string; resultBackends: string[] }> {
  const session = createAgentSession({ root, buildOptions: { cache: "disk" } });
  sessions.push(session);
  const response = await searchCodegraphWithSession(session, { root, query: "validate user", mode: "text", limit: 10 });
  const snapshot = await session.loadProject({ symbolGraph: "skip" });
  return {
    analysisBackend: snapshot.analysis.backend,
    resultBackends: response.results.map((result) => result.provenance.backend),
  };
}

describe("analysis summary", () => {
  it("keeps the native backend for a cold build, a warm session, and a rebuild after editing only docs", async () => {
    const root = await createProject("cg-analysis-session-", projectFiles());

    const cold = await searchInFreshSession(root);
    const warm = await searchInFreshSession(root);
    await fsp.writeFile(
      path.join(root, "docs", "guide.md"),
      "# Security guide\n\nValidate user sessions before issuing credentials, then revoke them.\n",
      "utf8",
    );
    const afterDocsEdit = await searchInFreshSession(root);

    for (const stage of [cold, warm, afterDocsEdit]) {
      expect(stage.analysisBackend).toBe("native");
      expect(stage.resultBackends.length).toBeGreaterThan(0);
      expect(new Set(stage.resultBackends)).toEqual(new Set(["native"]));
    }
  });

  it("counts files whose modules the build reused from the module cache", async () => {
    const root = await createProject("cg-analysis-module-cache-", projectFiles());
    const cold = await build(root);
    expect(cold.analysis).toMatchObject({ backend: "native", nativeFilesUsed: 2, nativeFilesFellBack: 0 });

    // Without a manifest or project snapshot the next build is served by the module cache alone, as when two
    // sessions index one project at once and the later one finds the earlier one's parsed modules.
    await fsp.rm(path.join(cacheDir(root), "manifest.json"));
    await fsp.rm(path.join(cacheDir(root), "project-index-snapshot.json"));
    const cached = await build(root);

    expect(cached.report.cache?.hits).toBeGreaterThan(0);
    expect(cached.report.backend?.native.filesUsed).toBe(0);
    expect(cached.analysis).toMatchObject({
      backend: "native",
      nativeFilesUsed: 2,
      nativeFilesFellBack: 0,
      label: "native semantic",
    });
  });

  it("keeps the native backend when a rebuild parses only a docs file", async () => {
    const root = await createProject("cg-analysis-docs-edit-", projectFiles());
    await build(root);

    await fsp.writeFile(path.join(root, "docs", "guide.md"), "# Security guide\n\nEdited.\n", "utf8");
    const rebuilt = await build(root);

    expect(rebuilt.report.backend?.native.filesUsed).toBe(0);
    expect(rebuilt.analysis).toMatchObject({ backend: "native", nativeFilesUsed: 2, label: "native semantic" });
  });

  it("keeps a skipped oversized file counted when a rebuild reuses its module", async () => {
    const root = await createProject("cg-analysis-skipped-", {
      "src/big.ts": oversizedSource(),
      "src/small.ts": "export const small = 1;\n",
      "docs/guide.md": "# Guide\n",
    });

    const cold = await build(root);
    await fsp.writeFile(path.join(root, "src", "small.ts"), "export const small = 2;\n", "utf8");
    const afterCodeEdit = await build(root);
    await fsp.writeFile(path.join(root, "docs", "guide.md"), "# Guide\n\nEdited.\n", "utf8");
    const afterDocsEdit = await build(root);

    for (const stage of [cold, afterCodeEdit, afterDocsEdit]) {
      expect(stage.analysis).toMatchObject({
        backend: "native",
        nativeFilesUsed: 1,
        nativeFilesFellBack: 1,
        label: "native semantic (1 file(s) skipped)",
      });
      expect(isAnalysisComplete(stage.analysis)).toBe(false);
    }
  });

  it("keeps a file counted as skipped when it passed the native limit after the cache held its parsed module", async () => {
    const root = await createProject("cg-analysis-skipped-after-parse-", {
      "src/big.ts": "export const big = 1;\n",
      "src/small.ts": "export const small = 1;\n",
      "docs/guide.md": "# Guide\n",
    });
    const bigKey = fileIdentityKey(normalizePath(path.join(root, "src", "big.ts")));

    const parsed = await build(root);
    expect(parsed.index.byFile.get(bigKey)?.locals.map((local) => local.localName)).toEqual(["big"]);

    // The module cache keeps the row from big.ts's last parse, and native now skips the file. Only the project
    // snapshot can record the skip, so a rebuild that reuses the snapshot must still find it there.
    await fsp.writeFile(path.join(root, "src", "big.ts"), oversizedSource(), "utf8");
    const afterGrowth = await build(root);
    const afterNoChange = await build(root);
    await fsp.writeFile(path.join(root, "docs", "guide.md"), "# Guide\n\nEdited.\n", "utf8");
    const afterDocsEdit = await build(root);

    for (const stage of [afterGrowth, afterNoChange, afterDocsEdit]) {
      expect(stage.analysis).toMatchObject({
        backend: "native",
        nativeFilesUsed: 1,
        nativeFilesFellBack: 1,
        label: "native semantic (1 file(s) skipped)",
      });
      expect(isAnalysisComplete(stage.analysis)).toBe(false);
      // The skipped file keeps none of the symbols from before it grew.
      expect(stage.index.byFile.get(bigKey)).toMatchObject({ nativeOutcome: "skipped", locals: [] });
    }

    // A session that loads the project next reads the same summary.
    const session = createAgentSession({ root, buildOptions: { cache: "disk" } });
    sessions.push(session);
    const snapshot = await session.loadProject({ symbolGraph: "skip" });
    expect(snapshot.analysis).toMatchObject({ nativeFilesFellBack: 1 });
    expect(isAnalysisComplete(snapshot.analysis)).toBe(false);
  });

  it("keeps a file counted as parser-degraded when its syntax tree could not be rebuilt and a rebuild reuses its module", async () => {
    const root = await createProject("cg-analysis-parser-degraded-", {
      "src/treeless.ts": "export const treelessMarker = 1;\n",
      "src/small.ts": "export const small = 1;\n",
      "docs/guide.md": "# Guide\n",
    });
    const treelessKey = fileIdentityKey(normalizePath(path.join(root, "src", "treeless.ts")));
    const degraded = {
      backend: "native",
      parserDegradedFiles: 1,
      nativeFilesUsed: 2,
      nativeFilesFellBack: 0,
      label: "native semantic (1 file(s) skipped)",
    };

    failNativeTreeReconstructionFor("treelessMarker");
    const cold = await build(root);
    // Native queries succeeded for both files, but one file's syntax tree could not be rebuilt.
    expect(cold.report.backend?.native).toMatchObject({ filesUsed: 2, filesFellBack: 0 });
    expect(cold.report.backend?.parser).toMatchObject({ total: 1, byLanguage: { ts: 1 } });
    expect(cold.analysis).toMatchObject(degraded);
    expect(cold.index.byFile.get(treelessKey)).toMatchObject({ nativeOutcome: "used", parserDegraded: true });

    // From here the real parser could rebuild the tree, so only the stored module can say it was degraded.
    __resetNativeTreeSitterBindingForTests();
    await fsp.writeFile(path.join(root, "docs", "guide.md"), "# Guide\n\nEdited.\n", "utf8");
    const afterDocsEdit = await build(root);
    expect(afterDocsEdit.report.backend?.parser).toBeUndefined();
    expect(afterDocsEdit.analysis).toMatchObject(degraded);
    expect(isAnalysisComplete(afterDocsEdit.analysis)).toBe(false);

    // A session that loads the project next reads the same summary, and does not call a rename safe.
    const freshSession = await analysisInFreshSession(root);
    expect(freshSession).toMatchObject(degraded);
    expect(isAnalysisComplete(freshSession)).toBe(false);
    const degradedRename = await renamePreviewInFreshSession(root);
    expect(degradedRename.safe).toBe(false);
    expect(degradedRename.unsafeSites.map((site) => site.reason)).toEqual(["parse_degraded"]);

    // With neither the manifest nor the project snapshot, the module cache alone serves the build.
    await fsp.rm(path.join(cacheDir(root), "manifest.json"));
    await fsp.rm(path.join(cacheDir(root), "project-index-snapshot.json"));
    const moduleCacheOnly = await build(root);
    expect(moduleCacheOnly.report.cache?.hits).toBeGreaterThan(0);
    expect(moduleCacheOnly.report.backend?.parser).toBeUndefined();
    expect(moduleCacheOnly.analysis).toMatchObject(degraded);
    expect(isAnalysisComplete(moduleCacheOnly.analysis)).toBe(false);
    expect(moduleCacheOnly.index.byFile.get(treelessKey)).toMatchObject({ parserDegraded: true });

    // Once the file is edited and its tree can be rebuilt again, it is no longer counted.
    await fsp.writeFile(path.join(root, "src", "treeless.ts"), "export const rebuilt = 2;\n", "utf8");
    const afterRepair = await build(root);
    expect(afterRepair.analysis).toMatchObject({
      parserDegradedFiles: 0,
      nativeFilesUsed: 2,
      label: "native semantic",
    });
    expect(isAnalysisComplete(afterRepair.analysis)).toBe(true);
    expect(afterRepair.index.byFile.get(treelessKey)?.parserDegraded).toBeUndefined();
    expect(isAnalysisComplete(await analysisInFreshSession(root))).toBe(true);
    expect((await renamePreviewInFreshSession(root)).safe).toBe(true);
  });

  it.each<[string, TreeFailureScenario]>([
    [
      "native extraction and the standalone parse both fail",
      {
        degradedFile: "src/native-down.ts",
        source: "export const nativeDownMarker = 1;\n",
        marker: "nativeDownMarker",
        fail: failNativeExtractionFor,
        // Native skipped the file, so it counts as fallen back and not as used.
        counts: { nativeFilesUsed: 1, nativeFilesFellBack: 1 },
      },
    ],
    [
      "a SQL file's extraction carries no syntax tree",
      {
        degradedFile: "db/schema.sql",
        source: "CREATE TABLE sqlTreelessMarker (id integer);\n",
        marker: "sqlTreelessMarker",
        fail: failNativeTreeReconstructionFor,
        counts: { nativeFilesUsed: 2, nativeFilesFellBack: 0 },
      },
    ],
  ])("keeps a file counted as parser-degraded when %s and a rebuild reuses its module", async (_title, scenario) => {
    const root = await createProject("cg-analysis-parser-degraded-sites-", {
      [scenario.degradedFile]: scenario.source,
      "src/small.ts": "export const small = 1;\n",
      "docs/guide.md": "# Guide\n",
    });
    const degradedKey = fileIdentityKey(normalizePath(path.join(root, scenario.degradedFile)));
    const degraded = { backend: "native", parserDegradedFiles: 1, ...scenario.counts };

    scenario.fail(scenario.marker);
    const cold = await build(root, { logLevel: "silent" });
    expect(cold.index.byFile.get(degradedKey)).toMatchObject({ parserDegraded: true });
    expect(cold.analysis).toMatchObject(degraded);

    __resetNativeTreeSitterBindingForTests();
    await fsp.writeFile(path.join(root, "docs", "guide.md"), "# Guide\n\nEdited.\n", "utf8");
    const afterDocsEdit = await build(root, { logLevel: "silent" });
    expect(afterDocsEdit.report.backend?.parser).toBeUndefined();
    expect(afterDocsEdit.analysis).toMatchObject(degraded);
    expect(afterDocsEdit.index.byFile.get(degradedKey)).toMatchObject({ parserDegraded: true });
    expect(await analysisInFreshSession(root)).toMatchObject(degraded);
  });

  it.each(["incremental", "full"] as const)(
    "keeps a cached file counted as degraded when processing it fails (%s build), instead of restoring its old module",
    async (failingBuild) => {
      const root = await createProject("cg-analysis-failed-file-", {
        "src/flaky.ts": "export const before = 1;\n",
        "src/small.ts": "export const small = 1;\n",
        "docs/guide.md": "# Guide\n",
      });
      const flakyKey = fileIdentityKey(normalizePath(path.join(root, "src", "flaky.ts")));
      const localNames = (stage: { index: ProjectIndex }): string[] | undefined =>
        stage.index.byFile.get(flakyKey)?.locals.map((local) => local.localName);
      const quiet = { logLevel: "silent" } as const;

      const cold = await build(root, quiet);
      expect(localNames(cold)).toEqual(["before"]);
      expect(isAnalysisComplete(cold.analysis)).toBe(true);

      // The disk cache now holds flaky.ts's parsed module. Editing the file makes that row stale, and processing fails.
      await fsp.writeFile(path.join(root, "src", "flaky.ts"), "export const after = 2;\n", "utf8");
      const prepareSourceInput = filePrep.prepareSourceInput;
      const failing = vi
        .spyOn(filePrep, "prepareSourceInput")
        .mockImplementation((file, options) =>
          file.endsWith("flaky.ts")
            ? Promise.reject(new Error("injected processing failure"))
            : prepareSourceInput(file, options),
        );
      const afterFailure = failingBuild === "full" ? await buildFull(root, quiet) : await build(root, quiet);
      failing.mockRestore();
      expect(afterFailure.report.files?.failed).toBe(1);

      await fsp.writeFile(path.join(root, "docs", "guide.md"), "# Guide\n\nEdited.\n", "utf8");
      const afterDocsEdit = await build(root, quiet);
      const afterNoChange = await build(root, quiet);

      // The stale row still holds the old symbols, but the index must not bring them back for a file that failed.
      for (const stage of [afterFailure, afterDocsEdit, afterNoChange]) {
        expect(localNames(stage)).toEqual([]);
        expect(stage.index.byFile.get(flakyKey)).toMatchObject({ parserDegraded: true });
        expect(stage.analysis).toMatchObject({ parserDegradedFiles: 1 });
        expect(isAnalysisComplete(stage.analysis)).toBe(false);
      }
      const freshSession = await analysisInFreshSession(root);
      expect(freshSession).toMatchObject({ parserDegradedFiles: 1 });
      expect(isAnalysisComplete(freshSession)).toBe(false);

      // Once the file processes again it is indexed normally.
      await fsp.writeFile(path.join(root, "src", "flaky.ts"), "export const fixed = 3;\n", "utf8");
      const afterRepair = await build(root, quiet);
      expect(localNames(afterRepair)).toEqual(["fixed"]);
      expect(afterRepair.index.byFile.get(flakyKey)?.parserDegraded).toBeUndefined();
      expect(isAnalysisComplete(afterRepair.analysis)).toBe(true);
      expect(isAnalysisComplete(await analysisInFreshSession(root))).toBe(true);
    },
  );

  it("reports an unknown backend when no native-supported file is indexed", async () => {
    const root = await createProject("cg-analysis-graph-only-", {
      "README.md": "# Readme\n\nSee [guide](docs/guide.md).\n",
      "docs/guide.md": "# Guide\n",
    });

    const cold = await build(root);
    const warm = await build(root);

    for (const stage of [cold, warm]) {
      expect(stage.analysis).toMatchObject({ backend: "unknown", nativeFilesUsed: 0, label: "semantic" });
    }
  });
});
