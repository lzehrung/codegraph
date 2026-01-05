import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
} from '../src/index.js';
import { collectGraph } from '../src/graphs.js';
import { getGitBlobHash } from '../src/util.js';
import * as filePrep from '../src/languages/filePrep.js';

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

function cacheFileFor(root: string, file: string): string {
  const normalized = normalize(file);
  const hash = createHash('sha1').update(normalized).digest('hex');
  return path.join(root, '.codegraph-cache', 'index-v1', `${hash}.json`);
}

async function readManifest(root: string) {
  const mf = path.join(root, '.codegraph-cache', 'index-v1', 'manifest.json');
  const raw = await fsp.readFile(mf, 'utf8');
  return JSON.parse(raw);
}

function runGit(root: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

describe('Cache invalidation and strict hashing', () => {
  it('non-strict (mtime+size) can miss same-size content change when mtime restored; strict detects it', async () => {
    const root = await mkTmpDir('dg-cache-inv-');
    const utilPath = path.join(root, 'util.ts');
    const v1 = `export function a(){ return 1 }\n`;
    await fsp.writeFile(utilPath, v1, 'utf8');
    const st1 = await fsp.stat(utilPath);

    const idx1 = await buildProjectIndex(root, { threads: 2, cache: 'disk' });
    const utilFile = Array.from(idx1.byFile.keys()).find(
      (f) => f.endsWith('/util.ts') || f.endsWith('\\util.ts')
    )!;
    const mod1 = idx1.byFile.get(utilFile)!;
    expect(mod1.locals.some((l) => l.localName === 'a')).toBe(true);

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
    const nonStrictHasA = mod2.locals.some((l) => l.localName === 'a');
    const nonStrictHasB = mod2.locals.some((l) => l.localName === 'b');
    expect(nonStrictHasA || nonStrictHasB).toBe(true);

    // Strict: should invalidate and pick up 'b'
    const idx3 = await buildProjectIndex(root, {
      threads: 2,
      cache: 'disk',
      cacheStrict: true,
    });
    const mod3 = idx3.byFile.get(utilFile)!;
    expect(mod3.locals.some((l) => l.localName === 'b')).toBe(true);
  });

  it('supports incremental rebuilds with manifest reuse', async () => {
    const root = await mkTmpDir('dg-incremental-');
    const filePath = path.join(root, 'foo.ts');
    await fsp.writeFile(filePath, `export const a = 1;\n`, 'utf8');

    await buildProjectIndex(root, { threads: 2, cache: 'disk' });
    const cacheFile = cacheFileFor(root, filePath);
    expect(fs.existsSync(cacheFile)).toBe(true);

    const before = await fsp.stat(cacheFile);
    const idxNoChange = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: 'disk',
    });
    const after = await fsp.stat(cacheFile);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    const modA = idxNoChange.byFile.get(normalize(filePath))!;
    expect(modA.locals.some((l) => l.localName === 'a')).toBe(true);

    await fsp.writeFile(filePath, `export const b = 2;\n`, 'utf8');
    const beforeChange = await fsp.stat(cacheFile);
    const idxChanged = await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: 'disk',
    });
    const afterChange = await fsp.stat(cacheFile);
    expect(afterChange.mtimeMs).toBeGreaterThan(beforeChange.mtimeMs);
    const modB = idxChanged.byFile.get(normalize(filePath))!;
    expect(modB.locals.some((l) => l.localName === 'b')).toBe(true);

    await buildProjectIndexIncremental(root, {
      threads: 2,
      cache: 'disk',
      graph: { fast: true },
    });
    const manifest = await readManifest(root);
    expect(manifest.graphOptions.fast).toBe(true);
  });

  it('stores git signatures for tracked files and reuses cached edges by git hash', async () => {
    const root = await mkTmpDir('dg-git-sig-');
    runGit(root, ['init']);
    runGit(root, ['config', 'user.email', 'cache@test.local']);
    runGit(root, ['config', 'user.name', 'Cache Test']);

    const trackedPath = path.join(root, 'tracked.ts');
    const depPath = path.join(root, 'dep.ts');
    const untrackedPath = path.join(root, 'untracked.ts');
    await fsp.writeFile(trackedPath, `import './dep';\n`, 'utf8');
    await fsp.writeFile(depPath, `export const dep = 1;\n`, 'utf8');
    await fsp.writeFile(untrackedPath, `export const scratch = 2;\n`, 'utf8');

    runGit(root, ['add', 'tracked.ts', 'dep.ts']);
    runGit(root, ['commit', '-m', 'init']);

    await buildProjectIndex(root, { threads: 2, cache: 'disk' });
    const manifest = await readManifest(root);
    const trackedEntry = manifest.files[normalize(trackedPath)];
    const untrackedEntry = manifest.files[normalize(untrackedPath)];
    expect(typeof trackedEntry.gitSig).toBe('string');
    expect(untrackedEntry.gitSig).toBeUndefined();

    const gitSig = await getGitBlobHash(root, trackedPath);
    expect(typeof gitSig).toBe('string');

    const cachedEdges = [
      {
        from: normalize(trackedPath),
        to: { type: 'file', path: normalize(depPath) },
        raw: './dep',
      },
    ];

    const fileSignatures = new Map<string, { sig: string; gitSig?: string }>([
      [normalize(trackedPath), { sig: 'mtime:changed', gitSig: gitSig ?? undefined }],
    ]);
    const cachedFileEdges = new Map<string, { sig: string; gitSig?: string; edges: typeof cachedEdges }>([
      [
        normalize(trackedPath),
        {
          sig: 'old-sig',
          gitSig: gitSig ?? undefined,
          edges: cachedEdges,
        },
      ],
    ]);

    const prepSpy = vi.spyOn(filePrep, 'prepareParserInput');
    const graph = await collectGraph(root, [trackedPath], {
      fileSignatures,
      cachedFileEdges,
    });

    expect(prepSpy).not.toHaveBeenCalled();
    prepSpy.mockRestore();
    expect(graph.edges.length).toBe(1);
    expect(graph.edges[0]?.from).toBe(normalize(trackedPath));
  });
});
