import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { searchCodegraphWithSession } from "../src/agent/search.js";
import { createAgentSession, type AgentSession } from "../src/agent/session.js";
import { isAnalysisComplete, summarizeAnalysis, type AnalysisSummary } from "../src/analysis-summary.js";
import { buildProjectIndexIncremental, type BuildReport } from "../src/index.js";
import type { ProjectIndex } from "../src/indexer.js";
import { fileIdentityKey, normalizePath } from "../src/util/paths.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";

const roots = createTempRootRegistry();
const sessions: AgentSession[] = [];

afterEach(async () => {
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

async function build(root: string): Promise<{ analysis: AnalysisSummary; report: BuildReport; index: ProjectIndex }> {
  const report: BuildReport = { timings: {} };
  const index = await buildProjectIndexIncremental(root, { cache: "disk", threads: 1, report });
  return { analysis: summarizeAnalysis({ index, report }), report, index };
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
