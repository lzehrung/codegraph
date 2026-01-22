import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import {
  buildProjectIndex,
  buildProjectIndexFromFiles,
  goToDefinition,
  findReferences,
  collectGraph,
  listSymbols,
  ProjectIndex,
  SymbolListItem,
} from '../src/index.js';

export type SampleLanguage =
  | 'typescript'
  | 'tsx'
  | 'python'
  | 'javascript'
  | 'go'
  | 'java'
  | 'csharp'
  | 'ruby'
  | 'rust'
  | 'html'
  | 'css'
  | 'scss'
  | 'less'
  | 'vue'
  | 'svelte';

export function getSamplePath(language: SampleLanguage): string {
  return path.resolve(process.cwd(), 'tests', 'samples', language);
}

export async function createTestIndex(language: SampleLanguage): Promise<ProjectIndex> {
  const samplePath = getSamplePath(language);
  return await buildProjectIndex(samplePath);
}

export async function createTestIndexFromPath(samplePath: string): Promise<ProjectIndex> {
  return await buildProjectIndex(samplePath);
}

export async function createTestIndexFromFiles(
  samplePath: string,
  files: string[]
): Promise<ProjectIndex> {
  return await buildProjectIndexFromFiles(samplePath, files);
}

export function findSymbolsByName(
  index: ProjectIndex,
  name: string,
  file?: string
): SymbolListItem[] {
  const opts = file ? { file } : undefined;
  return listSymbols(index, opts).filter((symbol) => symbol.name === name);
}

export async function testGoToDefinition(
  index: ProjectIndex,
  file: string,
  line: number,
  column: number,
  expectedFile?: string,
  expectedLine?: number
) {
  const result = await goToDefinition(index, { file, line, column });
  
  if (expectedFile && expectedLine) {
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.definition.file).toBe(expectedFile);
      expect(result.definition.range.start.line).toBe(expectedLine);
    }
  } else {
    // If no expected values provided, just expect it to work (not fail)
    expect(result.status).toBe('ok');
  }
  
  return result;
}

export async function testFindReferences(
  index: ProjectIndex,
  file: string,
  line: number,
  column: number,
  expectedCount: number
) {
  const result = await findReferences(index, { file, line, column });
  
  expect(result.status).toBe('ok');
  if (result.status === 'ok') {
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
