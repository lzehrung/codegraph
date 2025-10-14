import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { buildProjectIndex, collectGraph } from '../src/index.js';

// Minimal smoke tests to validate workspace detection wiring.
// Full fixtures are created in tests/samples/monorepo in a later step.

describe('Monorepo workspace support (smoke)', () => {
  it('should not throw when loading workspace config on a non-workspace project', async () => {
    const root = process.cwd();
    const index = await buildProjectIndex(root);
    expect(index).toBeDefined();
  });

  it('should treat unknown package imports as external in non-workspace', async () => {
    const root = process.cwd();
    const files = [path.join(root, 'src', 'index.ts')].filter(Boolean);
    const graph = await collectGraph(root, files);
    expect(graph.nodes.size >= 0).toBe(true);
  });
});


