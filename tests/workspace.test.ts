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
});


