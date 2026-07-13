import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { workspaceSymbolsInSnapshot } from "../src/agent/workspaceSymbols.js";
import { tool_workspaceSymbols } from "../src/agent-tools.js";
import { buildProjectIndexFromFiles } from "../src/indexer/build-index.js";
import { workspaceSymbols } from "../src/indexer/workspace-symbols.js";
import { SymbolKind, type ProjectIndex } from "../src/indexer/types.js";
import type { AgentProjectSnapshot, AgentSession } from "../src/agent/session.js";

const SEMANTIC_ANALYSIS = {
  mode: "semantic" as const,
  backend: "unknown" as const,
  parserDegradedFiles: 0,
  fallbackImportExtractionFiles: 0,
  nativeFilesUsed: 0,
  nativeFilesFellBack: 0,
  label: "semantic",
};

let root = "";
let index: ProjectIndex;
let files: string[] = [];
let snapshot: AgentProjectSnapshot;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-workspace-symbols-"));
  const sourceDir = path.join(root, "src");
  const testDir = path.join(root, "tests");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(testDir, { recursive: true });
  const serviceFile = path.join(sourceDir, "service.ts");
  const otherFile = path.join(sourceDir, "other.ts");
  const importerFile = path.join(sourceDir, "importer.ts");
  const testFile = path.join(testDir, "service.test.ts");
  await fs.writeFile(
    serviceFile,
    [
      "export class Service {}",
      "export function buildReviewReport() { return 'report'; }",
      "export const reviewReportText = 'review report';",
      "function internalHelper() { return 1; }",
      "export interface ReviewContract { run(): void; }",
      "",
    ].join("\n"),
  );
  await fs.writeFile(otherFile, "export class Service {}\nexport function serviceFactory() { return new Service(); }\n");
  await fs.writeFile(
    importerFile,
    "import { Service as LocalService } from './service.js';\nexport function useService() { return LocalService; }\n",
  );
  await fs.writeFile(testFile, "export class ServiceTest {}\n");
  files = [serviceFile, otherFile, importerFile, testFile];
  index = await buildProjectIndexFromFiles(root, files, { cache: "off", keepParsed: true });
  snapshot = {
    root,
    files,
    index,
    fileGraph: index.graph,
    symbolGraph: { nodes: new Map(), edges: [] },
    analysis: SEMANTIC_ANALYSIS,
  };
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("workspace symbol lookup", () => {
  it("ranks exact and qualified identities ahead of token and prefix matches", async () => {
    const exact = await workspaceSymbols(index, { query: "Service" });
    expect(exact.symbols[0]?.name).toBe("Service");
    expect(exact.symbols[1]?.name).toBe("Service");
    expect(exact.symbols.findIndex((symbol) => symbol.name === "ServiceTest")).toBeGreaterThan(1);

    const qualified = await workspaceSymbols(index, { query: "src/other.ts::Service" });
    expect(qualified.symbols[0]).toMatchObject({ file: "src/other.ts", name: "Service" });

    const tokenized = await workspaceSymbols(index, { query: "review report" });
    expect(tokenized.symbols[0]?.name).toBe("buildReviewReport");
  });

  it("excludes import aliases by default and includes them explicitly", async () => {
    const defaultResult = await workspaceSymbols(index, { query: "LocalService" });
    expect(defaultResult.symbols).toEqual([]);

    const withImports = await workspaceSymbols(index, { query: "LocalService", includeImports: true });
    expect(withImports.symbols).toHaveLength(1);
    expect(withImports.symbols[0]).toMatchObject({ name: "LocalService", imported: true, exported: false });
  });

  it("composes exported, kind, and file-glob filters", async () => {
    const result = await workspaceSymbols(index, {
      query: "",
      kinds: [SymbolKind.Class],
      exportedOnly: true,
      fileGlob: "src/other.ts",
    });

    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]).toMatchObject({ name: "Service", kind: SymbolKind.Class, exported: true });
  });

  it("applies limits after ranking and reports omissions", async () => {
    const result = await workspaceSymbols(index, { query: "Service", limit: 1 });

    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]?.name).toBe("Service");
    expect(result.totalCandidates).toBeGreaterThan(1);
    expect(result.omitted).toBe(result.totalCandidates - 1);
  });

  it("returns deterministic project-relative public symbols with portable handles", async () => {
    const first = await workspaceSymbolsInSnapshot(snapshot, { query: "Service", limit: 10 });
    const second = await workspaceSymbolsInSnapshot(snapshot, { query: "Service", limit: 10 });

    expect(second.symbols).toEqual(first.symbols);
    expect(first.symbols.length).toBeGreaterThan(1);
    for (const symbol of first.symbols) {
      expect(path.isAbsolute(symbol.location.file)).toBe(false);
      expect(symbol.handle).toMatch(/^symbol:/);
      expect(symbol.location.range.start.line).toBeGreaterThan(0);
      expect(symbol.provenance).toMatchObject({ capability: "semantic", confidence: "high" });
    }
  });

  it("labels provenance conservatively for reduced analysis", async () => {
    const reducedSnapshot: AgentProjectSnapshot = {
      ...snapshot,
      analysis: { ...SEMANTIC_ANALYSIS, mode: "reduced", label: "reduced-index" },
    };
    const response = await workspaceSymbolsInSnapshot(reducedSnapshot, { query: "Service", limit: 1 });

    expect(response.symbols[0]?.provenance).toMatchObject({
      capability: "graph",
      backend: "unknown",
      confidence: "medium",
      reason: "reduced-index",
    });
  });

  it("lets the agent-tool wrapper reuse a caller-owned session", async () => {
    const loadProject = vi.fn(async () => snapshot);
    const session: AgentSession = {
      root,
      loadProject,
      checkFreshness: async () => ({ state: "fresh" }),
      invalidate: () => undefined,
    };

    const response = await tool_workspaceSymbols(
      root,
      { query: "Service", kinds: [SymbolKind.Class], limit: 1 },
      { session },
    );

    expect(loadProject).toHaveBeenCalledWith({ symbolGraph: "skip" });
    expect(response.symbols[0]).toMatchObject({
      name: "Service",
      kind: "class",
      location: { file: "src/other.ts" },
    });
    await expect(
      tool_workspaceSymbols(root, { query: "Service" }, { session, buildOptions: { cache: "off" } }),
    ).rejects.toThrow("cannot combine a prebuilt session with buildOptions");
  });
});
