import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { listProjectFiles, discoverProjectFiles } from '../src/index.js';
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

  it('extracts project names from common manifests', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codegraph-project-meta-'));
    const nodeDir = path.join(tempDir, 'node');
    const pythonDir = path.join(tempDir, 'python');
    const rustDir = path.join(tempDir, 'rust');
    const goDir = path.join(tempDir, 'go');
    const javaDir = path.join(tempDir, 'java');
    const gradleDir = path.join(tempDir, 'gradle');
    const dotnetDir = path.join(tempDir, 'dotnet');
    const ideDir = path.join(tempDir, 'ide');

    const packageJson = path.join(nodeDir, 'package.json');
    const pyproject = path.join(pythonDir, 'pyproject.toml');
    const cargo = path.join(rustDir, 'Cargo.toml');
    const goMod = path.join(goDir, 'go.mod');
    const pom = path.join(javaDir, 'pom.xml');
    const settingsGradle = path.join(gradleDir, 'settings.gradle');
    const csproj = path.join(dotnetDir, 'App.csproj');
    const sln = path.join(dotnetDir, 'Solution.sln');
    const ideaDir = path.join(ideDir, '.idea');

    await createFile(packageJson, JSON.stringify({ name: 'node-app' }, null, 2));
    await createFile(pyproject, '[project]\nname = "py-app"\n');
    await createFile(cargo, '[package]\nname = "rust-app"\n');
    await createFile(goMod, 'module example.com/go-app\n');
    await createFile(pom, '<project><artifactId>mvn-app</artifactId></project>');
    await createFile(settingsGradle, 'rootProject.name = "gradle-app"\n');
    await createFile(
      csproj,
      '<Project><PropertyGroup><AssemblyName>DotNetApp</AssemblyName></PropertyGroup></Project>',
    );
    await createFile(sln, 'Microsoft Visual Studio Solution File, Format Version 12.00\n');
    await fs.mkdir(ideaDir, { recursive: true });

    const discovered = await discoverProjectFiles(tempDir);
    const byPath = new Map(
      discovered.map((entry) => [normalize(entry.path), entry]),
    );

    expect(byPath.get(normalize(packageJson))?.name).toBe('node-app');
    expect(byPath.get(normalize(pyproject))?.name).toBe('py-app');
    expect(byPath.get(normalize(cargo))?.name).toBe('rust-app');
    expect(byPath.get(normalize(goMod))?.name).toBe('example.com/go-app');
    expect(byPath.get(normalize(pom))?.name).toBe('mvn-app');
    expect(byPath.get(normalize(settingsGradle))?.name).toBe('gradle-app');
    expect(byPath.get(normalize(csproj))?.name).toBe('DotNetApp');
    expect(byPath.get(normalize(sln))?.name).toBe('Solution');
    expect(byPath.get(normalize(ideaDir))?.projectRoot).toBe(normalize(ideDir));
  });
});
