import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { collectGraph } from '../src/index.js';

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('Node modules resolution (opt-in) and path normalization', () => {
  it('treats packages as external by default; resolves to file with flag', async () => {
    const root = await mkTmpDir('dg-nm-');
    const nm = path.join(root, 'node_modules', 'my-pkg');
    await fsp.mkdir(nm, { recursive: true });
    await fsp.writeFile(path.join(nm, 'index.js'), 'module.exports = 1;\n', 'utf8');
    await fsp.writeFile(path.join(nm, 'package.json'), '{"name":"my-pkg","main":"index.js"}', 'utf8');
    const main = path.join(root, 'main.js');
    await fsp.writeFile(main, 'import "my-pkg";\n', 'utf8');
    const files = [main].map(f => f.replace(/\\/g, '/'));
    const g1 = await collectGraph(root, files);
    expect(g1.edges.some(e => e.raw === 'my-pkg' && e.to.type === 'external')).toBe(true);
    const g2 = await (await import('../src/graphs.js')).collectGraph(root, files, { resolveNodeModules: true });
    expect(g2.edges.some(e => e.raw === 'my-pkg' && e.to.type === 'file' && e.to.path.replace(/\\/g,'/').endsWith('/node_modules/my-pkg/index.js'))).toBe(true);
  });

  it('normalizes paths to forward slashes in nodes and edges', async () => {
    const root = await mkTmpDir('dg-paths-');
    const a = path.join(root, 'a.ts');
    const b = path.join(root, 'b.ts');
    await fsp.writeFile(a, 'export const x = 1;\n', 'utf8');
    await fsp.writeFile(b, 'import { x } from "./a";\n', 'utf8');
    const files = [a, b].map(f => f.replace(/\\/g, '/'));
    const g = await collectGraph(root, files);
    expect([...g.nodes].every(n => !/\\/.test(n))).toBe(true);
    expect(g.edges.every(e => !/\\/.test(e.from) && (e.to.type === 'external' || !/\\/.test((e.to as any).path)))).toBe(true);
  });
});


