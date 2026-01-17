import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { listProjectFiles } from '../src/index.js';
import { DEFAULT_PROJECT_MANIFESTS } from '../src/util.js';

const normalize = (value: string) => value.replace(/\\/g, '/');

function toManifestFilename(manifest: string): string {
  if (manifest.includes('*')) {
    return manifest.replace('*', 'Sample');
  }
  return manifest;
}

async function createFile(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, 'utf8');
}

describe('project file discovery', () => {
  it('includes common manifests and lockfiles in default discovery', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codegraph-project-'));
    const manifestDir = path.join(tempDir, 'manifests');
    const sourceFile = path.join(tempDir, 'src', 'main.ts');
    const manifestFiles = DEFAULT_PROJECT_MANIFESTS.map(toManifestFilename);

    await createFile(sourceFile, 'export const value = 1;\n');
    await Promise.all(
      manifestFiles.map(async (manifest) => {
        const filePath = path.join(manifestDir, manifest);
        await createFile(filePath, `# ${manifest}\n`);
        return filePath;
      }),
    );

    const discovered = await listProjectFiles(tempDir);
    const discoveredSet = new Set(discovered.map(normalize));

    const expected = [sourceFile, ...manifestFiles.map((manifest) => path.join(manifestDir, manifest))].map(
      normalize,
    );

    for (const filePath of expected) {
      expect(discoveredSet.has(filePath)).toBe(true);
    }
  });
});
