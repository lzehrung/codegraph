import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { buildProjectIndex, type BuildReport } from '../src/index.js';

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('Parsed cache reuse', () => {
  it('reuses cached parse outputs on the second build', async () => {
    const root = await mkTmpDir('dg-parsed-cache-');
    const utilPath = path.join(root, 'util.ts');
    const mainPath = path.join(root, 'main.ts');
    await fsp.writeFile(utilPath, 'export const n = 1;\n', 'utf8');
    await fsp.writeFile(mainPath, 'import { n } from "./util";\n', 'utf8');

    const report1: BuildReport = { timings: {} };
    await buildProjectIndex(root, { threads: 2, cache: 'disk', report: report1 });

    const report2: BuildReport = { timings: {} };
    await buildProjectIndex(root, { threads: 2, cache: 'disk', report: report2 });

    expect(report1.files?.parsed).toBe(2);
    expect(report2.files?.parsed).toBe(0);
    expect(report2.cache?.hits).toBeGreaterThan(report1.cache?.hits ?? 0);
  });

  it('reparses only changed files and hits cache for the rest', async () => {
    const root = await mkTmpDir('dg-parsed-cache-change-');
    const utilPath = path.join(root, 'util.ts');
    const mainPath = path.join(root, 'main.ts');
    await fsp.writeFile(utilPath, 'export const n = 1;\n', 'utf8');
    await fsp.writeFile(mainPath, 'import { n } from "./util";\n', 'utf8');

    const report1: BuildReport = { timings: {} };
    await buildProjectIndex(root, { threads: 2, cache: 'disk', report: report1 });

    await fsp.writeFile(utilPath, 'export const n = 2;\n', 'utf8');

    const report2: BuildReport = { timings: {} };
    await buildProjectIndex(root, { threads: 2, cache: 'disk', report: report2 });

    expect(report2.files?.parsed).toBe(1);
    expect(report2.cache?.hits).toBe(1);
    expect(report2.cache?.misses).toBe(1);
  });
});
