import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import {
  buildProjectIndex,
  buildGraphDelta,
} from '../src/index.js';

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function hasFileEdge(
  edges: Array<{ from: string; to: { type: string; path?: string }; raw: string }>,
  from: string,
  toPath: string,
  raw: string,
): boolean {
  return edges.some(
    (edge) =>
      edge.from === from &&
      edge.to.type === 'file' &&
      edge.to.path === toPath &&
      edge.raw === raw,
  );
}

describe('Graph delta export', () => {
  it('reports added and removed edges for changed files', async () => {
    const root = await mkTmpDir('dg-graph-delta-');
    const aPath = path.join(root, 'a.ts');
    const bPath = path.join(root, 'b.ts');
    const cPath = path.join(root, 'c.ts');

    await fsp.writeFile(aPath, `import './b';\n`, 'utf8');
    await fsp.writeFile(bPath, `export const b = 1;\n`, 'utf8');

    await buildProjectIndex(root, { cache: 'disk', threads: 2 });

    await fsp.writeFile(aPath, `import './c';\n`, 'utf8');
    await fsp.writeFile(cPath, `export const c = 2;\n`, 'utf8');

    const delta = await buildGraphDelta(root, {
      cache: 'disk',
      threads: 2,
      files: [aPath],
    });

    expect(delta.changedFiles).toContain('a.ts');
    expect(
      hasFileEdge(delta.added, 'a.ts', 'c.ts', './c'),
    ).toBe(true);
    expect(
      hasFileEdge(delta.removed, 'a.ts', 'b.ts', './b'),
    ).toBe(true);
  });
});
