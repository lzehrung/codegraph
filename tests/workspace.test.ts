import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { buildProjectIndex, collectGraph } from '../src/index.js';

// Minimal smoke tests to validate workspace detection wiring.
// Full fixtures are created in tests/samples/monorepo in a later step.

describe('Monorepo workspace support', () => {
  it('loads workspace config and resolves cross-package imports', async () => {
    const root = path.join(process.cwd(), 'tests', 'samples', 'monorepo');
    const index = await buildProjectIndex(root);
    expect(index).toBeDefined();

    // Ensure both packages are indexed
    const files = [...index.byFile.keys()];
    const hasPkgA = files.some(f => f.includes('packages/pkg-a/src/index.ts'));
    const hasPkgB = files.some(f => f.includes('packages/pkg-b/src/index.js'));
    expect(hasPkgA && hasPkgB).toBe(true);
  });

  it('creates graph edges from pkg-b to pkg-a via workspace resolution', async () => {
    const root = path.join(process.cwd(), 'tests', 'samples', 'monorepo');
    const files = [
      path.join(root, 'packages', 'pkg-a', 'src', 'index.ts'),
      path.join(root, 'packages', 'pkg-b', 'src', 'index.js'),
    ];
    const graph = await collectGraph(root, files);
    // Assert we have an edge for the raw specifier from pkg-b to @acme/pkg-a
    const hasEdgeByRaw = graph.edges.some(e => e.raw === '@acme/pkg-a' && e.from.replace(/\\/g, '/').includes('packages/pkg-b/src/index.js'));
    expect(hasEdgeByRaw).toBe(true);
  });

  it('treats unknown packages as external while resolving workspace packages', async () => {
    const root = path.join(process.cwd(), 'tests', 'samples', 'monorepo');
    const files = [
      path.join(root, 'packages', 'pkg-a', 'src', 'index.ts'),
      path.join(root, 'packages', 'pkg-b', 'src', 'index.js'),
    ];
    const graph = await collectGraph(root, files);
    const hasPkgA = graph.edges.some(e => e.raw === '@acme/pkg-a' && e.to.type === 'file');
    const hasExternal = graph.edges.some(e => e.raw === 'not-a-package' && e.to.type === 'external' && e.to.name === 'not-a-package');
    expect(hasPkgA).toBe(true);
    expect(hasExternal).toBe(true);
  });

  it('resolves exports-based default import across packages', async () => {
    const root = path.join(process.cwd(), 'tests', 'samples', 'monorepo');
    const { buildProjectIndex, goToDefinition } = await import('../src/index.js');
    const index = await buildProjectIndex(root);
    const pkga = path.join(root, 'packages', 'pkg-a', 'src', 'index.ts');
    const pkgb = path.join(root, 'packages', 'pkg-b', 'src', 'index.js');
    const res = await goToDefinition(index, { file: pkgb.replace(/\\/g, '/'), line: 21, column: 18 });
    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      expect(res.definition.file.replace(/\\/g, '/')).toBe(pkga.replace(/\\/g, '/'));
    }
  });

  it('per-package tsconfig paths: pkg-ts-consumer local alias and cross-package import', async () => {
    const root = path.join(process.cwd(), 'tests', 'samples', 'monorepo');
    const { buildProjectIndex, goToDefinition } = await import('../src/index.js');
    const index = await buildProjectIndex(root);
    const pkga = path.join(root, 'packages', 'pkg-a', 'src', 'index.ts');
    const pkgt = path.join(root, 'packages', 'pkg-ts-consumer', 'src', 'index.ts');

    // Go to def for aHelper usage from pkg-a (line 5: return defA() + aHelper() + localUtil())
    const res1 = await goToDefinition(index, { file: pkgt.replace(/\\/g, '/'), line: 5, column: 24 });
    expect(res1.status).toBe('ok');
    if (res1.status === 'ok') {
      expect(res1.definition.file.replace(/\\/g, '/')).toBe(pkga.replace(/\\/g, '/'));
    }

    // Go to def for localUtil via @local alias (usage on line 5)
    const res2 = await goToDefinition(index, { file: pkgt.replace(/\\/g, '/'), line: 5, column: 38 });
    expect(res2.status).toBe('ok');
    if (res2.status === 'ok') {
      expect(res2.definition.file.replace(/\\/g, '/')).toContain('packages/pkg-ts-consumer/src/util.ts');
    }
  });
});


