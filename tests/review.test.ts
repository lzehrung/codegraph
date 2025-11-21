import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { buildProjectIndex, buildReviewReport } from '../src/index.js';

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('Review report', () => {
  it('summarizes changed files and symbols', async () => {
    const root = await mkTmpDir('dg-review-');
    const filePath = path.join(root, 'foo.ts');
    await fsp.writeFile(filePath, `export const a = 1;\n`, 'utf8');

    await buildProjectIndex(root, { cache: 'disk', threads: 2 });
    const report = await buildReviewReport(root, {
      cache: 'disk',
      files: [filePath],
    });

    expect(report.status).toBe('ok');
    expect(report.changedFiles.length).toBe(1);
    expect(report.changedFiles[0]?.symbols.some((s) => s.name === 'a')).toBe(
      true
    );
  });
});

