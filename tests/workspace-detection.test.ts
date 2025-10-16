import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

async function copyDir(src: string, dest: string) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) await copyDir(s, d);
    else await fsp.copyFile(s, d);
  }
}

async function mkTmpMonorepo(): Promise<string> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dg-ws-'));
  const src = path.join(process.cwd(), 'tests', 'samples', 'monorepo');
  await copyDir(src, base);
  return base;
}

describe('Workspace detection modes', () => {
  it('package.json workspaces preferred when multiple configs present', async () => {
    const root = await mkTmpMonorepo();
    // add pnpm-workspace.yaml and lerna.json alongside existing package.json workspaces
    const pnpmYaml = "packages:\n  - 'packages/*'\n";
    await fsp.writeFile(path.join(root, 'pnpm-workspace.yaml'), pnpmYaml, 'utf8');
    await fsp.writeFile(path.join(root, 'lerna.json'), JSON.stringify({ packages: ['packages/*'] }, null, 2), 'utf8');

    const { buildProjectIndex } = await import('../src/index.js');
    const index = await buildProjectIndex(root);
    const files = [...index.byFile.keys()].map(f => f.replace(/\\/g, '/'));
    expect(files.some(f => f.includes('packages/pkg-a/src/index.ts'))).toBe(true);
    expect(files.some(f => f.includes('packages/pkg-b/src/index.js'))).toBe(true);
  });

  it('pnpm-workspace.yaml detection when package.json workspaces absent', async () => {
    const root = await mkTmpMonorepo();
    // remove workspaces from package.json
    const pkgPath = path.join(root, 'package.json');
    const pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8'));
    delete pkg.workspaces;
    await fsp.writeFile(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
    // write pnpm config
    const pnpmYaml = "packages:\n  - 'packages/*'\n";
    await fsp.writeFile(path.join(root, 'pnpm-workspace.yaml'), pnpmYaml, 'utf8');

    const { buildProjectIndex } = await import('../src/index.js');
    const index = await buildProjectIndex(root);
    const files = [...index.byFile.keys()].map(f => f.replace(/\\/g, '/'));
    expect(files.some(f => f.includes('packages/pkg-a/src/index.ts'))).toBe(true);
    expect(files.some(f => f.includes('packages/pkg-b/src/index.js'))).toBe(true);
  });

  it('lerna.json detection when package.json workspaces absent', async () => {
    const root = await mkTmpMonorepo();
    // remove workspaces and ensure no pnpm file
    const pkgPath = path.join(root, 'package.json');
    const pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8'));
    delete pkg.workspaces;
    await fsp.writeFile(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
    try { await fsp.unlink(path.join(root, 'pnpm-workspace.yaml')); } catch {}
    // write lerna config
    await fsp.writeFile(path.join(root, 'lerna.json'), JSON.stringify({ packages: ['packages/*'] }, null, 2), 'utf8');

    const { buildProjectIndex } = await import('../src/index.js');
    const index = await buildProjectIndex(root);
    const files = [...index.byFile.keys()].map(f => f.replace(/\\/g, '/'));
    expect(files.some(f => f.includes('packages/pkg-a/src/index.ts'))).toBe(true);
    expect(files.some(f => f.includes('packages/pkg-b/src/index.js'))).toBe(true);
  });
});


