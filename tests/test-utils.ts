import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { buildProjectIndex, goToDefinition, findReferences, collectGraph, ProjectIndex } from '../src/index.js';

export function getSamplePath(language: 'typescript' | 'python' | 'javascript'): string {
  return path.resolve(process.cwd(), 'tests', 'samples', language);
}

export async function createTestIndex(language: 'typescript' | 'python' | 'javascript'): Promise<ProjectIndex> {
  const samplePath = getSamplePath(language);
  return await buildProjectIndex(samplePath);
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
      expect(result.definition.line).toBe(expectedLine);
    }
  } else {
    expect(result.status).toBe('not_found');
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
    expect(result.references.length).toBe(expectedCount);
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
