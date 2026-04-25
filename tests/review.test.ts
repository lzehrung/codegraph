import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {
  buildProjectIndex,
  buildProjectIndexFromFiles,
  buildReviewReport,
} from '../src/index.js';
import * as indexer from '../src/indexer.js';


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

function normalize(file: string): string {
  return file.replace(/\\/g, '/');
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

    expect(report.schemaVersion).toBe(1);
    expect(report.status).toBe('ok');
    expect(report.riskSummary.level).toBeDefined();
    expect(report.reviewTasks.length).toBeGreaterThan(0);
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

  it('limits symbols to diff hunks and includes diff snippets when provided', async () => {
    const root = await mkTmpDir('dg-review-diff-');
    const srcDir = path.join(root, 'src');
    await fsp.mkdir(srcDir, { recursive: true });
    const featureFile = path.join(srcDir, 'feature.ts');
    await fsp.writeFile(
      featureFile,
      [
        `export function alpha() {`,
        `  return 2;`,
        `}`,
        ``,
        `export function beta() {`,
        `  return 5;`,
        `}`,
        ``,
      ].join('\n'),
      'utf8',
    );

    await buildProjectIndex(root);

    const diffText = [
      'diff --git a/src/feature.ts b/src/feature.ts',
      'index 1234567..abcdef0 100644',
      '--- a/src/feature.ts',
      '+++ b/src/feature.ts',
      '@@ -1,3 +1,3 @@',
      ' export function alpha() {',
      '-  return 1;',
      '+  return 2;',
      ' }',
      '',
    ].join('\n');

    const report = await buildReviewReport(root, {
      files: [featureFile],
      diffText,
      includeSymbolDetails: true,
    });

    const summary = report.changedFiles.find((entry) => entry.file === 'src/feature.ts');
    expect(summary).toBeDefined();
    const symbols = summary?.symbols ?? [];
    expect(symbols.some((symbol) => symbol.name === 'alpha')).toBe(true);
    expect(symbols.some((symbol) => symbol.name === 'beta')).toBe(false);

    const alpha = symbols.find((symbol) => symbol.name === 'alpha');
    expect(alpha?.diffSnippets?.some((snippet) => snippet.includes('return 2;'))).toBe(true);
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

  it('processes symbol details across files in parallel', async () => {
    const root = await mkTmpDir('dg-review-parallel-');
    const srcDir = path.join(root, 'src');
    await fsp.mkdir(srcDir, { recursive: true });
    const alphaFile = path.join(srcDir, 'alpha.ts');
    const betaFile = path.join(srcDir, 'beta.ts');
    await fsp.writeFile(alphaFile, `export function alpha() { return 'a'; }\n`, 'utf8');
    await fsp.writeFile(betaFile, `export function beta() { return 'b'; }\n`, 'utf8');

    await buildProjectIndex(root);

    type RefResult = Awaited<ReturnType<typeof indexer.findReferences>>;
    const deferreds: Array<{
      promise: Promise<RefResult>;
      resolve: (value: RefResult) => void;
      def: indexer.SymbolDef | null;
    }> = [];

    const createDeferred = (def: indexer.SymbolDef | null) => {
      let resolve: (value: RefResult) => void = () => {};
      const promise = new Promise<RefResult>((res) => {
        resolve = res;
      });
      const entry = { promise, resolve, def };
      deferreds.push(entry);
      return entry;
    };

    const findSpy = vi
      .spyOn(indexer, 'findReferences')
      .mockImplementation((idx, req) => {
        const def = 'def' in req ? req.def : null;
        const entry = createDeferred(def ?? null);
        return entry.promise;
      });

    try {
      const reportPromise = buildReviewReport(root, {
        files: [alphaFile, betaFile],
        includeSymbolDetails: true,
        maxCallsites: 1,
      });

      const waitFor = async (predicate: () => boolean) => {
        for (let i = 0; i < 50; i += 1) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error('Timed out waiting for parallel calls');
      };

      await waitFor(() => deferreds.length === 2);

      for (const entry of deferreds) {
        if (!entry.def) {
          entry.resolve({ status: 'not_found', reason: 'missing def' });
          continue;
        }
        entry.resolve({
          status: 'ok',
          definition: entry.def,
          references: [],
        });
      }

      const report = await reportPromise;
      expect(report.status).toBe('ok');
      expect(report.changedFiles.length).toBe(2);
    } finally {
      findSpy.mockRestore();
    }
  });

  it('respects reference concurrency limits', async () => {
    const root = await mkTmpDir('dg-review-concurrency-');
    const srcDir = path.join(root, 'src');
    await fsp.mkdir(srcDir, { recursive: true });
    const alphaFile = path.join(srcDir, 'alpha.ts');
    const betaFile = path.join(srcDir, 'beta.ts');
    await fsp.writeFile(alphaFile, `export function alpha() { return 'a'; }\n`, 'utf8');
    await fsp.writeFile(betaFile, `export function beta() { return 'b'; }\n`, 'utf8');

    await buildProjectIndex(root);

    type RefResult = Awaited<ReturnType<typeof indexer.findReferences>>;
    const deferreds: Array<{ resolve: (value: RefResult) => void }> = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const findSpy = vi
      .spyOn(indexer, 'findReferences')
      .mockImplementation(() => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        let resolveFn: (value: RefResult) => void = () => {};
        const promise = new Promise<RefResult>((resolve) => {
          resolveFn = resolve;
        });
        deferreds.push({
          resolve: (value: RefResult) => {
            inFlight -= 1;
            resolveFn(value);
          },
        });
        return promise;
      });

    try {
      const reportPromise = buildReviewReport(root, {
        files: [alphaFile, betaFile],
        includeSymbolDetails: true,
        maxCallsites: 1,
        referenceConcurrency: 1,
      });

      const waitFor = async (predicate: () => boolean) => {
        for (let i = 0; i < 50; i += 1) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error('Timed out waiting for findReferences calls');
      };

      await waitFor(() => deferreds.length === 1);
      deferreds[0]?.resolve({ status: 'not_found', reason: 'missing def' });

      await waitFor(() => deferreds.length === 2);
      deferreds[1]?.resolve({ status: 'not_found', reason: 'missing def' });

      const report = await reportPromise;
      expect(report.status).toBe('ok');
      expect(maxInFlight).toBe(1);
    } finally {
      findSpy.mockRestore();
    }
  });

  it('keeps parsed trees and bounds reference work for review callsites', async () => {
    const root = await mkTmpDir('dg-review-reference-bounds-');
    const srcDir = path.join(root, 'src');
    await fsp.mkdir(srcDir, { recursive: true });
    const featureFile = path.join(srcDir, 'feature.ts');
    const consumerFile = path.join(srcDir, 'consumer.ts');
    await fsp.writeFile(
      featureFile,
      `export function greet(name: string) { return name; }\n`,
      'utf8',
    );
    await fsp.writeFile(
      consumerFile,
      `import { greet } from './feature';\nexport const run = () => greet('hi');\n`,
      'utf8',
    );

    await buildProjectIndex(root);

    const originalBuildProjectIndexIncremental =
      indexer.buildProjectIndexIncremental;
    const originalFindReferences = indexer.findReferences;
    const capturedIndexOpts: Array<indexer.IncrementalBuildOptions | undefined> = [];
    const capturedReferenceLimits: number[] = [];

    const buildSpy = vi
      .spyOn(indexer, 'buildProjectIndexIncremental')
      .mockImplementation(async (projectRoot, opts) => {
        capturedIndexOpts.push(opts);
        return await originalBuildProjectIndexIncremental(projectRoot, opts);
      });

    const findSpy = vi
      .spyOn(indexer, 'findReferences')
      .mockImplementation(async (idx, req, opts) => {
        if (opts?.maxReferences !== undefined) {
          capturedReferenceLimits.push(opts.maxReferences);
        }
        return await originalFindReferences(idx, req, opts);
      });

    try {
      const report = await buildReviewReport(root, {
        files: [featureFile],
        includeSymbolDetails: true,
        maxCallsites: 2,
      });

      expect(report.status).toBe('ok');
      expect(capturedIndexOpts.some((opts) => opts?.keepParsed)).toBe(true);
      expect(capturedReferenceLimits.length).toBeGreaterThan(0);
      expect(capturedReferenceLimits.every((value) => value === 3)).toBe(true);
    } finally {
      findSpy.mockRestore();
      buildSpy.mockRestore();
    }
  });

  it('applies review depth presets to symbol details and graph options', async () => {
    const root = await mkTmpDir('dg-review-presets-');
    const srcDir = path.join(root, 'src');
    await fsp.mkdir(srcDir, { recursive: true });
    const featureFile = path.join(srcDir, 'feature.ts');
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
    const consumers = ['alpha', 'beta', 'gamma'].map((name) => ({
      name,
      file: path.join(srcDir, `${name}.ts`),
    }));
    for (const consumer of consumers) {
      await fsp.writeFile(
        consumer.file,
        [
          `import { greet } from './feature';`,
          ``,
          `export function run${consumer.name}() {`,
          `  return greet('${consumer.name}');`,
          `}`,
          ``,
        ].join('\n'),
        'utf8',
      );
    }

    await buildProjectIndex(root);

    const buildSpy = vi.spyOn(indexer, 'buildProjectIndexIncremental');
    try {
      const minimal = await buildReviewReport(root, {
        files: [featureFile],
        reviewDepth: 'minimal',
      });
      const standard = await buildReviewReport(root, {
        files: [featureFile],
        reviewDepth: 'standard',
      });
      const deep = await buildReviewReport(root, {
        files: [featureFile],
        reviewDepth: 'deep',
      });

      const findGreet = (report: Awaited<typeof minimal>) =>
        report.changedFiles
          .find((entry) => entry.file === 'src/feature.ts')
          ?.symbols.find((symbol) => symbol.name === 'greet');

      const minimalGreet = findGreet(minimal);
      expect(minimalGreet).toBeDefined();
      expect(minimalGreet?.definitionSnippet).toBeUndefined();
      expect(minimalGreet?.callsites).toBeUndefined();

      const standardGreet = findGreet(standard);
      expect(standardGreet?.definitionSnippet).toContain('function greet');
      expect(standardGreet?.callsites?.length).toBeGreaterThan(0);
      expect(standardGreet?.callsites?.length).toBeLessThanOrEqual(2);

      const deepGreet = findGreet(deep);
      expect(deepGreet?.callsites?.length).toBe(3);

      const fastFlags = buildSpy.mock.calls.map((call) => call[1]?.graph?.fast);
      expect(fastFlags[0]).toBe(true);
      expect(fastFlags[1]).toBe(false);
      expect(fastFlags[2]).toBe(false);
    } finally {
      buildSpy.mockRestore();
    }
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

  it('keeps Ruby star-import namespace expansion in sync for incremental builds', async () => {
    const root = await mkTmpDir('dg-review-ruby-incremental-');
    const utilPath = path.join(root, 'util.rb');
    const mainPath = path.join(root, 'main.rb');
    await fsp.writeFile(
      utilPath,
      [
        'class Tool',
        '  VALUE = 1',
        'end',
        '',
      ].join('\n'),
      'utf8',
    );
    await fsp.writeFile(
      mainPath,
      [
        "require_relative './util'",
        '',
        'value = Tool::VALUE',
        '',
      ].join('\n'),
      'utf8',
    );

    const normalizedMainPath = mainPath.replace(/\\/g, '/');
    const fullIndex = await buildProjectIndex(root, { cache: 'disk' });
    const fullMainModule = fullIndex.byFile.get(normalizedMainPath);
    expect(fullMainModule).toBeDefined();

    const incrementalIndex = await indexer.buildProjectIndexIncremental(root, {
      cache: 'disk',
      files: [mainPath],
    });
    const incrementalMainModule = incrementalIndex.byFile.get(normalizedMainPath);
    expect(incrementalMainModule).toBeDefined();

    const hasToolNamespaceImport = (imports: NonNullable<typeof fullMainModule>['imports']) =>
      imports.some(
        (imp) =>
          imp.kind === 'namespace' &&
          imp.localNS === 'Tool' &&
          imp.resolved === utilPath.replace(/\\/g, '/'),
      );

    expect(hasToolNamespaceImport(fullMainModule?.imports ?? [])).toBe(true);
    expect(hasToolNamespaceImport(incrementalMainModule?.imports ?? [])).toBe(true);
  });
});
