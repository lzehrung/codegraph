import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import {
  buildProjectIndex,
  buildProjectIndexFromFiles,
  goToDefinition,
  findReferences,
  collectGraph,
  listSymbols,
  ProjectIndex,
  SymbolListItem,
} from "../src/index.js";

const sampleRoot = path.resolve(process.cwd(), "tests", "samples").replace(/\\/g, "/");
const sampleIndexCache = new Map<string, Promise<ProjectIndex>>();

export type SampleLanguage =
  | "typescript"
  | "tsx"
  | "python"
  | "php"
  | "javascript"
  | "c"
  | "cpp"
  | "go"
  | "java"
  | "csharp"
  | "kotlin"
  | "ruby"
  | "rust"
  | "swift"
  | "html"
  | "css"
  | "scss"
  | "less"
  | "vue"
  | "svelte";

export function getSamplePath(language: SampleLanguage): string {
  return path.resolve(process.cwd(), "tests", "samples", language);
}

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function isSamplePath(samplePath: string): boolean {
  const normalized = normalizeFilePath(path.resolve(samplePath));
  return normalized === sampleRoot || normalized.startsWith(`${sampleRoot}/`);
}

function cachedSampleIndex(key: string, build: () => Promise<ProjectIndex>): Promise<ProjectIndex> {
  const cached = sampleIndexCache.get(key);
  if (cached) return cached;
  const promise = build().catch((error: unknown) => {
    sampleIndexCache.delete(key);
    throw error;
  });
  sampleIndexCache.set(key, promise);
  return promise;
}

export async function createTestIndex(language: SampleLanguage): Promise<ProjectIndex> {
  const samplePath = getSamplePath(language);
  return await cachedSampleIndex(`root:${normalizeFilePath(samplePath)}`, async () => await buildProjectIndex(samplePath));
}

export async function createTestIndexFromPath(samplePath: string): Promise<ProjectIndex> {
  if (isSamplePath(samplePath)) {
    return await cachedSampleIndex(
      `root:${normalizeFilePath(path.resolve(samplePath))}`,
      async () => await buildProjectIndex(samplePath),
    );
  }
  return await buildProjectIndex(samplePath);
}

export async function createTestIndexFromFiles(samplePath: string, files: string[]): Promise<ProjectIndex> {
  if (isSamplePath(samplePath)) {
    const normalizedRoot = normalizeFilePath(path.resolve(samplePath));
    const normalizedFiles = files.map((file) => normalizeFilePath(path.resolve(file))).sort();
    return await cachedSampleIndex(
      `files:${normalizedRoot}:${normalizedFiles.join("\0")}`,
      async () => await buildProjectIndexFromFiles(samplePath, files),
    );
  }
  return await buildProjectIndexFromFiles(samplePath, files);
}

export function findSymbolsByName(index: ProjectIndex, name: string, file?: string): SymbolListItem[] {
  const opts = file ? { file } : undefined;
  return listSymbols(index, opts).filter((symbol) => symbol.name === name);
}

export async function testGoToDefinition(
  index: ProjectIndex,
  file: string,
  line: number,
  column: number,
  expectedFile?: string,
  expectedLine?: number,
  expectedStatus: "ok" | "not_found" = "ok",
) {
  const result = await goToDefinition(index, { file, line, column });

  expect(result.status).toBe(expectedStatus);
  if (expectedStatus === "ok" && expectedFile && expectedLine) {
    if (result.status === "ok") {
      expect(result.definition.file).toBe(expectedFile);
      expect(result.definition.range.start.line).toBe(expectedLine);
    }
  }

  return result;
}

export async function testFindReferences(
  index: ProjectIndex,
  file: string,
  line: number,
  column: number,
  expectedCount: number,
  expectedStatus: "ok" | "not_found" = "ok",
) {
  const result = await findReferences(index, { file, line, column });

  expect(result.status).toBe(expectedStatus);
  if (result.status === "ok") {
    expect(result.references.length).toBeGreaterThanOrEqual(expectedCount);
  }

  return result;
}

export function expectFileInIndex(index: ProjectIndex, expectedFile: string): void {
  const files = Array.from(index.byFile.keys());
  expect(files).toContain(expectedFile);
}

export function expectModuleCount(index: ProjectIndex, expectedCount: number): void {
  expect(index.byFile.size).toBe(expectedCount);
}

export function expectEdgeCount(index: ProjectIndex, expectedCount: number): void {
  expect(index.graph.edges.length).toBe(expectedCount);
}
