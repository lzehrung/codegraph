import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { buildProjectIndex } from '../src/index.js';

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('Incremental cache modes', () => {
  const normalize = (p: string) => p.replace(/\\/g, '/');
  const cacheFilePathFor = (projectRoot: string, fileAbs: string): string => {
    const hash = crypto
      .createHash('sha1')
      .update(normalize(fileAbs))
      .digest('hex');
    return path.join(projectRoot, '.codegraph-cache', 'index-v1', `${hash}.json`);
  };

  it('memory cache avoids recomputation on second run', async () => {
    const root = await mkTmpDir('dg-cache-mem-');
    const util = `export function a(){return 1}`;
    const utilPath = path.join(root, 'util.ts');
    await fsp.writeFile(utilPath, util, 'utf8');

    const first = await buildProjectIndex(root, { threads: 4, cache: 'memory' });
    const second = await buildProjectIndex(root, { threads: 4, cache: 'memory' });

    expect(first.byFile.size).toBeGreaterThan(0);
    expect(second.byFile.size).toBe(first.byFile.size);

    const fileId = normalize(path.resolve(utilPath));
    const firstMod = first.byFile.get(fileId);
    const secondMod = second.byFile.get(fileId);
    expect(firstMod).toBeDefined();
    expect(secondMod).toBeDefined();
    // Memory cache should reuse the same ModuleIndex object instance.
    expect(secondMod).toBe(firstMod);

    // Memory cache should not create per-file module cache files on disk.
    const cacheFile = cacheFilePathFor(root, fileId);
    expect(fs.existsSync(cacheFile)).toBe(false);
  });

  it('disk cache persists across runs in the same directory', async () => {
    const root = await mkTmpDir('dg-cache-disk-');
    const util = `export function a(){return 1}`;
    const utilPath = path.join(root, 'util.ts');
    await fsp.writeFile(utilPath, util, 'utf8');

    const first = await buildProjectIndex(root, { threads: 2, cache: 'disk' });
    const fileId = normalize(path.resolve(utilPath));
    const cacheFile = cacheFilePathFor(root, fileId);
    expect(first.byFile.size).toBeGreaterThan(0);
    expect(fs.existsSync(cacheFile)).toBe(true);

    const raw = await fsp.readFile(cacheFile, 'utf8');
    const parsed = JSON.parse(raw) as {
      version: number;
      sig: string;
      mod: { file: string };
    };
    expect(parsed.version).toBe(1);
    expect(typeof parsed.sig).toBe('string');
    expect(typeof parsed.mod?.file).toBe('string');

    // Build again; should hit disk cache file
    const second = await buildProjectIndex(root, { threads: 2, cache: 'disk' });
    expect(second.byFile.size).toBe(first.byFile.size);
    expect(fs.existsSync(cacheFile)).toBe(true);
    expect(second.byFile.get(fileId)?.file).toBe(fileId);
  });
});

