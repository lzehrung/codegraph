import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { textGrep } from '../src/index.js';
import packageJson from '../package.json' with { type: 'json' };

const tsxCliPath = path.resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const sourceCliPath = path.resolve(process.cwd(), 'src', 'cli.ts');

async function runCliCommand(args: string[], input?: string): Promise<string> {
  const result = await runCliCommandDetailed(args, input);
  return result.stdout;
}

async function runCliCommandDetailed(
  args: string[],
  input?: string,
  cwd = process.cwd(),
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, sourceCliPath, ...args], {
      cwd,
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
      resolve({ stdout, stderr });
    });
  });
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

function isSorted(xs: string[]): boolean {
  for (let i = 1; i < xs.length; i++) {
    if (xs[i - 1]! > xs[i]!) return false;
  }
  return true;
}

describe('CLI regressions', () => {
  const samplesRoot = normalize(path.resolve(process.cwd(), 'tests', 'samples'));
  const tsRoot = normalize(path.resolve(samplesRoot, 'typescript'));

  it('graph --root + include root only scans include subtree', async () => {
    const stdout = await runCliCommand([
      'graph',
      '--stdout',
      '--root',
      samplesRoot,
      tsRoot,
    ]);
    const graph = JSON.parse(stdout) as { nodes: string[]; edges: unknown[] };
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(Array.isArray(graph.edges)).toBe(true);
    const tsRootNorm = `${normalize(tsRoot)}/`;
    for (const n of graph.nodes) {
      expect(normalize(n).startsWith(tsRootNorm)).toBe(true);
    }
  });

  it('version prints the package version', async () => {
    const stdout = await runCliCommand(['version']);
    expect(stdout.trim()).toBe(packageJson.version);
  });

  it('--version prints the package version', async () => {
    const stdout = await runCliCommand(['--version']);
    expect(stdout.trim()).toBe(packageJson.version);
  });

  it('graph supports -o/--output to write JSON to a file', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dg-cli-out-'));
    const outPath = path.join(tmpDir, 'graph.json');
    await runCliCommand(['graph', '--root', tsRoot, '-o', outPath]);
    const raw = await fsp.readFile(outPath, 'utf8');
    const graph = JSON.parse(raw);
    expect(graph.nodes).toBeInstanceOf(Array);
    expect(graph.edges).toBeInstanceOf(Array);
  });

  it('graph --root on an absolute path writes JSON output and progress to stderr', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dg-cli-abs-root-'));
    const outPath = path.join(tmpDir, 'graph.json');
    const result = await runCliCommandDetailed([
      'graph',
      '--root',
      tsRoot,
      '--json',
      '--symbols-detailed',
      '--progress',
      '--compact-json',
      '--output',
      outPath,
    ]);

    const raw = await fsp.readFile(outPath, 'utf8');
    const graph = JSON.parse(raw) as {
      files?: unknown[];
      fileEdges?: unknown[];
      symbols?: unknown[];
      symbolEdges?: unknown[];
    };
    expect(Array.isArray(graph.files)).toBe(true);
    expect(Array.isArray(graph.fileEdges)).toBe(true);
    expect(Array.isArray(graph.symbols)).toBe(true);
    expect(Array.isArray(graph.symbolEdges)).toBe(true);
    expect(result.stderr).toContain('Backend:');
    expect(result.stderr).toContain('files processed');
    expect(result.stdout.trim()).toBe('');
  });

  it('graph --stable produces sorted deterministic JSON', async () => {
    const args = ['graph', '--stdout', '--stable', tsRoot];
    const out1 = await runCliCommand(args);
    const out2 = await runCliCommand(args);
    expect(out1).toBe(out2);

    const graph = JSON.parse(out1) as { nodes: string[] };
    expect(isSorted(graph.nodes.map(normalize))).toBe(true);
  });

  it('graph --report writes native backend counters to the report file', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dg-cli-report-'));
    const reportPath = path.join(tmpDir, 'graph-report.json');
    const result = await runCliCommandDetailed([
      'graph',
      '--stdout',
      '--report',
      '--report-file',
      reportPath,
      tsRoot,
    ]);

    const graph = JSON.parse(result.stdout) as { nodes: string[]; edges: unknown[] };
    expect(graph.nodes.length).toBeGreaterThan(0);

    const rawReport = await fsp.readFile(reportPath, 'utf8');
    const report = JSON.parse(rawReport) as {
      command: string;
      index?: {
        backend?: {
          native?: {
            byLanguage: Record<string, { filesSeen: number }>;
          };
        };
      };
    };

    expect(report.command).toBe('graph');
    expect(report.index?.backend?.native?.byLanguage.ts?.filesSeen).toBeGreaterThan(0);
    expect(result.stderr).not.toContain('Backend:');
    expect(result.stderr).not.toContain('Unsupported file extension');
  });

  it('graph --native off disables native backend reporting explicitly', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dg-cli-native-off-'));
    const reportPath = path.join(tmpDir, 'graph-report.json');
    await runCliCommandDetailed([
      'graph',
      '--stdout',
      '--native',
      'off',
      '--report',
      '--report-file',
      reportPath,
      tsRoot,
    ]);

    const rawReport = await fsp.readFile(reportPath, 'utf8');
    const report = JSON.parse(rawReport) as {
      index?: {
        backend?: {
          native?: {
            enabled: boolean;
            filesUsed: number;
            fallbackReasons: { unavailable?: number };
          };
        };
      };
    };

    expect(report.index?.backend?.native?.enabled).toBe(false);
    expect(report.index?.backend?.native?.filesUsed).toBe(0);
    expect(report.index?.backend?.native?.fallbackReasons.unavailable).toBeGreaterThan(0);
  });

  it('sql runs raw queries against the SQLite graph export', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dg-cli-sql-'));
    await fsp.writeFile(
      path.join(tmpDir, 'main.ts'),
      'export function helper() { return 1; }\n',
      'utf8',
    );
    const dbPath = path.join(tmpDir, 'graph.sqlite');
    await runCliCommand(['graph', '--root', tmpDir, '--sqlite', dbPath]);
    const stdout = await runCliCommand([
      'sql',
      '--db',
      dbPath,
      '--query',
      "SELECT name FROM symbols WHERE kind = 'function';",
    ]);
    const result = JSON.parse(stdout) as {
      columns: string[];
      rows: Array<Array<unknown>>;
    };
    expect(result.columns).toEqual(['name']);
    const names = result.rows.map((row) => String(row[0]));
    expect(names).toContain('helper');
  });

  it('skill print-path returns the bundled raw skill directory', async () => {
    const stdout = await runCliCommand(['skill', 'print-path']);
    const skillPath = stdout.trim();
    expect(normalize(skillPath)).toMatch(/codegraph-skill\/codegraph$/);
  });

  it('skill doctor reports the requested target and current install status', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dg-cli-skill-doctor-'));
    const stdout = await runCliCommand([
      'skill',
      'doctor',
      '--target',
      tmpDir,
    ]);
    const report = JSON.parse(stdout) as {
      bundledSkillDir: string | null;
      installTargetDir: string;
      installedSkill: {
        targetDirExists: boolean;
        skillFilePresent: boolean;
        skillFilePath: string;
      };
    };

    expect(report.bundledSkillDir).toContain('codegraph-skill/codegraph');
    expect(normalize(report.installTargetDir)).toBe(normalize(tmpDir));
    expect(report.installedSkill.targetDirExists).toBe(true);
    expect(report.installedSkill.skillFilePresent).toBe(false);
    expect(normalize(report.installedSkill.skillFilePath)).toBe(
      normalize(path.join(tmpDir, 'SKILL.md')),
    );
  });

  it('doctor reports only backend state when no artifact path is provided', async () => {
    const stdout = await runCliCommand(['doctor']);
    const report = JSON.parse(stdout) as {
      native: { available: boolean; supportedLanguageIds: string[] };
      indexArtifact?: unknown;
    };

    expect(typeof report.native.available).toBe('boolean');
    expect(Array.isArray(report.native.supportedLanguageIds)).toBe(true);
    expect(report.indexArtifact).toBeUndefined();
  });

  it('doctor reports the explicit index artifact path when provided', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dg-cli-doctor-'));
    await fsp.mkdir(path.join(tmpDir, '.codegraph-cache', 'index-v1'), {
      recursive: true,
    });
    await fsp.writeFile(
      path.join(tmpDir, '.codegraph-cache', 'index-v1', 'manifest.json'),
      '{}\n',
      'utf8',
    );
    await fsp.writeFile(path.join(tmpDir, 'codegraph.json'), '{}\n', 'utf8');

    const cachePath = path.join(tmpDir, '.codegraph-cache', 'index-v1');
    const result = await runCliCommandDetailed(
      ['doctor', cachePath],
      undefined,
      tmpDir,
    );
    const report = JSON.parse(result.stdout) as {
      native: { available: boolean; supportedLanguageIds: string[] };
      indexArtifact: {
        type: string;
        exists: boolean;
        path: string;
        details?: Record<string, unknown>;
      };
    };

    expect(typeof report.native.available).toBe('boolean');
    expect(Array.isArray(report.native.supportedLanguageIds)).toBe(true);
    expect(report.indexArtifact.type).toBe('diskCache');
    expect(report.indexArtifact.exists).toBe(true);
    expect(normalize(report.indexArtifact.path)).toBe(normalize(cachePath));
    expect(report.indexArtifact.details?.manifestPresent).toBe(true);
  });

  it('hotspots honors --limit and include roots, and reuses the disk index cache when present', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dg-cli-hotspots-'));
    const srcDir = path.join(tmpDir, 'src');
    const testDir = path.join(tmpDir, 'tests');
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(testDir, { recursive: true });
    await fsp.writeFile(
      path.join(srcDir, 'a.ts'),
      "import { b } from './b';\nexport const a = b;\n",
      'utf8',
    );
    await fsp.writeFile(
      path.join(srcDir, 'b.ts'),
      "export const b = 1;\n",
      'utf8',
    );
    await fsp.writeFile(
      path.join(testDir, 'spec.ts'),
      "import { a } from '../src/a';\nexport const spec = a;\n",
      'utf8',
    );

    await runCliCommand(['index', '--root', tmpDir]);
    const result = await runCliCommandDetailed([
      'hotspots',
      '--root',
      tmpDir,
      srcDir,
      '--limit',
      '1',
      '--json',
    ]);

    const hotspots = JSON.parse(result.stdout) as Array<{
      file: string;
      fanIn: number;
      fanOut: number;
      score: number;
    }>;
    expect(hotspots).toEqual([
      {
        file: normalize(path.join(srcDir, 'b.ts')),
        fanIn: 1,
        fanOut: 0,
        score: 2,
      },
    ]);
    expect(result.stderr).toContain('Index cache: manifest=');
    expect(result.stderr).toContain('lastCommit=');
  });

  it('inspect emits backend, file summary, scoped hotspots, and recommended commands', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dg-cli-inspect-'));
    const srcDir = path.join(tmpDir, 'src');
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(
      path.join(srcDir, 'a.ts'),
      "import { b } from './b';\nexport const a = b;\n",
      'utf8',
    );
    await fsp.writeFile(
      path.join(srcDir, 'b.ts'),
      "export const b = 1;\n",
      'utf8',
    );

    const stdout = await runCliCommand([
      'inspect',
      '--root',
      tmpDir,
      srcDir,
      '--limit',
      '1',
    ]);
    const report = JSON.parse(stdout) as {
      root: string;
      includeRoots: string[];
      backend: {
        native: {
          available: boolean;
          supportedLanguageIds: string[];
        };
      };
      files: {
        total: number;
        byLanguage: Record<string, number>;
      };
      hotspots: Array<{ file: string; fanIn: number; fanOut: number; score: number }>;
      unresolved: { total: number; top: Array<{ name: string; importerCount: number }> };
      cycles: { total: number; top: Array<{ files: string[]; priorityScore: number; size: number }> };
      recommendedCommands: string[];
    };

    expect(report.root).toBe(normalize(tmpDir));
    expect(report.includeRoots).toEqual([normalize(srcDir)]);
    expect(typeof report.backend.native.available).toBe('boolean');
    expect(Array.isArray(report.backend.native.supportedLanguageIds)).toBe(true);
    expect(report.files.total).toBe(2);
    expect(report.files.byLanguage.ts).toBe(2);
    expect(report.hotspots.length).toBe(1);
    expect(report.hotspots[0].file).toBe(normalize(path.join(srcDir, 'b.ts')));
    expect(report.unresolved.total).toBe(0);
    expect(report.unresolved.top).toEqual([]);
    expect(report.cycles.total).toBe(0);
    expect(report.cycles.top).toEqual([]);
    expect(report.recommendedCommands).toContain(
      `codegraph hotspots --root "${normalize(tmpDir)}" "${normalize(srcDir)}" --limit 20 --json`,
    );
    expect(report.recommendedCommands).toContain(
      `codegraph doctor "${normalize(path.join(tmpDir, '.codegraph-cache', 'index-v1'))}"`,
    );
  });

  it('hotspots rejects invalid --limit values', async () => {
    await expect(
      runCliCommand([
        'hotspots',
        '--root',
        tsRoot,
        '--limit',
        '0',
      ]),
    ).rejects.toThrow(/Invalid --limit value "0"/i);
  });

  it('inspect rejects invalid --cache values', async () => {
    await expect(
      runCliCommand([
        'inspect',
        '--root',
        tsRoot,
        '--cache',
        'banana',
      ]),
    ).rejects.toThrow(/Invalid --cache value "banana"/i);
  });

  it('skill install copies the bundled skill into the target directory', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dg-cli-skill-install-'));
    const stdout = await runCliCommand([
      'skill',
      'install',
      '--target',
      tmpDir,
    ]);
    const result = JSON.parse(stdout) as {
      installed: boolean;
      skillFilePath: string;
      targetDir: string;
    };

    expect(result.installed).toBe(true);
    expect(normalize(result.targetDir)).toBe(normalize(tmpDir));
    const installedSkill = await fsp.readFile(path.join(tmpDir, 'SKILL.md'), 'utf8');
    expect(installedSkill).toContain('name: codegraph');
    expect(normalize(result.skillFilePath)).toBe(
      normalize(path.join(tmpDir, 'SKILL.md')),
    );
  });

  it('skill install --force replaces stale files in the target directory', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dg-cli-skill-force-'));
    await fsp.writeFile(path.join(tmpDir, 'stale.txt'), 'old\n', 'utf8');

    await runCliCommand([
      'skill',
      'install',
      '--target',
      tmpDir,
      '--force',
    ]);

    await expect(fsp.stat(path.join(tmpDir, 'stale.txt'))).rejects.toThrow();
    const installedSkill = await fsp.readFile(path.join(tmpDir, 'SKILL.md'), 'utf8');
    expect(installedSkill).toContain('name: codegraph');
  });

  it('grep supports plain-text regex mode via --pattern (and --glob)', async () => {
    const stdout = await runCliCommand([
      'grep',
      '--root',
      tsRoot,
      '--pattern',
      'helperFunction',
      '--glob',
      'utils.ts',
      '--max-hits',
      '50',
    ]);
    const hits = JSON.parse(stdout) as Array<{
      file: string;
      line: number;
      column: number;
      match: string;
    }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.file === 'utils.ts')).toBe(true);
    expect(hits.every((h) => typeof h.line === 'number' && typeof h.column === 'number')).toBe(true);
  });

  it('grep rejects ambiguous usage (both --query and --pattern)', async () => {
    await expect(
      runCliCommand([
        'grep',
        '--root',
        tsRoot,
        '--query',
        '(identifier) @id',
        '--pattern',
        'foo',
      ]),
    ).rejects.toThrow(/Usage: grep/i);
  });
});

describe('textGrep API', () => {
  it('returns normalized relative paths and match locations', async () => {
    const root = path.resolve(process.cwd(), 'tests', 'samples', 'typescript');
    const hits = await textGrep(root, 'helperFunction', ['**/*.ts'], {
      maxHits: 50,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => !h.file.includes('\\'))).toBe(true);
    expect(hits.every((h) => h.line >= 1 && h.column >= 1)).toBe(true);
  });
});

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

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('CLI flows', () => {
  const sampleRoot = normalize(path.resolve(process.cwd(), 'tests', 'samples', 'typescript'));

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
    const root = await mkTmpDir('dg-multi-lang-');
    const rustDir = path.join(root, 'rust');
    const javaDir = path.join(root, 'java');
    await fsp.mkdir(rustDir, { recursive: true });
    await fsp.mkdir(javaDir, { recursive: true });
    await fsp.writeFile(path.join(rustDir, 'main.rs'), 'fn main() {}', 'utf8');
    await fsp.writeFile(path.join(javaDir, 'main.java'), 'public class Main {}', 'utf8');

    const stdout = await runCliCommand([
      'impact',
      root,
      '--provider',
      'raw',
    ], multiLanguageDiff);
    const report = JSON.parse(stdout);

    expect(report.changedFiles.length).toBeGreaterThanOrEqual(2);
    expect(report.changedFiles.some((entry: any) => entry.file === 'rust/main.rs')).toBe(true);
    expect(report.changedFiles.some((entry: any) => entry.file === 'java/main.java')).toBe(true);
  });
});
