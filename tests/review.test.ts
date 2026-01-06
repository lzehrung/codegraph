import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import {
  buildProjectIndex,
  buildProjectIndexFromFiles,
  buildReviewReport,
} from '../src/index.js';

const tsxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
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

function runCliCommand(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxCommand, ['tsx', 'src/cli.ts', ...args], {
      cwd: process.cwd(),
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    if (input) child.stdin.write(input);
    child.stdin.end();

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`codegraph CLI failed (${code}). stderr:\n${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function normalize(file: string): string {
  return file.replace(/\\/g, '/');
}

const multiLanguageDiff = `diff --git a/rust/main.rs b/rust/main.rs
index e69de29..4b825dc 100644
--- a/rust/main.rs
+++ b/rust/main.rs
@@
 mod utils;
 mod helpers;
 
 use utils::helper_function;
+use helpers::helper_from_helpers;
 use helpers::helper_from_helpers;
 
 fn main() {
     helper_function();
     helper_from_helpers();
 }
diff --git a/java/main.java b/java/main.java
index e69de29..4b825dc 100644
--- a/java/main.java
+++ b/java/main.java
@@
 package main;
 
 import utils.Utils;
 import helpers.Helpers;
 
 public class Main {
   public static void main(String[] args) {
     Utils.helperFunction();
     new Utils.UtilityClass();
     Helpers.helperFromHelpers();
+    Helpers.helperFromHelpers();
   }
 }
`;

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
    expect(report.changedFiles[0]?.symbols.some((s) => s.name === 'a')).toBe(true);
  });

  it('includes definition snippets and callsites when enabled', async () => {
    const root = await mkTmpDir('dg-review-details-');
    const srcDir = path.join(root, 'src');
    await fsp.mkdir(srcDir, { recursive: true });
    const featureFile = path.join(srcDir, 'feature.ts');
    const consumerFile = path.join(srcDir, 'consumer.ts');
    await fsp.writeFile(
      featureFile,
      [
        `export function greet(name: string) {`,
        `  return \`hi \${name}\`;`,
        `}`,
        ``,
      ].join('\n'),
      'utf8',
    );
    await fsp.writeFile(
      consumerFile,
      [
        `import { greet } from './feature';`,
        ``,
        `export function run() {`,
        `  greet('world');`,
        `}`,
        ``,
      ].join('\n'),
      'utf8',
    );

    await buildProjectIndex(root);
    await fsp.writeFile(
      featureFile,
      [
        `export function greet(name: string) {`,
        `  return \`hello \${name}\`;`,
        `}`,
        ``,
      ].join('\n'),
      'utf8',
    );

    const report = await buildReviewReport(root, {
      files: [featureFile],
      includeSymbolDetails: true,
      maxCallsites: 2,
    });
    const featureSummary = report.changedFiles.find(
      (entry) => entry.file === 'src/feature.ts',
    );
    expect(featureSummary).toBeDefined();
    const greetSummary = featureSummary?.symbols.find(
      (symbol) => symbol.name === 'greet',
    );
    expect(greetSummary).toBeDefined();
    expect(greetSummary?.definitionSnippet).toContain('function greet');
    const callsites = greetSummary?.callsites ?? [];
    expect(callsites.length).toBeGreaterThan(0);
    expect(callsites.length).toBeLessThanOrEqual(2);
    expect(
      callsites.some(
        (site) =>
          site.file === 'src/consumer.ts' &&
          (site.range.start.line === 1 || site.range.start.line === 4),
      ),
    ).toBe(true);
  });

  it('identifies git-tracked changed files without explicit listings', async () => {
    const root = await mkTmpDir('dg-review-git-');
    runGit(root, ['init']);
    runGit(root, ['config', 'user.email', 'test@git.local']);
    runGit(root, ['config', 'user.name', 'Codegraph Bot']);
    const filePath = path.join(root, 'tracked.ts');
    await fsp.writeFile(filePath, `export const value = 1;\n`, 'utf8');
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '-m', 'initial']);
    await fsp.writeFile(filePath, `export const value = 2;\n`, 'utf8');
    runGit(root, ['add', 'tracked.ts']);
    runGit(root, ['commit', '-m', 'change']);

    const base = runGit(root, ['rev-parse', 'HEAD^']);
    const report = await buildReviewReport(root, { gitBase: base });

    expect(report.status).toBe('ok');
    expect(report.summary.filesChanged).toBe(1);
    expect(report.changedFiles[0]?.file).toBe('tracked.ts');
    expect(report.base).toBe(base);
    expect(report.head).toBe('HEAD');
  });

  it('reports deleted files surfaced by git diffs', async () => {
    const root = await mkTmpDir('dg-review-deleted-');
    runGit(root, ['init']);
    runGit(root, ['config', 'user.email', 'delete@git.local']);
    runGit(root, ['config', 'user.name', 'Codegraph Bot']);
    const filePath = path.join(root, 'gone.ts');
    await fsp.writeFile(filePath, `export const gone = true;\n`, 'utf8');
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '-m', 'initial']);
    runGit(root, ['rm', 'gone.ts']);
    runGit(root, ['commit', '-m', 'remove']);

    const base = runGit(root, ['rev-parse', 'HEAD^']);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const report = await buildReviewReport(root, { gitBase: base });

      expect(report.summary.filesChanged).toBe(1);
      expect(report.changedFiles[0]?.status).toBe('deleted');
      expect(report.changedFiles[0]?.symbols).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns candidate tests after warming the manifest cache', async () => {
    const root = await mkTmpDir('dg-review-candidates-');
    const srcDir = path.join(root, 'src');
    const testsDir = path.join(root, 'tests');
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(testsDir, { recursive: true });
    const featureFile = path.join(srcDir, 'feature.ts');
    const testFile = path.join(testsDir, 'feature.test.ts');
    await fsp.writeFile(featureFile, `export function helper() { return 1; }\n`, 'utf8');
    await fsp.writeFile(
      testFile,
      `import { helper } from '../src/feature';\nhelper();\n`,
      'utf8'
    );

    await buildProjectIndex(root);
    const manifestPath = path.join(root, '.codegraph-cache', 'index-v1', 'manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    await fsp.writeFile(featureFile, `export function helper() { return 2; }\n`, 'utf8');
    const report = await buildReviewReport(root, {
      files: [featureFile],
      maxCandidates: 5,
    });

    expect(report.summary.candidateTests).toBeGreaterThan(0);
    expect(report.candidateTests.some((candidate) => candidate.file === 'tests/feature.test.ts')).toBe(true);
    expect(report.candidateTests.some((candidate) => candidate.confidence === 'high')).toBe(true);
  });
});

describe('CLI flows', () => {
  const sampleRoot = path.resolve(process.cwd(), 'tests', 'samples', 'typescript');

  it('emits a file graph by default', async () => {
    const stdout = await runCliCommand([
      'graph',
      '--stdout',
      '--fast-graph',
      sampleRoot,
    ]);
    const graph = JSON.parse(stdout);

    expect(graph.nodes).toBeInstanceOf(Array);
    expect(graph.edges).toBeInstanceOf(Array);
    expect(graph.symbols).toBeUndefined();
  });

  it('handles raw diffs touching multiple languages', async () => {
    const stdout = await runCliCommand([
      'impact',
      path.resolve(process.cwd(), 'tests', 'samples'),
      '--provider',
      'raw',
    ], multiLanguageDiff);
    const report = JSON.parse(stdout) as any;

    expect(report.changedFiles.length).toBeGreaterThanOrEqual(2);
    expect(report.changedFiles.some((entry: any) => entry.file === 'rust/main.rs')).toBe(true);
    expect(report.changedFiles.some((entry: any) => entry.file === 'java/main.java')).toBe(true);
  });
});

describe('Indexing helper', () => {
  it('keeps star-import expansions in sync between full and subset builds', async () => {
    const root = await mkTmpDir('dg-review-indexer-');
    const libDir = path.join(root, 'lib');
    await fsp.mkdir(libDir, { recursive: true });
    const utilsPath = path.join(libDir, 'utils.ts');
    const indexPath = path.join(libDir, 'index.ts');
    await fsp.writeFile(utilsPath, `export function helper() { return 'ok'; }\n`, 'utf8');
    await fsp.writeFile(indexPath, `export * from './utils';\n`, 'utf8');

    const fullIndex = await buildProjectIndex(root);
    const fullModule = fullIndex.byFile.get(normalize(indexPath));
    if (!fullModule) throw new Error('Full index missing index.ts');
    const utilsNormalized = normalize(utilsPath);
    const fullExportStar = fullModule.exports.find(
      (exp) =>
        exp.type === 'exportStar' &&
        typeof exp.fromModule === 'string' &&
        normalize(exp.fromModule) === utilsNormalized
    );
    expect(fullExportStar).toBeDefined();

    const subsetIndex = await buildProjectIndexFromFiles(root, [indexPath, utilsPath]);
    const subsetModule = subsetIndex.byFile.get(normalize(indexPath));
    if (!subsetModule) throw new Error('Subset index missing index.ts');
    const subsetExportStar = subsetModule.exports.find(
      (exp) =>
        exp.type === 'exportStar' &&
        typeof exp.fromModule === 'string' &&
        normalize(exp.fromModule) === utilsNormalized
    );
    expect(subsetExportStar).toBeDefined();
  });
});
