import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { collectGraph } from '../src/index.js';

function normEdge(e: any) {
  const toStr = (t: any) => (t.type === 'file' ? t.path : t.name);
  return { from: e.from.replace(/\\/g, '/'), to: toStr(e.to).replace(/\\/g, '/'), raw: e.raw, typeOnly: !!e.typeOnly };
}

describe('Monorepo fast graph parity', () => {
  it('fast mode matches normal mode in monorepo sample', async () => {
    const root = path.join(process.cwd(), 'tests', 'samples', 'monorepo');
    const files = [
      path.join(root, 'packages', 'pkg-a', 'src', 'index.ts').replace(/\\/g, '/'),
      path.join(root, 'packages', 'pkg-b', 'src', 'index.js').replace(/\\/g, '/'),
    ];
    const g1 = await collectGraph(root, files);
    const g2 = await (await import('../src/graphs.js')).collectGraph(root, files, { fast: true });

    const toKey = (to: unknown) => {
      const t = to as { type: 'file'; path: string } | { type: 'external'; name: string };
      return t.type === 'file' ? t.path : t.name;
    };
    const aSet = new Set(g1.edges.map(e => `${e.from}|${toKey(e.to)}|${e.raw}`));
    const bSet = new Set(g2.edges.map(e => `${e.from}|${toKey(e.to)}|${e.raw}`));
    expect(bSet).toEqual(aSet);

    // Ensure workspace package edge is resolved to a file
    const hasPkgA = g2.edges.some(e => e.raw === '@acme/pkg-a' && e.to.type === 'file');
    expect(hasPkgA).toBe(true);
  });
});


