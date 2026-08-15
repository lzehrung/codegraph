import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { workspaceSymbolsInSnapshot } from "../src/agent/workspaceSymbols.js";
import { resolveSemanticSymbol } from "../src/agent/semanticSymbols.js";
import { tool_workspaceSymbols } from "../src/agent-tools.js";
import { buildProjectIndexFromFiles } from "../src/indexer/build-index.js";
import { workspaceSymbols } from "../src/indexer/workspace-symbols.js";
import { SymbolKind, type ProjectIndex } from "../src/indexer/types.js";
import type { AgentProjectSnapshot, AgentSession } from "../src/agent/session.js";
import {
  fileIdentityKey,
  isFileIdentityCaseInsensitive,
  resetFileIdentityCaseSensitivityForTests,
} from "../src/util/paths.js";
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
  const surfaceSourceDir = path.join(root, "zsrc");
  const testDir = path.join(root, "tests");
  const uppercaseTestDir = path.join(root, "TESTS");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(surfaceSourceDir, { recursive: true });
  await fs.mkdir(testDir, { recursive: true });
  await fs.mkdir(uppercaseTestDir, { recursive: true });
  const serviceFile = path.join(sourceDir, "service.ts");
  const otherFile = path.join(sourceDir, "other.ts");
  const importerFile = path.join(sourceDir, "importer.ts");
  const namespaceFile = path.join(sourceDir, "namespace.ts");
  const shadowFile = path.join(sourceDir, "shadow.ts");
  const sqlFile = path.join(root, "schema.sql");
  const testFile = path.join(testDir, "service.test.ts");
  const surfaceFile = path.join(surfaceSourceDir, "surface.ts");
  const uppercaseTestFile = path.join(uppercaseTestDir, "surface.ts");
  const unicodeFirstFile = path.join(sourceDir, "\u00e4.ts");
  const unicodeSecondFile = path.join(sourceDir, "\u00e5.ts");
  await fs.writeFile(
    serviceFile,
    [
      "export class Service {}",
      "export function buildReviewReport() { return 'report'; }",
      "export function IndexSummary() { return 'index'; }",
      "export const reviewReportText = 'review report';",
      "function internalHelper() { return 1; }",
      "export interface ReviewContract { run(): void; }",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    otherFile,
    "export class Service {}\nexport function serviceFactory() { return new Service(); }\n",
  );
  await fs.writeFile(
    importerFile,
    "import { Service as LocalService } from './service.js';\nexport function useService() { return LocalService; }\n",
  );
  await fs.writeFile(namespaceFile, "import * as ServiceAPI from './service.js';\nexport { ServiceAPI };\n");
  await fs.writeFile(
    shadowFile,
    [
      "export function outer() {",
      "  const scopedValue = 1;",
      "  function inner() {",
      "    const scopedValue = 2;",
      "    return scopedValue;",
      "  }",
      "  return scopedValue + inner();",
      "}",
    ].join("\n"),
  );
  await fs.writeFile(surfaceFile, "export function SurfaceTie() { return 'source'; }\n");
  await fs.writeFile(uppercaseTestFile, "export function SurfaceTie() { return 'test'; }\n");
  await fs.writeFile(unicodeFirstFile, "export function UnicodeTie() { return 'first'; }\n");
  await fs.writeFile(unicodeSecondFile, "export function UnicodeTie() { return 'second'; }\n");
  await fs.writeFile(sqlFile, "CREATE TABLE workspace_audit (id INTEGER PRIMARY KEY);\n");
  await fs.writeFile(testFile, "export class ServiceTest {}\nexport function IndexSummary() { return 'test'; }\n");
  files = [
    serviceFile,
    otherFile,
    importerFile,
    namespaceFile,
    shadowFile,
    sqlFile,
    testFile,
    surfaceFile,
    uppercaseTestFile,
    unicodeFirstFile,
    unicodeSecondFile,
  ];
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

  it("keeps matching and ranking stable when the host locale has different casing rules", async () => {
    const originalToLocaleLowerCase = String.prototype.toLocaleLowerCase;
    const localeSpy = vi.spyOn(String.prototype, "toLocaleLowerCase").mockImplementation(function (this: string) {
      return originalToLocaleLowerCase.call(this, "tr");
    });
    try {
      const insensitive = await workspaceSymbols(index, { query: "indexsummary" });
      expect(insensitive.symbols.map((symbol) => symbol.file)).toEqual(["src/service.ts", "tests/service.test.ts"]);

      const tokenized = await workspaceSymbols(index, { query: "index summary" });
      expect(tokenized.symbols.map((symbol) => symbol.file)).toEqual(["src/service.ts", "tests/service.test.ts"]);
    } finally {
      localeSpy.mockRestore();
    }
  });

  it("classifies file surfaces independently of locale-sensitive casing", async () => {
    const localeSpy = vi.spyOn(String.prototype, "toLocaleLowerCase").mockImplementation(function (this: string) {
      return this.toString();
    });
    try {
      const result = await workspaceSymbols(index, { query: "SurfaceTie" });
      expect(result.symbols.map((symbol) => symbol.file)).toEqual(["zsrc/surface.ts", "TESTS/surface.ts"]);
    } finally {
      localeSpy.mockRestore();
    }
  });

  it("orders tied Unicode file paths by deterministic code units", async () => {
    const localeCompareSpy = vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (
      this: string,
      other: string,
    ) {
      const left = this.toString();
      if (left < other) return 1;
      if (left > other) return -1;
      return 0;
    });
    try {
      const result = await workspaceSymbols(index, { query: "UnicodeTie" });
      expect(result.symbols.map((symbol) => symbol.file)).toEqual(["src/\u00e4.ts", "src/\u00e5.ts"]);
    } finally {
      localeCompareSpy.mockRestore();
    }
  });

  it("excludes import aliases by default and includes them explicitly", async () => {
    const defaultResult = await workspaceSymbols(index, { query: "LocalService" });
    expect(defaultResult.symbols).toEqual([]);

    const withImports = await workspaceSymbols(index, { query: "LocalService", includeImports: true });
    expect(withImports.symbols).toHaveLength(1);
    expect(withImports.symbols[0]).toMatchObject({ name: "LocalService", imported: true, exported: false });
    const withKindFilter = await workspaceSymbols(index, {
      query: "LocalService",
      kinds: [SymbolKind.Class],
      includeImports: true,
    });
    expect(withKindFilter.symbols).toHaveLength(1);
    expect(withKindFilter.symbols[0]).toMatchObject({
      name: "LocalService",
      kind: SymbolKind.Class,
      imported: true,
    });
    const mismatchedKind = await workspaceSymbols(index, {
      query: "LocalService",
      kinds: [SymbolKind.Function],
      includeImports: true,
    });
    expect(mismatchedKind.symbols).toEqual([]);
  });

  it("reports namespace imports as unsupported omissions rather than returning stale handles", async () => {
    const result = await workspaceSymbols(index, { query: "ServiceAPI", includeImports: true });
    expect(result.symbols).toEqual([]);
    expect(result.omittedImports).toBeGreaterThan(0);
  });

  it("keeps shadowed locals distinct and exposes only SQL objects modeled as SymbolDef", async () => {
    const shadowed = await workspaceSymbolsInSnapshot(snapshot, { query: "scopedValue" });
    expect(shadowed.symbols).toHaveLength(2);
    expect(new Set(shadowed.symbols.map((symbol) => symbol.handle)).size).toBe(2);
    expect(shadowed.symbols.map((symbol) => symbol.location.range.start.line)).toEqual([2, 4]);

    const sql = await workspaceSymbolsInSnapshot(snapshot, { query: "workspace_audit" });
    expect(sql.symbols).toHaveLength(1);
    expect(sql.symbols[0]).toMatchObject({ name: "workspace_audit", kind: "table" });
    expect(resolveSemanticSymbol(snapshot, sql.symbols[0]!.handle)?.def).toMatchObject({
      localName: "workspace_audit",
      kind: "table",
    });
  });
  it("returns import aliases at their binding location with handles for the imported definition", async () => {
    const response = await workspaceSymbolsInSnapshot(snapshot, {
      query: "LocalService",
      includeImports: true,
    });
    expect(response.symbols).toHaveLength(1);
    const alias = response.symbols[0]!;
    expect(alias).toMatchObject({
      name: "LocalService",
      location: { file: "src/importer.ts" },
    });
    const resolved = resolveSemanticSymbol(snapshot, alias.handle);
    expect(resolved?.def.localName).toBe("Service");
    expect(resolved?.def.file.replace(/\\/g, "/")).toMatch(/\/src\/service\.ts$/);
  });

  it("keeps import symbol paths display-cased when identity keys are lowercased", async () => {
    const originalCaseSensitivity = isFileIdentityCaseInsensitive();
    const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-workspace-symbols-case-"));
    try {
      const sourceDir = path.join(isolatedRoot, "Src");
      const targetFile = path.join(sourceDir, "Service.ts");
      const importerFile = path.join(sourceDir, "Importer.ts");
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(targetFile, "export class Service {}\n");
      await fs.writeFile(
        importerFile,
        "import { Service as LocalService } from './Service';\nexport function useService() { return LocalService; }\n",
      );
      const built = await buildProjectIndexFromFiles(isolatedRoot, [targetFile, importerFile], {
        cache: "off",
        keepParsed: true,
      });

      resetFileIdentityCaseSensitivityForTests(true);
      const byFile = new Map(
        Array.from(built.byFile.values(), (moduleIndex) => [fileIdentityKey(moduleIndex.file), moduleIndex] as const),
      );
      const isolatedIndex: ProjectIndex = {
        ...built,
        modules: byFile,
        byFile,
      };
      const result = await workspaceSymbols(isolatedIndex, { query: "LocalService", includeImports: true });

      expect(result.symbols[0]?.file).toBe("Src/Importer.ts");
      expect(result.symbols[0]?.id).toContain("Src/Importer.ts");
      expect(result.symbols[0]?.file).not.toContain("src/importer.ts");
    } finally {
      resetFileIdentityCaseSensitivityForTests(originalCaseSensitivity);
      await fs.rm(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("reports failed import scans and omitted aliases instead of silently dropping them", async () => {
    const importerEntry = [...index.byFile.entries()].find(([file]) => file.endsWith("/src/importer.ts"));
    expect(importerEntry).toBeDefined();
    const missingFile = path.join(root, "src", "missing.ts");
    const byFile = new Map(index.byFile);
    const missingModule = { ...importerEntry![1], file: missingFile };
    byFile.set(fileIdentityKey(missingFile), missingModule);
    const failingIndex: ProjectIndex = {
      ...index,
      modules: new Map(byFile),
      byFile,
      parsed: new Map(index.parsed),
      exportCache: new Map(),
      scopeCache: new Map(),
    };
    const result = await workspaceSymbols(failingIndex, { query: "LocalService", includeImports: true });

    expect(result.importScanFailures).toBe(1);
    expect(result.omittedImports).toBeGreaterThan(0);

    const response = await workspaceSymbolsInSnapshot(
      { ...snapshot, index: failingIndex },
      { query: "LocalService", includeImports: true },
    );
    expect(response.omittedCounts).toMatchObject({
      imports: expect.any(Number),
      importScanFailures: 1,
    });
    expect(response.omittedCounts.imports).toBeGreaterThan(0);
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
  it("pins omission counts at and just past the limit for workspace symbols", async () => {
    const all = await workspaceSymbols(index, { query: "Service", limit: 50 });
    const total = all.symbols.length;
    expect(total).toBeGreaterThanOrEqual(2);
    expect(all.omitted).toBe(0);

    const atLimit = await workspaceSymbols(index, { query: "Service", limit: total });
    expect(atLimit.symbols).toHaveLength(total);
    expect(atLimit.omitted).toBe(0);

    const pastLimit = await workspaceSymbols(index, { query: "Service", limit: total - 1 });
    expect(pastLimit.symbols).toHaveLength(total - 1);
    expect(pastLimit.omitted).toBe(1);
  });
});
