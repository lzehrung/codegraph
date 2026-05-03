import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { textGrep } from "../src/index.js";
import packageJson from "../package.json" with { type: "json" };

const tsxCliPath = path.resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const sourceCliPath = path.resolve(process.cwd(), "src", "cli.ts");

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
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    if (input) child.stdin.write(input);
    child.stdin.end();

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`codegraph CLI failed (${code}). stderr:\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}

function isSorted(xs: string[]): boolean {
  for (let i = 1; i < xs.length; i++) {
    if (xs[i - 1]! > xs[i]!) return false;
  }
  return true;
}

function skillInstallTarget(rootDir: string): string {
  return path.join(rootDir, "skills", "codegraph");
}

describe("CLI regressions", () => {
  const samplesRoot = normalize(path.resolve(process.cwd(), "tests", "samples"));
  const tsRoot = normalize(path.resolve(samplesRoot, "typescript"));

  it("graph --root + include root only scans include subtree", async () => {
    const stdout = await runCliCommand(["graph", "--stdout", "--root", samplesRoot, tsRoot]);
    const graph = JSON.parse(stdout) as { nodes: string[]; edges: unknown[] };
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(Array.isArray(graph.edges)).toBe(true);
    const tsRootNorm = `${normalize(tsRoot)}/`;
    for (const n of graph.nodes) {
      expect(normalize(n).startsWith(tsRootNorm)).toBe(true);
    }
  });

  it("version prints the package version", async () => {
    const stdout = await runCliCommand(["version"]);
    expect(stdout.trim()).toBe(packageJson.version);
  });

  it("version --json prints package identity", async () => {
    const stdout = await runCliCommand(["version", "--json"]);
    const report = JSON.parse(stdout) as { name?: string; version?: string; packageRoot?: string };

    expect(report.name).toBe(packageJson.name);
    expect(report.version).toBe(packageJson.version);
    expect(report.packageRoot).toBe(normalize(process.cwd()));
  });

  it("--version prints the package version", async () => {
    const stdout = await runCliCommand(["--version"]);
    expect(stdout.trim()).toBe(packageJson.version);
  });

  it("importing cli.ts as a module does not execute the entrypoint", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-import-"));
    const importerPath = path.join(tmpDir, "import-cli.mjs");
    const sentinel = "cli-import-safe";
    await fsp.writeFile(
      importerPath,
      `import ${JSON.stringify(pathToFileURL(sourceCliPath).href)};\nconsole.log(${JSON.stringify(sentinel)});\n`,
      "utf8",
    );

    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [tsxCliPath, importerPath], {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.stdin.end();

      child.on("error", reject);
      child.on("exit", (code) => {
        if (code !== 0) {
          reject(new Error(`codegraph CLI import failed (${code}). stderr:\n${stderr}`));
          return;
        }
        resolve({ stdout, stderr });
      });
    });

    expect(result.stdout.trim()).toBe(sentinel);
    expect(result.stderr).not.toContain("Unknown command");
  });

  it("graph supports -o/--output to write JSON to a file", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-out-"));
    const outPath = path.join(tmpDir, "graph.json");
    await runCliCommand(["graph", "--root", tsRoot, "-o", outPath]);
    const raw = await fsp.readFile(outPath, "utf8");
    const graph = JSON.parse(raw);
    expect(graph.nodes).toBeInstanceOf(Array);
    expect(graph.edges).toBeInstanceOf(Array);
  });

  it("graph --root on an absolute path writes JSON output and progress to stderr", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-abs-root-"));
    const outPath = path.join(tmpDir, "graph.json");
    const result = await runCliCommandDetailed([
      "graph",
      "--root",
      tsRoot,
      "--json",
      "--symbols-detailed",
      "--progress",
      "--compact-json",
      "--output",
      outPath,
    ]);

    const raw = await fsp.readFile(outPath, "utf8");
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
    expect(result.stderr).toContain("Backend:");
    expect(result.stderr).toContain("files processed");
    expect(result.stdout.trim()).toBe("");
  });

  it("graph --stable produces sorted deterministic JSON", async () => {
    const args = ["graph", "--stdout", "--stable", tsRoot];
    const out1 = await runCliCommand(args);
    const out2 = await runCliCommand(args);
    expect(out1).toBe(out2);

    const graph = JSON.parse(out1) as { nodes: string[] };
    expect(isSorted(graph.nodes.map(normalize))).toBe(true);
  });

  it("chunk detects Zig files by extension", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-zig-chunk-"));
    const filePath = path.join(tmpDir, "main.zig");
    await fsp.writeFile(filePath, "pub fn helper() void {}\n", "utf8");

    const stdout = await runCliCommand(["chunk", filePath, "--min-tokens", "1", "--max-tokens", "50"]);
    const chunks = JSON.parse(stdout) as Array<{ languageId?: string; filePath?: string }>;

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.languageId === "zig")).toBe(true);
    expect(chunks.every((chunk) => normalize(chunk.filePath ?? "") === normalize(filePath))).toBe(true);
  });

  it("chunk uses semantic chunking for source languages beyond the legacy allowlist", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-go-chunk-"));
    const filePath = path.join(tmpDir, "main.go");
    await fsp.writeFile(filePath, 'package main\n\nfunc helper() string {\n\treturn "ok"\n}\n', "utf8");

    const stdout = await runCliCommand(["chunk", filePath, "--min-tokens", "1", "--max-tokens", "50"]);
    const chunks = JSON.parse(stdout) as Array<{ languageId?: string; type?: string; name?: string }>;

    expect(
      chunks.some((chunk) => chunk.languageId === "go" && chunk.type === "function" && chunk.name === "helper"),
    ).toBe(true);
  });

  it("graph honors .gitignore by default and --no-gitignore opts out", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-gitignore-"));
    const srcDir = path.join(tmpDir, "src");
    const keptFile = path.join(srcDir, "main.ts");
    const ignoredFile = path.join(srcDir, "generated.ts");
    await fsp.mkdir(path.dirname(keptFile), { recursive: true });
    await fsp.writeFile(path.join(tmpDir, ".gitignore"), "src/generated.ts\n", "utf8");
    await fsp.writeFile(keptFile, "export const main = 1;\n", "utf8");
    await fsp.writeFile(ignoredFile, "export const generated = 1;\n", "utf8");

    const defaultGraph = JSON.parse(await runCliCommand(["graph", "--root", tmpDir, srcDir, "--json"])) as {
      nodes: string[];
    };
    expect(defaultGraph.nodes.map(normalize)).toContain(normalize(keptFile));
    expect(defaultGraph.nodes.map(normalize)).not.toContain(normalize(ignoredFile));

    const fullGraph = JSON.parse(
      await runCliCommand(["graph", "--root", tmpDir, srcDir, "--json", "--no-gitignore"]),
    ) as {
      nodes: string[];
    };
    expect(fullGraph.nodes.map(normalize)).toContain(normalize(ignoredFile));
  });

  it("graph applies additive --include-glob and --ignore-glob filters to scanned files", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-scan-glob-"));
    const appFile = path.join(tmpDir, "src", "main.ts");
    const specFile = path.join(tmpDir, "src", "main.spec.ts");
    const jsFile = path.join(tmpDir, "src", "legacy.js");
    await fsp.mkdir(path.dirname(appFile), { recursive: true });
    await fsp.writeFile(appFile, "export const main = 1;\n", "utf8");
    await fsp.writeFile(specFile, "export const spec = 1;\n", "utf8");
    await fsp.writeFile(jsFile, "module.exports = 1;\n", "utf8");

    const graph = JSON.parse(
      await runCliCommand([
        "graph",
        "--root",
        tmpDir,
        "--json",
        "--include-glob",
        "src/**/*.ts",
        "--ignore-glob",
        "src/**/*.spec.ts",
      ]),
    ) as { nodes: string[] };
    const nodes = graph.nodes.map(normalize);

    expect(nodes).toContain(normalize(appFile));
    expect(nodes).not.toContain(normalize(specFile));
    expect(nodes).not.toContain(normalize(jsFile));
  });

  it("--resolve-node-modules does not make node_modules a direct scan root", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-node-modules-scan-"));
    const packageFile = path.join(tmpDir, "node_modules", "my-pkg", "index.js");
    await fsp.mkdir(path.dirname(packageFile), { recursive: true });
    await fsp.writeFile(packageFile, "module.exports = 1;\n", "utf8");
    await fsp.writeFile(path.join(tmpDir, "main.js"), "export const main = 1;\n", "utf8");

    const graph = JSON.parse(await runCliCommand(["graph", "--root", tmpDir, "--json", "--resolve-node-modules"])) as {
      nodes: string[];
    };

    expect(graph.nodes.map(normalize)).not.toContain(normalize(packageFile));
  });

  it("graph --report writes native backend counters to the report file", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-report-"));
    const reportPath = path.join(tmpDir, "graph-report.json");
    const result = await runCliCommandDetailed(["graph", "--stdout", "--report", "--report-file", reportPath, tsRoot]);

    const graph = JSON.parse(result.stdout) as { nodes: string[]; edges: unknown[] };
    expect(graph.nodes.length).toBeGreaterThan(0);

    const rawReport = await fsp.readFile(reportPath, "utf8");
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

    expect(report.command).toBe("graph");
    expect(report.index?.backend?.native?.byLanguage.ts?.filesSeen).toBeGreaterThan(0);
    expect(result.stderr).not.toContain("Backend:");
    expect(result.stderr).not.toContain("Unsupported file extension");
  });

  it("rejects out-of-root file navigation inputs explicitly", async () => {
    const outsideFile = path.resolve(process.cwd(), "README.md");

    const dumpmod = JSON.parse(await runCliCommand(["dumpmod", outsideFile, "--root", tsRoot])) as {
      status: string;
      reason?: string;
      error?: string;
    };
    expect(dumpmod.status).toBe("error");
    expect(dumpmod.reason).toBe("outside_project_root");
    expect(dumpmod.error).toContain("outside project root");

    const goto = JSON.parse(await runCliCommand(["goto", outsideFile, "1", "1", "--root", tsRoot])) as {
      status: string;
      reason?: string;
      error?: string;
    };
    expect(goto.status).toBe("error");
    expect(goto.reason).toBe("outside_project_root");

    const refs = JSON.parse(
      await runCliCommand(["refs", "--file", outsideFile, "--line", "1", "--col", "1", "--root", tsRoot]),
    ) as {
      status: string;
      reason?: string;
      error?: string;
    };
    expect(refs.status).toBe("error");
    expect(refs.reason).toBe("outside_project_root");

    const deps = JSON.parse(await runCliCommand(["deps", outsideFile, "--root", tsRoot, "--json"])) as {
      status: string;
      reason?: string;
      error?: string;
    };
    expect(deps.status).toBe("error");
    expect(deps.reason).toBe("outside_project_root");

    const pathResult = JSON.parse(
      await runCliCommand(["path", outsideFile, "main.ts", "--root", tsRoot, "--json"]),
    ) as {
      status: string;
      reason?: string;
      error?: string;
    };
    expect(pathResult.status).toBe("error");
    expect(pathResult.reason).toBe("outside_project_root");
  });

  it("graph --native off disables native backend reporting explicitly", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-native-off-"));
    const reportPath = path.join(tmpDir, "graph-report.json");
    await runCliCommandDetailed([
      "graph",
      "--stdout",
      "--native",
      "off",
      "--report",
      "--report-file",
      reportPath,
      tsRoot,
    ]);

    const rawReport = await fsp.readFile(reportPath, "utf8");
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

  it("sql runs raw queries against the SQLite graph export", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-sql-"));
    await fsp.writeFile(path.join(tmpDir, "main.ts"), "export function helper() { return 1; }\n", "utf8");
    const dbPath = path.join(tmpDir, "graph.sqlite");
    await runCliCommand(["graph", "--root", tmpDir, "--sqlite", dbPath]);
    const stdout = await runCliCommand([
      "sql",
      "--db",
      dbPath,
      "--query",
      "SELECT name FROM symbols WHERE kind = 'function';",
    ]);
    const result = JSON.parse(stdout) as {
      columns: string[];
      rows: Array<Array<unknown>>;
    };
    expect(result.columns).toEqual(["name"]);
    const names = result.rows.map((row) => String(row[0]));
    expect(names).toContain("helper");
  });

  it("sql rejects mutating statements and leaves the graph export intact", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-sql-readonly-"));
    await fsp.writeFile(path.join(tmpDir, "main.ts"), "export function helper() { return 1; }\n", "utf8");
    const dbPath = path.join(tmpDir, "graph.sqlite");
    await runCliCommand(["graph", "--root", tmpDir, "--sqlite", dbPath]);

    await expect(
      runCliCommandDetailed(["sql", "--db", dbPath, "--query", "DELETE FROM symbols RETURNING name;"]),
    ).rejects.toThrow(/read-only result-producing statements/);

    const stdout = await runCliCommand(["sql", "--db", dbPath, "--query", "SELECT COUNT(*) AS count FROM symbols;"]);
    const result = JSON.parse(stdout) as {
      columns: string[];
      rows: Array<Array<unknown>>;
    };
    expect(result.columns).toEqual(["count"]);
    expect(result.rows).toEqual([[1]]);
  });

  it("skill print-path returns the bundled raw skill directory", async () => {
    const stdout = await runCliCommand(["skill", "print-path"]);
    const skillPath = stdout.trim();
    expect(normalize(skillPath)).toMatch(/codegraph-skill\/codegraph$/);
  });

  it("skill doctor reports the requested target and current install status", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-skill-doctor-"));
    const targetDir = skillInstallTarget(tmpDir);
    const stdout = await runCliCommand(["skill", "doctor", "--target", targetDir]);
    const report = JSON.parse(stdout) as {
      bundledSkillDir: string | null;
      bundledArchivePath?: string | null;
      installTargetDir: string;
      installedSkill: {
        targetDirExists: boolean;
        skillFilePresent: boolean;
        skillFilePath: string;
      };
    };

    expect(report.bundledSkillDir).toContain("codegraph-skill/codegraph");
    expect(report.bundledArchivePath).toBeUndefined();
    expect(normalize(report.installTargetDir)).toBe(normalize(targetDir));
    expect(report.installedSkill.targetDirExists).toBe(false);
    expect(report.installedSkill.skillFilePresent).toBe(false);
    expect(normalize(report.installedSkill.skillFilePath)).toBe(normalize(path.join(targetDir, "SKILL.md")));
  });

  it("doctor reports package identity and backend state when no artifact path is provided", async () => {
    const stdout = await runCliCommand(["doctor"]);
    const report = JSON.parse(stdout) as {
      package: { name: string; version: string; packageRoot: string };
      native: { available: boolean; supportedLanguageIds: string[] };
      indexArtifact?: unknown;
    };

    expect(report.package.name).toBe(packageJson.name);
    expect(report.package.version).toBe(packageJson.version);
    expect(normalize(report.package.packageRoot)).toBe(normalize(process.cwd()));
    expect(typeof report.native.available).toBe("boolean");
    expect(Array.isArray(report.native.supportedLanguageIds)).toBe(true);
    expect(report.indexArtifact).toBeUndefined();
  });

  it("doctor reports the explicit index artifact path when provided", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-doctor-"));
    await fsp.mkdir(path.join(tmpDir, ".codegraph-cache", "index-v1"), {
      recursive: true,
    });
    await fsp.writeFile(path.join(tmpDir, ".codegraph-cache", "index-v1", "manifest.json"), "{}\n", "utf8");
    await fsp.writeFile(path.join(tmpDir, "codegraph.json"), "{}\n", "utf8");

    const cachePath = path.join(tmpDir, ".codegraph-cache", "index-v1");
    const result = await runCliCommandDetailed(["doctor", cachePath], undefined, tmpDir);
    const report = JSON.parse(result.stdout) as {
      native: { available: boolean; supportedLanguageIds: string[] };
      indexArtifact: {
        type: string;
        exists: boolean;
        path: string;
        details?: Record<string, unknown>;
      };
    };

    expect(typeof report.native.available).toBe("boolean");
    expect(Array.isArray(report.native.supportedLanguageIds)).toBe(true);
    expect(report.indexArtifact.type).toBe("diskCache");
    expect(report.indexArtifact.exists).toBe(true);
    expect(normalize(report.indexArtifact.path)).toBe(normalize(cachePath));
    expect(report.indexArtifact.details?.manifestPresent).toBe(true);
  });

  it("hotspots honors --limit and include roots, and reuses the disk index cache when present", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-hotspots-"));
    const srcDir = path.join(tmpDir, "src");
    const testDir = path.join(tmpDir, "tests");
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(testDir, { recursive: true });
    await fsp.writeFile(path.join(srcDir, "a.ts"), "import { b } from './b';\nexport const a = b;\n", "utf8");
    await fsp.writeFile(path.join(srcDir, "b.ts"), "export const b = 1;\n", "utf8");
    await fsp.writeFile(
      path.join(testDir, "spec.ts"),
      "import { a } from '../src/a';\nexport const spec = a;\n",
      "utf8",
    );

    await runCliCommand(["index", "--root", tmpDir]);
    const result = await runCliCommandDetailed(["hotspots", "--root", tmpDir, srcDir, "--limit", "1", "--json"]);

    const hotspots = JSON.parse(result.stdout) as Array<{
      file: string;
      fanIn: number;
      fanOut: number;
      score: number;
    }>;
    expect(hotspots).toEqual([
      {
        file: normalize(path.join(srcDir, "b.ts")),
        fanIn: 1,
        fanOut: 0,
        score: 2,
      },
    ]);
    expect(result.stderr).toContain("Index cache: manifest=");
    expect(result.stderr).toContain("lastCommit=");
  });

  it("inspect emits backend, file summary, scoped hotspots, and recommended commands", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-inspect-"));
    const srcDir = path.join(tmpDir, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { react: "^19.0.0" } }),
      "utf8",
    );
    await fsp.writeFile(
      path.join(srcDir, "a.ts"),
      "import { b } from './b';\nimport React from 'react';\nexport const a = b;\nexport { React };\n",
      "utf8",
    );
    await fsp.writeFile(path.join(srcDir, "b.ts"), "export const b = 1;\n", "utf8");

    const stdout = await runCliCommand(["inspect", "--root", tmpDir, srcDir, "--limit", "1"]);
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
    expect(typeof report.backend.native.available).toBe("boolean");
    expect(Array.isArray(report.backend.native.supportedLanguageIds)).toBe(true);
    expect(report.files.total).toBe(2);
    expect(report.files.byLanguage.ts).toBe(2);
    expect(report.hotspots.length).toBe(1);
    expect(report.hotspots[0].file).toBe(normalize(path.join(srcDir, "b.ts")));
    expect(report.unresolved.total).toBe(0);
    expect(report.unresolved.top).toEqual([]);
    expect(report.cycles.total).toBe(0);
    expect(report.cycles.top).toEqual([]);
    expect(report.recommendedCommands).toContain(
      `codegraph hotspots --root "${normalize(tmpDir)}" "${normalize(srcDir)}" --limit 20 --json`,
    );
    expect(report.recommendedCommands).toContain(
      `codegraph doctor "${normalize(path.join(tmpDir, ".codegraph-cache", "index-v1"))}"`,
    );
  });

  it("unresolved filters declared dependencies for scoped roots", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-unresolved-scoped-"));
    const srcDir = path.join(tmpDir, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { react: "^19.0.0" } }),
      "utf8",
    );
    await fsp.writeFile(
      path.join(srcDir, "a.ts"),
      "import React from 'react';\nimport missing from 'missing-package';\nexport { React, missing };\n",
      "utf8",
    );

    const stdout = await runCliCommand(["unresolved", "--root", srcDir, "--json"]);
    const unresolved = JSON.parse(stdout) as Array<{ name: string }>;

    expect(unresolved.map((entry) => entry.name)).toEqual(["missing-package"]);
  });

  it("hotspots rejects invalid --limit values", async () => {
    await expect(runCliCommand(["hotspots", "--root", tsRoot, "--limit", "0"])).rejects.toThrow(
      /Invalid --limit value "0"/i,
    );
  });

  it("inspect rejects invalid --cache values", async () => {
    await expect(runCliCommand(["inspect", "--root", tsRoot, "--cache", "banana"])).rejects.toThrow(
      /Invalid --cache value "banana"/i,
    );
  });

  it("skill install copies the bundled skill into the target directory", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-skill-install-"));
    const targetDir = skillInstallTarget(tmpDir);
    const stdout = await runCliCommand(["skill", "install", "--target", targetDir]);
    const result = JSON.parse(stdout) as {
      installed: boolean;
      skillFilePath: string;
      targetDir: string;
    };

    expect(result.installed).toBe(true);
    expect(normalize(result.targetDir)).toBe(normalize(targetDir));
    const installedSkill = await fsp.readFile(path.join(targetDir, "SKILL.md"), "utf8");
    expect(installedSkill).toContain("name: codegraph");
    expect(normalize(result.skillFilePath)).toBe(normalize(path.join(targetDir, "SKILL.md")));
  });

  it("skill install --force replaces stale files in the target directory", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-skill-force-"));
    const targetDir = skillInstallTarget(tmpDir);
    await fsp.mkdir(targetDir, { recursive: true });
    await fsp.writeFile(path.join(targetDir, "stale.txt"), "old\n", "utf8");

    await runCliCommand(["skill", "install", "--target", targetDir, "--force"]);

    await expect(fsp.stat(path.join(targetDir, "stale.txt"))).rejects.toThrow();
    const installedSkill = await fsp.readFile(path.join(targetDir, "SKILL.md"), "utf8");
    expect(installedSkill).toContain("name: codegraph");
  });

  it("skill install rejects unsafe target directories", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-skill-unsafe-"));
    await expect(runCliCommand(["skill", "install", "--target", tmpDir, "--force"])).rejects.toThrow(
      /target directory must end with/i,
    );
  });

  it("grep supports plain-text regex mode via --pattern (and --glob)", async () => {
    const stdout = await runCliCommand([
      "grep",
      "--root",
      tsRoot,
      "--pattern",
      "helperFunction",
      "--glob",
      "utils.ts",
      "--max-hits",
      "50",
    ]);
    const hits = JSON.parse(stdout) as Array<{
      file: string;
      line: number;
      column: number;
      match: string;
    }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.file === "utils.ts")).toBe(true);
    expect(hits.every((h) => typeof h.line === "number" && typeof h.column === "number")).toBe(true);
  });

  it("grep honors .gitignore and additive scan globs", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-grep-scan-"));
    const appFile = path.join(tmpDir, "src", "app.ts");
    const specFile = path.join(tmpDir, "src", "app.spec.ts");
    const ignoredFile = path.join(tmpDir, "src", "generated.ts");
    const jsFile = path.join(tmpDir, "src", "legacy.js");

    await fsp.mkdir(path.dirname(appFile), { recursive: true });
    await fsp.writeFile(path.join(tmpDir, ".gitignore"), "src/generated.ts\n", "utf8");
    await fsp.writeFile(appFile, "export const marker = 1;\n", "utf8");
    await fsp.writeFile(specFile, "export const marker = 2;\n", "utf8");
    await fsp.writeFile(ignoredFile, "export const marker = 3;\n", "utf8");
    await fsp.writeFile(jsFile, "export const marker = 4;\n", "utf8");

    const stdout = await runCliCommand([
      "grep",
      "--root",
      tmpDir,
      "--pattern",
      "marker",
      "--include-glob",
      "src/**/*.ts",
      "--ignore-glob",
      "src/**/*.spec.ts",
    ]);
    const hits = JSON.parse(stdout) as Array<{ file: string }>;

    expect(hits.map((hit) => normalize(hit.file))).toEqual([normalize(path.relative(tmpDir, appFile))]);
  });

  it("grep rejects ambiguous usage (both --query and --pattern)", async () => {
    await expect(
      runCliCommand(["grep", "--root", tsRoot, "--query", "(identifier) @id", "--pattern", "foo"]),
    ).rejects.toThrow(/Usage: grep/i);
  });
});

describe("textGrep API", () => {
  it("returns normalized relative paths and match locations", async () => {
    const root = path.resolve(process.cwd(), "tests", "samples", "typescript");
    const hits = await textGrep(root, "helperFunction", ["**/*.ts"], {
      maxHits: 50,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => !h.file.includes("\\"))).toBe(true);
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

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Codegraph Test",
      GIT_AUTHOR_EMAIL: "codegraph@example.test",
      GIT_COMMITTER_NAME: "Codegraph Test",
      GIT_COMMITTER_EMAIL: "codegraph@example.test",
    },
  }).trim();
}

function initGitRepo(root: string): void {
  git(root, ["init"]);
  git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(root, ["config", "core.autocrlf", "false"]);
}

describe("CLI flows", () => {
  const sampleRoot = normalize(path.resolve(process.cwd(), "tests", "samples", "typescript"));

  it("emits a file graph by default", async () => {
    const stdout = await runCliCommand(["graph", "--stdout", "--fast-graph", sampleRoot]);
    const graph = JSON.parse(stdout);

    expect(graph.nodes).toBeInstanceOf(Array);
    expect(graph.edges).toBeInstanceOf(Array);
    expect(graph.symbols).toBeUndefined();
  });

  it("handles raw diffs touching multiple languages", async () => {
    const root = await mkTmpDir("dg-multi-lang-");
    const rustDir = path.join(root, "rust");
    const javaDir = path.join(root, "java");
    await fsp.mkdir(rustDir, { recursive: true });
    await fsp.mkdir(javaDir, { recursive: true });
    await fsp.writeFile(path.join(rustDir, "main.rs"), "fn main() {}", "utf8");
    await fsp.writeFile(path.join(javaDir, "main.java"), "public class Main {}", "utf8");

    const stdout = await runCliCommand(["impact", root, "--provider", "raw"], multiLanguageDiff);
    const report = JSON.parse(stdout);

    expect(report.changedFiles.length).toBeGreaterThanOrEqual(2);
    expect(report.changedFiles.some((entry: { file: string }) => entry.file === "rust/main.rs")).toBe(true);
    expect(report.changedFiles.some((entry: { file: string }) => entry.file === "java/main.java")).toBe(true);
    expect(report.schemaVersion).toBe(1);
    expect(report.format).toBe("full");
    expect(Array.isArray(report.impacted)).toBe(true);
  });

  it("impact CLI full JSON payload includes explicit schema metadata", async () => {
    const root = await mkTmpDir("dg-impact-full-");
    await fsp.writeFile(path.join(root, "main.ts"), "export function helper() { return 1; }\n", "utf8");
    const diffText = `diff --git a/main.ts b/main.ts
index 1111111..2222222 100644
--- a/main.ts
+++ b/main.ts
@@ -1 +1 @@
-export function helper() { return 0; }
+export function helper() { return 1; }
`;

    const stdout = await runCliCommand(["impact", root, "--provider", "raw"], diffText);
    const report = JSON.parse(stdout) as {
      changedFiles: Array<{ file: string }>;
      changedSymbols: Array<{ file: string; name: string }>;
      impacted: Array<{ file: string }>;
      schemaVersion?: number;
      format?: string;
    };

    expect(report.changedFiles.length).toBeGreaterThan(0);
    expect(typeof report.changedFiles[0]?.file).toBe("string");
    expect(Array.isArray(report.changedSymbols)).toBe(true);
    expect(Array.isArray(report.impacted)).toBe(true);
    expect(report.schemaVersion).toBe(1);
    expect(report.format).toBe("full");
  });

  it("impact CLI accepts WORKTREE as a git-provider head sentinel", async () => {
    const root = await mkTmpDir("dg-impact-worktree-");
    initGitRepo(root);
    await fsp.writeFile(path.join(root, "main.ts"), "export const value = 1;\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "initial"]);

    await fsp.writeFile(path.join(root, "main.ts"), "export const value = 2;\n", "utf8");

    const stdout = await runCliCommand(["impact", root, "--provider", "git", "--base", "HEAD", "--head", "WORKTREE"]);
    const report = JSON.parse(stdout) as {
      changedFiles: Array<{ file: string }>;
      schemaVersion?: number;
      format?: string;
    };

    expect(report.changedFiles.map((entry) => entry.file)).toEqual(["main.ts"]);
    expect(report.schemaVersion).toBe(1);
    expect(report.format).toBe("full");
  });

  it("review CLI accepts WORKTREE as a git head sentinel", async () => {
    const root = await mkTmpDir("dg-review-worktree-");
    initGitRepo(root);
    await fsp.writeFile(path.join(root, "main.ts"), "export function value() { return 1; }\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "initial"]);

    await fsp.writeFile(path.join(root, "main.ts"), "export function value() { return 2; }\n", "utf8");

    const stdout = await runCliCommand(["review", "--root", root, "--base", "HEAD", "--head", "WORKTREE"]);
    const report = JSON.parse(stdout) as {
      status?: string;
      changedFiles: Array<{ file: string }>;
      base?: string;
      head?: string;
    };

    expect(report.status).toBe("ok");
    expect(report.changedFiles.map((entry) => entry.file)).toEqual(["main.ts"]);
    expect(report.base).toBe("HEAD");
    expect(report.head).toBe("WORKTREE");
  });

  it("review CLI prints a compact human summary with --summary", async () => {
    const root = await mkTmpDir("dg-review-summary-");
    initGitRepo(root);
    await fsp.writeFile(path.join(root, "main.ts"), "export function value() { return 1; }\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "initial"]);

    await fsp.writeFile(path.join(root, "main.ts"), "export function value() { return 2; }\n", "utf8");

    const stdout = await runCliCommand(["review", "--root", root, "--base", "HEAD", "--head", "WORKTREE", "--summary"]);

    expect(stdout.startsWith("Review Summary")).toBe(true);
    expect(stdout).toContain("Status: ok");
    expect(stdout).toContain("Files changed: 1");
    expect(stdout).toContain("Symbols changed:");
    expect(stdout).toContain("Candidate tests:");
    expect(stdout).toContain("Risk:");
    expect(stdout).toContain("Changed files:");
    expect(stdout).toContain("main.ts");
    expect(stdout).toContain("Review tasks:");
    expect(stdout).toContain("review-summary");
    expect(stdout).not.toContain('"projectFiles"');
  });

  it("review summary groups candidate tests by confidence without listing low-confidence fallbacks", async () => {
    const root = await mkTmpDir("dg-review-summary-candidates-");
    const srcDir = path.join(root, "src");
    const testsDir = path.join(root, "tests");
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(testsDir, { recursive: true });
    await fsp.writeFile(path.join(srcDir, "feature.ts"), "export function value() { return 1; }\n", "utf8");
    await fsp.writeFile(
      path.join(testsDir, "feature.test.ts"),
      "import { value } from '../src/feature';\nvalue();\n",
      "utf8",
    );
    for (let index = 1; index <= 3; index++) {
      await fsp.writeFile(
        path.join(testsDir, `pattern-${index}.test.ts`),
        `expect(${index}).toBe(${index});\n`,
        "utf8",
      );
    }
    initGitRepo(root);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "initial"]);

    await fsp.writeFile(path.join(srcDir, "feature.ts"), "export function value() { return 2; }\n", "utf8");

    const stdout = await runCliCommand([
      "review",
      "--root",
      root,
      "--base",
      "HEAD",
      "--head",
      "WORKTREE",
      "--summary",
      "--max-tests",
      "4",
    ]);

    expect(stdout).toContain("Candidate tests: 4 (high: 1, medium: 0, low: 3)");
    expect(stdout).toContain("High-confidence tests:");
    expect(stdout).toContain("- tests/feature.test.ts: importsChanged");
    expect(stdout).toContain("Low-confidence pattern matches: 3 available as breadth hints in full JSON.");
    expect(stdout).not.toContain("- tests/pattern-1.test.ts");
  });

  it("review summary condenses low-confidence-only test candidates", async () => {
    const root = await mkTmpDir("dg-review-summary-low-only-");
    const docsDir = path.join(root, "docs");
    const testsDir = path.join(root, "tests");
    await fsp.mkdir(docsDir, { recursive: true });
    await fsp.mkdir(testsDir, { recursive: true });
    await fsp.writeFile(path.join(docsDir, "guide.md"), "# Guide\n\nInitial text.\n", "utf8");
    for (let index = 1; index <= 3; index++) {
      await fsp.writeFile(
        path.join(testsDir, `pattern-${index}.test.ts`),
        `expect(${index}).toBe(${index});\n`,
        "utf8",
      );
    }
    initGitRepo(root);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "initial"]);

    await fsp.writeFile(path.join(docsDir, "guide.md"), "# Guide\n\nUpdated text.\n", "utf8");

    const stdout = await runCliCommand([
      "review",
      "--root",
      root,
      "--base",
      "HEAD",
      "--head",
      "WORKTREE",
      "--summary",
      "--max-tests",
      "3",
    ]);

    expect(stdout).toContain("Candidate tests: 3 (high: 0, medium: 0, low: 3)");
    expect(stdout).toContain("No high- or medium-confidence test candidates found.");
    expect(stdout).toContain("Low-confidence pattern matches: 3 available as breadth hints in full JSON.");
    expect(stdout).not.toContain("- tests/pattern-1.test.ts");
  });

  it("review CLI treats --pretty as summary output", async () => {
    const root = await mkTmpDir("dg-review-pretty-");
    initGitRepo(root);
    await fsp.writeFile(path.join(root, "main.ts"), "export function value() { return 1; }\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "initial"]);

    await fsp.writeFile(path.join(root, "main.ts"), "export function value() { return 2; }\n", "utf8");

    const summary = await runCliCommand([
      "review",
      "--root",
      root,
      "--base",
      "HEAD",
      "--head",
      "WORKTREE",
      "--summary",
    ]);
    const pretty = await runCliCommand(["review", "--root", root, "--base", "HEAD", "--head", "WORKTREE", "--pretty"]);

    expect(pretty).toBe(summary);
  });
});
