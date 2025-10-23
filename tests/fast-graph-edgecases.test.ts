import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { collectGraph } from '../src/index.js';

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function edgeFrom(file: string) {
  return (e: { from: string }) => e.from.replace(/\\/g, '/') === file.replace(/\\/g, '/');
}

describe('Fast graph edge cases', () => {
  it('detects type-only import with typeOnly=true (TS)', async () => {
    const root = await mkTmpDir('dg-fast-typeonly-');
    const util = `export type T = { n: number };\nexport function f(){ return 1 }\n`;
    const main = `import type { T } from './util';\nimport { f } from './util';\nconst x: T = { n: f() };\n`;
    const utilPath = path.join(root, 'util.ts');
    const mainPath = path.join(root, 'main.ts');
    await fsp.writeFile(utilPath, util, 'utf8');
    await fsp.writeFile(mainPath, main, 'utf8');
    const files = [mainPath.replace(/\\/g, '/'), utilPath.replace(/\\/g, '/')];

    const gNormal = await collectGraph(root, files);
    const gFast = await (await import('../src/graphs.js')).collectGraph(root, files, { fast: true });

    const fromMainNormal = gNormal.edges.filter(edgeFrom(mainPath));
    const fromMainFast = gFast.edges.filter(edgeFrom(mainPath));
    // At least one edge from main.ts should be marked typeOnly in both modes
    expect(fromMainNormal.some(e => e.typeOnly === true)).toBe(true);
    expect(fromMainFast.some(e => e.typeOnly === true)).toBe(true);
  });

  it('ignores commented-out imports in fast mode', async () => {
    const root = await mkTmpDir('dg-fast-comments-');
    const commented = `// import x from './x'\n/* import y from './y' */\n/*\nimport z from './z'\n*/\n`;
    const file = path.join(root, 'commented.ts');
    await fsp.writeFile(file, commented, 'utf8');
    const gFast = await (await import('../src/graphs.js')).collectGraph(root, [file.replace(/\\/g, '/')], { fast: true });
    const edgesFrom = gFast.edges.filter(edgeFrom(file));
    expect(edgesFrom.length).toBe(0);
  });
});


