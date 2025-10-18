import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createTestIndex } from './test-utils.js';
import { buildSymbolGraph } from '../src/index.js';

function norm(p: string) { return p.replace(/\\/g, '/'); }

describe('Symbol-level graph', () => {
  describe('TypeScript', () => {
    it('creates edges from named imports to definitions', async () => {
      const index = await createTestIndex('typescript');
      const sg = await buildSymbolGraph(index);

      const nodes = [...sg.nodes.values()].map(n => ({ ...n, file: norm(n.file) }));
      const utilsDef = nodes.find(n => n.file.endsWith('/tests/samples/typescript/utils.ts') && n.name === 'helperFunction');
      expect(utilsDef).toBeDefined();

      const mainImport = nodes.find(n => n.file.endsWith('/tests/samples/typescript/main.ts') && (n.name === 'helperFunction' || n.name === 'helperAlias') && (n as any).kind === 'import');
      expect(mainImport).toBeDefined();

      const hasEdge = sg.edges.some(e => e.from === (mainImport as any).id && e.to === (utilsDef as any).id && e.label === 'helperFunction');
      expect(hasEdge).toBe(true);
    });

    it('creates edges from namespace imports for used members', async () => {
      const index = await createTestIndex('typescript');
      const sg = await buildSymbolGraph(index);

      const nodes = [...sg.nodes.values()].map(n => ({ ...n, file: norm(n.file) }));
      const utilsNs = nodes.find(n => n.file.endsWith('/tests/samples/typescript/main.ts') && n.name === 'utils' && (n as any).kind === 'namespaceImport');
      expect(utilsNs).toBeDefined();

      const helperDef = nodes.find(n => n.file.endsWith('/tests/samples/typescript/utils.ts') && n.name === 'helperFunction');
      expect(helperDef).toBeDefined();

      const nsEdge = sg.edges.find(e => e.from === (utilsNs as any).id && e.to === (helperDef as any).id && e.label === 'helperFunction');
      expect(nsEdge).toBeDefined();
    });
  });

  describe('Python', () => {
    it('creates edges for named and namespace imports', async () => {
      const index = await createTestIndex('python');
      const sg = await buildSymbolGraph(index);
      const nodes = [...sg.nodes.values()].map(n => ({ ...n, file: norm(n.file) }));

      const def = nodes.find(n => n.file.endsWith('/tests/samples/python/utils.py') && n.name === 'helper_function');
      expect(def).toBeDefined();

      const namedImport = nodes.find(n => n.file.endsWith('/tests/samples/python/main.py') && n.name === 'helper_function' && (n as any).kind === 'import');
      expect(namedImport).toBeDefined();
      const namedEdge = sg.edges.some(e => e.from === (namedImport as any).id && e.to === (def as any).id && e.label === 'helper_function');
      expect(namedEdge).toBe(true);

      const nsImport = nodes.find(n => n.file.endsWith('/tests/samples/python/main.py') && n.name === 'utils' && (n as any).kind === 'namespaceImport');
      expect(nsImport).toBeDefined();
      const nsEdge = sg.edges.find(e => e.from === (nsImport as any).id && e.to === (def as any).id && e.label === 'helper_function');
      expect(nsEdge).toBeDefined();
    });
  });
});


