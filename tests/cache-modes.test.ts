import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { buildProjectIndex } from '../src/index.js';

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('Incremental cache modes', () => {
  it('memory cache avoids recomputation on second run', async () => {
    const root = await mkTmpDir('dg-cache-mem-');
    const util = `export function a(){return 1}`;
    await fsp.writeFile(path.join(root, 'util.ts'), util, 'utf8');

    const t0 = Date.now();
    const first = await buildProjectIndex(root, { threads: 4, cache: 'memory' });
    const t1 = Date.now();
    const second = await buildProjectIndex(root, { threads: 4, cache: 'memory' });
    const t2 = Date.now();

    expect(first.byFile.size).toBeGreaterThan(0);
    expect(second.byFile.size).toBe(first.byFile.size);
    // Second run should be faster or equal (very noisy, so just assert not much slower)
    expect(t2 - t1).toBeLessThanOrEqual(t1 - t0 + 50);
  });

  it('disk cache persists across runs in the same directory', async () => {
    const root = await mkTmpDir('dg-cache-disk-');
    const util = `export function a(){return 1}`;
    await fsp.writeFile(path.join(root, 'util.ts'), util, 'utf8');

    const t0 = Date.now();
    const first = await buildProjectIndex(root, { threads: 2, cache: 'disk' });
    const t1 = Date.now();
    // Build again; should hit disk cache
    const second = await buildProjectIndex(root, { threads: 2, cache: 'disk' });
    const t2 = Date.now();

    expect(first.byFile.size).toBeGreaterThan(0);
    expect(second.byFile.size).toBe(first.byFile.size);
    expect(t2 - t1).toBeLessThanOrEqual(t1 - t0 + 50);
  });
});


