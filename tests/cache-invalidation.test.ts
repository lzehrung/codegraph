import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { buildProjectIndex } from '../src/index.js';

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('Cache invalidation and strict hashing', () => {
  it('non-strict (mtime+size) can miss same-size content change when mtime restored; strict detects it', async () => {
    const root = await mkTmpDir('dg-cache-inv-');
    const utilPath = path.join(root, 'util.ts');
    const v1 = `export function a(){ return 1 }\n`;
    await fsp.writeFile(utilPath, v1, 'utf8');
    const st1 = await fsp.stat(utilPath);

    const idx1 = await buildProjectIndex(root, { threads: 2, cache: 'disk' });
    const utilFile = Array.from(idx1.byFile.keys()).find(f => f.endsWith('/util.ts') || f.endsWith('\\util.ts'))!;
    const mod1 = idx1.byFile.get(utilFile)!;
    expect(mod1.locals.some(l => l.localName === 'a')).toBe(true);

    // Change content but keep length and restore mtime
    const v2 = `export function b(){ return 2 }\n`; // same length as v1
    await fsp.writeFile(utilPath, v2, 'utf8');
    await fsp.utimes(utilPath, st1.atime, st1.mtime);
    const st2 = await fsp.stat(utilPath);
    expect(st2.size).toBe(st1.size);
    // Allow small filesystem timestamp jitter (e.g., +/-1ms)
    const deltaMs = Math.abs(st2.mtimeMs - st1.mtimeMs);
    expect(deltaMs).toBeLessThan(3);

    // Non-strict: may hit cache and still see 'a' (mtime+size key), or refresh; allow either
    const idx2 = await buildProjectIndex(root, { threads: 2, cache: 'disk' });
    const mod2 = idx2.byFile.get(utilFile)!;
    const nonStrictHasA = mod2.locals.some(l => l.localName === 'a');
    const nonStrictHasB = mod2.locals.some(l => l.localName === 'b');
    expect(nonStrictHasA || nonStrictHasB).toBe(true);

    // Strict: should invalidate and pick up 'b'
    const idx3 = await buildProjectIndex(root, { threads: 2, cache: 'disk', cacheStrict: true });
    const mod3 = idx3.byFile.get(utilFile)!;
    expect(mod3.locals.some(l => l.localName === 'b')).toBe(true);
  });
});


