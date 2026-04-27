import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  tool_listProjectFiles,
  tool_getGraph,
  tool_goToDefinition,
  tool_findReferences,
  tool_findSymbol,
} from '../src/agent-tools.js';

describe('Agent Tools', () => {
  const samplePath = path.resolve(process.cwd(), 'tests', 'samples', 'typescript');

  it('tool_listProjectFiles should list files', async () => {
    const result = await tool_listProjectFiles(samplePath);
    expect(result.status).toBe('ok');
    expect(result.files).toBeDefined();
    expect(result.files!.some(f => f.replace(/\\/g, '/').endsWith('main.ts'))).toBe(true);
  });

  it('tool_getGraph should return graph', async () => {
    const result = await tool_getGraph(samplePath);
    expect(result.status).toBe('ok');
    expect(result.graph).toBeDefined();
    expect(result.graph!.nodes.length).toBeGreaterThan(0);
    expect(result.graph!.edges).toBeDefined();
  });

  it('tool_getGraph accepts explicit native mode overrides', async () => {
    const result = await tool_getGraph(samplePath, { native: 'off' });
    expect(result.status).toBe('ok');
    expect(result.graph).toBeDefined();
    expect(result.graph!.nodes.length).toBeGreaterThan(0);
  });

  it('tool_goToDefinition should find definition', async () => {
    const mainFile = path.join(samplePath, 'main.ts');
    // Line 7, column 25 is helperFunction() call which is imported from utils.ts
    const result = await tool_goToDefinition(samplePath, mainFile, 7, 25);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
       expect(result.definition.file.replace(/\\/g, '/')).toContain('utils.ts');
       expect(result.definition.range.start.line).toBe(1);
    }
  });

  it('tool_findReferences should find references', async () => {
    const utilsFile = path.join(samplePath, 'utils.ts');
    // Line 1, column 17 is helperFunction definition
    const result = await tool_findReferences(samplePath, utilsFile, 1, 17);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
       expect(result.references.length).toBeGreaterThan(0);
    }
  });

  it('tool_goToDefinition handles relative paths', async () => {
    // Relative path test
    const result = await tool_goToDefinition(samplePath, 'main.ts', 7, 25);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
       expect(result.definition.file.replace(/\\/g, '/')).toContain('utils.ts');
    }
  });

  it('tool_findSymbol returns structured matches', async () => {
    const result = await tool_findSymbol(samplePath, 'helperFunction');
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches.some((match) => match.name === 'helperFunction')).toBe(true);
    }
  });

  it('tool_findSymbol returns structured errors for invalid roots', async () => {
    const result = await tool_findSymbol('Z:/definitely-missing-codegraph-root', 'helperFunction');
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toContain('Project root does not exist or is not readable');
    }
  });
});
