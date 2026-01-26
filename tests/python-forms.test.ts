import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { collectGraph, buildProjectIndex, resolveExport } from '../src/index.js';

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('Python import and __all__ forms', () => {
  it('parses multiline from-import and resolves package edge', async () => {
    const root = await mkTmpDir('dg-py-forms-');
    const pkgDir = path.join(root, 'pkg');
    await fsp.mkdir(pkgDir);
    await fsp.writeFile(path.join(pkgDir, '__init__.py'), '# pkg\n', 'utf8');
    await fsp.writeFile(path.join(root, 'main.py'), "from pkg import (\n  __name__,\n)\n", 'utf8');
    const files = [path.join(root, 'main.py').replace(/\\/g, '/'), path.join(pkgDir, '__init__.py').replace(/\\/g, '/')];
    const g = await collectGraph(root, files);
    expect(g.edges.length).toBeGreaterThan(0);
    expect(g.edges.some(e => e.from.endsWith('/main.py') && e.to.type === 'file' && e.to.path.replace(/\\/g,'/').includes('/pkg/__init__.py'))).toBe(true);
  });

  it('__all__ supports tuples, multiline, concatenations', async () => {
    const root = await mkTmpDir('dg-py-all-');
    const mod = path.join(root, 'm.py');
    await fsp.writeFile(mod, [
      'def a():\n  return 1',
      'def b():\n  return 2',
      "__all__ = (\n  'a',\n) + ['b']\n",
    ].join('\n\n'), 'utf8');
    const index = await buildProjectIndex(root);
    const mfile = mod.replace(/\\/g, '/');
    const aHit = resolveExport(index, mfile, 'a');
    const bHit = resolveExport(index, mfile, 'b');
    expect(aHit && bHit).not.toBeNull();
  });
});


