import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { textGrep } from '../src/index.js';

const tsxCliPath = path.resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

async function runCliCommand(args: string[], input?: string): Promise<string> {
  const result = await runCliCommandDetailed(args, input);
  return result.stdout;
}

async function runCliCommandDetailed(
  args: string[],
  input?: string,
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, 'src/cli.ts', ...args], {
      cwd: process.cwd(),
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

  it('graph supports -o/--output to write JSON to a file', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dg-cli-out-'));
    const outPath = path.join(tmpDir, 'graph.json');
    await runCliCommand(['graph', '--root', tsRoot, '-o', outPath]);
    const raw = await fsp.readFile(outPath, 'utf8');
    const graph = JSON.parse(raw);
    expect(graph.nodes).toBeInstanceOf(Array);
    expect(graph.edges).toBeInstanceOf(Array);
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
