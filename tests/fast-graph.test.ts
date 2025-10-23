import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { collectGraph } from '../src/index.js';
import { getSamplePath } from './test-utils.js';

function normEdge(e: any) {
  const toStr = (t: any) => (t.type === 'file' ? t.path : t.name);
  return { from: e.from.replace(/\\/g, '/'), to: toStr(e.to).replace(/\\/g, '/'), raw: e.raw, typeOnly: !!e.typeOnly };
}

describe('Fast graph specifier extraction (--fast-graph)', () => {
  it('matches regular graph edges for TypeScript samples', async () => {
    const root = getSamplePath('typescript');
    const files = [
      path.join(root, 'main.ts').replace(/\\/g, '/'),
      path.join(root, 'utils.ts').replace(/\\/g, '/'),
      path.join(root, 'helpers.ts').replace(/\\/g, '/'),
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
  });

  it('matches regular graph edges for JavaScript samples', async () => {
    const root = getSamplePath('javascript');
    const files = [
      path.join(root, 'main.js').replace(/\\/g, '/'),
      path.join(root, 'utils.js').replace(/\\/g, '/'),
      path.join(root, 'helpers.js').replace(/\\/g, '/'),
      path.join(root, 'legacy.js').replace(/\\/g, '/'),
      path.join(root, 'mixed.js').replace(/\\/g, '/'),
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
  });
});


