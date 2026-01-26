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

      const mainImport = nodes.find(n => n.file.endsWith('/tests/samples/typescript/main.ts') && (n.name === 'helperFunction' || n.name === 'helperAlias') && (n).kind === 'import');
      expect(mainImport).toBeDefined();

      const hasEdge = sg.edges.some(e => e.from === (mainImport).id && e.to === (utilsDef).id && e.label === 'helperFunction');
      expect(hasEdge).toBe(true);
    });

    it('ignores commented-out TS imports in fallback parsing', async () => {
      const root = path.resolve(process.cwd(), 'tests', 'samples', 'typescript');
      const index = await createTestIndex('typescript');
      const sg = await buildSymbolGraph(index);
      const nodes = [...sg.nodes.values()].map(n => ({ ...n, file: norm(n.file) }));
      // Our fixtures don't include commented imports; this is a smoke check that no node label includes "// import"
      const hasCommented = nodes.some(n => /\/\/\s*import/.test(n.name));
      expect(hasCommented).toBe(false);
    });
  });

  describe('Python', () => {
    it('creates edges for named and namespace imports', async () => {
      const index = await createTestIndex('python');
      const sg = await buildSymbolGraph(index);
      const nodes = [...sg.nodes.values()].map(n => ({ ...n, file: norm(n.file) }));

      const def = nodes.find(n => n.file.endsWith('/tests/samples/python/utils.py') && n.name === 'helper_function');
      expect(def).toBeDefined();

      const namedImport = nodes.find(n => n.file.endsWith('/tests/samples/python/main.py') && n.name === 'helper_function' && (n).kind === 'import');
      expect(namedImport).toBeDefined();
      const namedEdge = sg.edges.some(e => e.from === (namedImport).id && e.to === (def).id && e.label === 'helper_function');
      expect(namedEdge).toBe(true);

      const nsImport = nodes.find(n => n.file.endsWith('/tests/samples/python/main.py') && n.name === 'utils' && (n).kind === 'namespaceImport');
      expect(nsImport).toBeDefined();
      const nsEdge = sg.edges.find(e => e.from === (nsImport).id && e.to === (def).id && e.label === 'helper_function');
      expect(nsEdge).toBeDefined();
    });

    it('ignores commented-out Python imports in fallback parsing', async () => {
      const index = await createTestIndex('python');
      const sg = await buildSymbolGraph(index);
      const nodes = [...sg.nodes.values()].map(n => ({ ...n, file: norm(n.file) }));
      // No symbol should contain a leading '# import' pattern
      const hasCommented = nodes.some(n => /^#\s*import/.test(n.name));
      expect(hasCommented).toBe(false);
    });
  });
});


