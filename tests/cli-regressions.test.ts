import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { textGrep } from "../src/index.js";
import { isCliDiscoveryRelativePathInside, runCli } from "../src/cli.js";
import { getSkillTargetDirForAgent, type SkillInstallAgent } from "../src/cli/skill.js";
import packageJson from "../package.json" with { type: "json" };
import { runGit as git } from "./helpers/git.js";

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
  env: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string }> {
  if (input === undefined && !Object.keys(env).length) {
    return await runCliInProcess(args, cwd);
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, sourceCliPath, ...args], {
      cwd,
      env: { ...process.env, ...env },
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

async function runCliInProcess(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;

  try {
    await runCli(args, {
      cwd: () => cwd,
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: (chunk) => {
        stderr += chunk;
      },
      exit: (code) => {
        exitCode = code;
        throw new Error(`codegraph CLI exited ${code}`);
      },
    });
  } catch (error) {
    if (exitCode !== undefined) {
      throw new Error(`codegraph CLI failed (${exitCode}). stderr:\n${stderr}`);
    }
    throw error;
  }

  return { stdout, stderr };
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

  it("treats Windows cross-drive relative paths as outside CLI discovery roots", () => {
    expect(isCliDiscoveryRelativePathInside("src/app.ts")).toBe(true);
    expect(isCliDiscoveryRelativePathInside("../outside.ts")).toBe(false);
    expect(isCliDiscoveryRelativePathInside("D:\\outside\\file.ts")).toBe(false);
    expect(isCliDiscoveryRelativePathInside("D:/outside/file.ts")).toBe(false);
  });

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

  it("graph JSON can include isolated SQL artifacts", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cli-sql-"));
    await fsp.mkdir(path.join(root, "db"), { recursive: true });
    await fsp.writeFile(path.join(root, "db", "schema.sql"), "CREATE TABLE users (id integer);\n", "utf8");

    const stdout = await runCliCommand(["graph", "--stdout", "--root", root, "--sql-artifacts", "--json"]);
    const graph = JSON.parse(stdout) as {
      edges: unknown[];
      sqlArtifacts?: { nodes: Array<{ kind: string; name?: string }> };
    };

    expect(graph.edges).toEqual([]);
    expect(graph.sqlArtifacts?.nodes).toContainEqual(
      expect.objectContaining({ kind: "sql_table_candidate", name: "users" }),
    );
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

  it("direct graph failures append errors to the configured stderr file", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-stderr-file-"));
    await fsp.writeFile(path.join(tmpDir, "main.ts"), "export const value = 1;\n", "utf8");
    const stderrPath = path.join(tmpDir, "codegraph.err");
    const outputPath = path.join(tmpDir, "missing", "codegraph.json");

    try {
      await expect(
        runCliCommandDetailed(
          ["graph", "--root", tmpDir, "--output", outputPath, "--stderr-file", stderrPath],
          undefined,
          tmpDir,
          { CODEGRAPH_FORCE_SPAWN: "1" },
        ),
      ).rejects.toThrow("codegraph CLI failed");

      const stderrLog = await fsp.readFile(stderrPath, "utf8");
      expect(stderrLog).toContain("ENOENT");
      expect(stderrLog).toContain("missing");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
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

  it("chunk does not parse project config from the current working directory", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-chunk-bad-config-"));
    const filePath = path.join(tmpDir, "main.ts");
    await fsp.writeFile(path.join(tmpDir, "codegraph.config.json"), "{ not valid json", "utf8");
    await fsp.writeFile(filePath, "export function helper() { return 1; }\n", "utf8");

    const stdout = await runCliCommandDetailed(
      ["chunk", filePath, "--min-tokens", "1", "--max-tokens", "50"],
      undefined,
      tmpDir,
    );
    const chunks = JSON.parse(stdout.stdout) as Array<{ languageId?: string; name?: string }>;

    expect(chunks.some((chunk) => chunk.languageId === "typescript" && chunk.name === "helper")).toBe(true);
  });

  it("unknown commands do not parse project config from the current working directory", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-unknown-bad-config-"));
    await fsp.writeFile(path.join(tmpDir, "codegraph.config.json"), "{ not valid json", "utf8");

    await expect(runCliCommandDetailed(["not-a-codegraph-command"], undefined, tmpDir)).rejects.toThrow(
      /Unknown command: not-a-codegraph-command/,
    );
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

  it("graph applies codegraph.config.json discovery ignores", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-config-ignore-"));
    const appFile = path.join(tmpDir, "src", "main.ts");
    const sampleFile = path.join(tmpDir, "tests", "samples", "fixture.ts");
    await fsp.mkdir(path.dirname(appFile), { recursive: true });
    await fsp.mkdir(path.dirname(sampleFile), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "codegraph.config.json"),
      JSON.stringify({ discovery: { ignoreGlobs: ["tests/samples/**"] } }),
      "utf8",
    );
    await fsp.writeFile(appFile, "export const main = 1;\n", "utf8");
    await fsp.writeFile(sampleFile, "export const fixture = 1;\n", "utf8");

    const graph = JSON.parse(await runCliCommand(["graph", "--root", tmpDir, "--json"])) as { nodes: string[] };
    const nodes = graph.nodes.map(normalize);

    expect(nodes).toContain(normalize(appFile));
    expect(nodes).not.toContain(normalize(sampleFile));
  });

  it("graph query commands apply codegraph.config.json discovery ignores", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-query-config-ignore-"));
    const mainFile = path.join(tmpDir, "src", "main.ts");
    const generatedFile = path.join(tmpDir, "src", "generated.ts");
    await fsp.mkdir(path.dirname(mainFile), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "codegraph.config.json"),
      JSON.stringify({ discovery: { ignoreGlobs: ["src/generated.ts"] } }),
      "utf8",
    );
    await fsp.writeFile(mainFile, "export const main = 1;\n", "utf8");
    await fsp.writeFile(
      generatedFile,
      "import missing from 'missing-pkg';\nexport const generated = missing;\n",
      "utf8",
    );

    const unresolved = JSON.parse(await runCliCommand(["unresolved", "--root", tmpDir, "--json"])) as Array<{
      name: string;
    }>;

    expect(unresolved).toEqual([]);
  });

  it("graph applies codegraph.config.json discovery ignores relative to --root for scoped include roots", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-config-scoped-ignore-"));
    const testsDir = path.join(tmpDir, "tests");
    const appFile = path.join(testsDir, "kept.test.ts");
    const sampleFile = path.join(testsDir, "samples", "fixture.ts");
    await fsp.mkdir(path.dirname(appFile), { recursive: true });
    await fsp.mkdir(path.dirname(sampleFile), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "codegraph.config.json"),
      JSON.stringify({ discovery: { ignoreGlobs: ["tests/samples/**"] } }),
      "utf8",
    );
    await fsp.writeFile(appFile, "export const kept = 1;\n", "utf8");
    await fsp.writeFile(sampleFile, "export const fixture = 1;\n", "utf8");

    const graph = JSON.parse(await runCliCommand(["graph", "--root", tmpDir, testsDir, "--json"])) as {
      nodes: string[];
    };
    const nodes = graph.nodes.map(normalize);

    expect(nodes).toContain(normalize(appFile));
    expect(nodes).not.toContain(normalize(sampleFile));
  });

  it("keeps CLI include globs relative to scoped include roots while config ignores stay root-relative", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-scoped-include-glob-"));
    const testsDir = path.join(tmpDir, "tests");
    const unitFile = path.join(testsDir, "unit", "kept.test.ts");
    const generatedUnitFile = path.join(testsDir, "unit", "generated", "drop.test.ts");
    const integrationFile = path.join(testsDir, "integration", "skipped.test.ts");
    const sampleFile = path.join(testsDir, "samples", "fixture.ts");
    await fsp.mkdir(path.dirname(unitFile), { recursive: true });
    await fsp.mkdir(path.dirname(generatedUnitFile), { recursive: true });
    await fsp.mkdir(path.dirname(integrationFile), { recursive: true });
    await fsp.mkdir(path.dirname(sampleFile), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "codegraph.config.json"),
      JSON.stringify({ discovery: { ignoreGlobs: ["tests/samples/**"] } }),
      "utf8",
    );
    await fsp.writeFile(unitFile, "export const kept = 1;\n", "utf8");
    await fsp.writeFile(generatedUnitFile, "export const generated = 1;\n", "utf8");
    await fsp.writeFile(integrationFile, "export const skipped = 1;\n", "utf8");
    await fsp.writeFile(sampleFile, "export const fixture = 1;\n", "utf8");

    const graph = JSON.parse(
      await runCliCommand([
        "graph",
        "--root",
        tmpDir,
        testsDir,
        "--json",
        "--include-glob",
        "unit/**",
        "--ignore-glob",
        "unit/generated/**",
      ]),
    ) as { nodes: string[] };
    const nodes = graph.nodes.map(normalize);

    expect(nodes).toContain(normalize(unitFile));
    expect(nodes).not.toContain(normalize(generatedUnitFile));
    expect(nodes).not.toContain(normalize(integrationFile));
    expect(nodes).not.toContain(normalize(sampleFile));
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

  it("sql does not parse project config from the current working directory", async () => {
    const projectDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-sql-db-"));
    const cwdDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-sql-bad-config-"));
    await fsp.writeFile(path.join(projectDir, "main.ts"), "export function helper() { return 1; }\n", "utf8");
    await fsp.writeFile(path.join(cwdDir, "codegraph.config.json"), "{ not valid json", "utf8");
    const dbPath = path.join(projectDir, "graph.sqlite");
    await runCliCommand(["graph", "--root", projectDir, "--sqlite", dbPath]);

    const stdout = await runCliCommandDetailed(
      ["sql", "--db", dbPath, "--query", "SELECT COUNT(*) AS count FROM symbols;"],
      undefined,
      cwdDir,
    );
    const result = JSON.parse(stdout.stdout) as {
      columns: string[];
      rows: Array<Array<unknown>>;
    };

    expect(result.columns).toEqual(["count"]);
    expect(result.rows).toEqual([[1]]);
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

    const coldResult = await runCliCommandDetailed([
      "hotspots",
      "--root",
      tmpDir,
      srcDir,
      "--limit",
      "1",
      "--json",
      "--cache",
      "off",
    ]);
    const coldHotspots = JSON.parse(coldResult.stdout) as Array<{
      file: string;
      fanIn: number;
      fanOut: number;
      score: number;
    }>;
    expect(coldHotspots).toEqual([
      {
        file: normalize(path.join(srcDir, "b.ts")),
        fanIn: 1,
        fanOut: 0,
        score: 2,
      },
    ]);
    expect(coldResult.stderr).not.toContain("Index cache: manifest=");

    await runCliCommand(["index", "--root", tmpDir]);
    const result = await runCliCommandDetailed(["hotspots", "--root", tmpDir, srcDir, "--limit", "1", "--json"]);

    const hotspots = JSON.parse(result.stdout) as Array<{
      file: string;
      fanIn: number;
      fanOut: number;
      score: number;
    }>;
    expect(hotspots).toEqual(coldHotspots);
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
    const duplicateSource = `
export function summarizeInvoices(rows: Array<{ amount: number; tax: number }>) {
  const output: string[] = [];
  for (const row of rows) {
    const subtotal = row.amount + row.tax;
    const rounded = Math.round(subtotal * 100) / 100;
    const label = rounded > 100 ? "large" : "small";
    output.push(label + ":" + rounded.toFixed(2));
  }
  return output.filter((value) => value.includes(":")).join(",");
}
`;
    await fsp.writeFile(path.join(srcDir, "c.ts"), duplicateSource, "utf8");
    await fsp.writeFile(path.join(srcDir, "d.ts"), duplicateSource, "utf8");

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
      duplicates: {
        total: number;
        omitted: number;
        minConfidence: string;
        top: Array<{
          confidence: string;
          cloneType: string;
          left: { file: string; startLine: number; endLine: number; tokenCount: number; name?: string };
          right: { file: string; startLine: number; endLine: number; tokenCount: number; name?: string };
          rawPairCount: number;
        }>;
      };
      recommendedCommands: string[];
    };

    expect(report.root).toBe(normalize(tmpDir));
    expect(report.includeRoots).toEqual([normalize(srcDir)]);
    expect(typeof report.backend.native.available).toBe("boolean");
    expect(Array.isArray(report.backend.native.supportedLanguageIds)).toBe(true);
    expect(report.files.total).toBe(4);
    expect(report.files.byLanguage.ts).toBe(4);
    expect(report.hotspots.length).toBe(1);
    expect(report.hotspots[0].file).toBe(normalize(path.join(srcDir, "b.ts")));
    expect(report.unresolved.total).toBe(0);
    expect(report.unresolved.top).toEqual([]);
    expect(report.cycles.total).toBe(0);
    expect(report.cycles.top).toEqual([]);
    expect(report.duplicates.total).toBeGreaterThan(0);
    expect(report.duplicates.omitted).toBeGreaterThanOrEqual(0);
    expect(report.duplicates.minConfidence).toBe("high");
    expect(report.duplicates.top).toHaveLength(1);
    expect(report.duplicates.top[0]?.confidence).toBe("high");
    expect(report.duplicates.top[0]?.cloneType).toBe("exact");
    expect(report.duplicates.top[0]?.left.file).toBe("src/c.ts");
    expect(report.duplicates.top[0]?.right.file).toBe("src/d.ts");
    expect(report.duplicates.top[0]?.left.tokenCount).toBeGreaterThan(40);
    expect(report.duplicates.top[0]?.rawPairCount).toBeGreaterThan(0);
    expect(report.recommendedCommands).toContain(
      `codegraph hotspots --root "${normalize(tmpDir)}" "${normalize(srcDir)}" --limit 20 --json`,
    );
    expect(report.recommendedCommands).toContain(
      `codegraph graph --root "${normalize(tmpDir)}" "${normalize(srcDir)}" --json --symbols-detailed --compact-json`,
    );
    expect(report.recommendedCommands).toContain(
      `codegraph duplicates --root "${normalize(tmpDir)}" "${normalize(srcDir)}" --min-confidence medium --limit 20 --include-same-file`,
    );
    expect(report.recommendedCommands).toContain(
      `codegraph doctor "${normalize(path.join(tmpDir, ".codegraph-cache", "index-v1"))}"`,
    );
  });

  it("inspect supports relative --root include roots with project-root config ignores", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-inspect-relative-root-"));
    const srcDir = path.join(tmpDir, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "codegraph.config.json"),
      JSON.stringify({ discovery: { ignoreGlobs: ["src/ignored.ts"] } }),
      "utf8",
    );
    await fsp.writeFile(
      path.join(srcDir, "a.ts"),
      "import { b } from './b';\nimport { missing } from './missing';\nexport const a = b + missing;\n",
      "utf8",
    );
    await fsp.writeFile(path.join(srcDir, "b.ts"), "import { a } from './a';\nexport const b = a;\n", "utf8");
    await fsp.writeFile(path.join(srcDir, "ignored.ts"), "export const ignored = 1;\n", "utf8");

    const { stdout } = await runCliCommandDetailed(
      ["inspect", "--root", ".", "./src", "--limit", "5"],
      undefined,
      tmpDir,
    );
    const report = JSON.parse(stdout) as {
      root: string;
      includeRoots: string[];
      files: {
        total: number;
        byLanguage: Record<string, number>;
      };
      unresolved: { total: number };
      cycles: { total: number };
      recommendedCommands: string[];
    };

    expect(report.root).toBe(normalize(tmpDir));
    expect(report.includeRoots).toEqual([normalize(srcDir)]);
    expect(report.files.total).toBe(2);
    expect(report.files.byLanguage.ts).toBe(2);
    expect(report.unresolved.total).toBe(1);
    expect(report.cycles.total).toBe(1);
    expect(report.recommendedCommands).toContain(
      `codegraph unresolved --root "${normalize(tmpDir)}" "${normalize(srcDir)}" --json`,
    );
    expect(report.recommendedCommands).toContain(
      `codegraph cycles --root "${normalize(tmpDir)}" "${normalize(srcDir)}" --sort priority --json`,
    );
  });

  it("inspect keeps scoped summaries with cold builds and warm disk cache", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-inspect-cache-scope-"));
    const srcDir = path.join(tmpDir, "src");
    const testDir = path.join(tmpDir, "tests");
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(testDir, { recursive: true });
    await fsp.writeFile(
      path.join(srcDir, "a.ts"),
      "import { b } from './b';\nimport { missing } from './missing';\nexport const a = b + missing;\n",
      "utf8",
    );
    await fsp.writeFile(path.join(srcDir, "b.ts"), "import { a } from './a';\nexport const b = a;\n", "utf8");
    await fsp.writeFile(
      path.join(testDir, "spec.ts"),
      "import { a } from '../src/a';\nexport const spec = a;\n",
      "utf8",
    );

    const readReport = (stdout: string) =>
      JSON.parse(stdout) as {
        files: { total: number; byLanguage: Record<string, number> };
        hotspots: Array<{ file: string; fanIn: number; fanOut: number; score: number }>;
        unresolved: { total: number; top: Array<{ name: string; importerCount: number }> };
        cycles: { total: number; top: Array<{ files: string[]; size: number }> };
        indexCache?: { manifestPath: string };
      };
    const expectScopedReport = (report: ReturnType<typeof readReport>) => {
      expect(report.files.total).toBe(2);
      expect(report.files.byLanguage.ts).toBe(2);
      expect(report.hotspots).toEqual([
        {
          file: normalize(path.join(srcDir, "a.ts")),
          fanIn: 1,
          fanOut: 2,
          score: 4,
        },
        {
          file: normalize(path.join(srcDir, "b.ts")),
          fanIn: 1,
          fanOut: 1,
          score: 3,
        },
      ]);
      expect(report.unresolved).toEqual({ total: 1, top: [{ name: "./missing", importerCount: 1 }] });
      expect(report.cycles.total).toBe(1);
      expect(report.cycles.top[0]?.files.sort()).toEqual(
        [path.join(srcDir, "a.ts"), path.join(srcDir, "b.ts")].map(normalize).sort(),
      );
      expect(report.cycles.top[0]?.size).toBe(2);
    };

    const coldResult = await runCliCommandDetailed(["inspect", "--root", tmpDir, srcDir, "--limit", "5"]);
    const coldReport = readReport(coldResult.stdout);
    expectScopedReport(coldReport);
    expect(coldReport.indexCache).toBeUndefined();
    expect(coldResult.stderr).not.toContain("Index cache: manifest=");

    await runCliCommand(["index", "--root", tmpDir]);
    const warmResult = await runCliCommandDetailed(["inspect", "--root", tmpDir, srcDir, "--limit", "5"]);
    const warmReport = readReport(warmResult.stdout);
    expectScopedReport(warmReport);
    expect(warmReport.indexCache?.manifestPath).toBe(
      normalize(path.join(tmpDir, ".codegraph-cache", "index-v1", "manifest.json")),
    );
    expect(warmResult.stderr).toContain("Index cache: manifest=");
  });

  it("unresolved filters declared dependencies for scoped roots", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-unresolved-scoped-"));
    try {
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
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("hotspots rejects invalid --limit values", async () => {
    await expect(runCliCommand(["hotspots", "--root", tsRoot, "--limit", "0"])).rejects.toThrow(
      /Invalid --limit value "0"/i,
    );
  });

  it("graph rejects invalid integer options", async () => {
    await expect(runCliCommand(["graph", "--stdout", "--root", tsRoot, "--threads", "1.5"])).rejects.toThrow(
      /Invalid --threads value "1.5"/i,
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
    await fsp.mkdir(path.dirname(targetDir), { recursive: true });
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

  it("skill install creates explicit target parents when the target is safe", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-skill-parent-"));
    const targetDir = skillInstallTarget(tmpDir);

    const stdout = await runCliCommand(["skill", "install", "--target", targetDir]);
    const payload = JSON.parse(stdout) as {
      installed: boolean;
      skillFilePath: string;
      targetDir: string;
    };

    expect(payload.installed).toBe(true);
    expect(normalize(payload.targetDir)).toBe(normalize(targetDir));
    expect(normalize(payload.skillFilePath)).toBe(normalize(path.join(targetDir, "SKILL.md")));
    const installedSkill = await fsp.readFile(path.join(targetDir, "SKILL.md"), "utf8");
    expect(installedSkill).toContain("name: codegraph");
  });

  it("skill install creates missing agent skills directories for safe defaults", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-skill-agent-"));
    const skillsDir = path.join(tmpDir, ".claude", "skills");
    const targetDir = path.join(skillsDir, "codegraph");
    const env = {
      HOME: tmpDir,
      USERPROFILE: tmpDir,
      CODEX_HOME: "",
    };

    const result = await runCliCommandDetailed(
      ["skill", "install", "--agent", "claude"],
      undefined,
      process.cwd(),
      env,
    );
    const payload = JSON.parse(result.stdout) as {
      agent: string;
      installed: boolean;
      skillFilePath: string;
      targetDir: string;
    };

    expect(payload.agent).toBe("claude");
    expect(payload.installed).toBe(true);
    expect(normalize(payload.targetDir)).toBe(normalize(targetDir));
    expect(normalize(payload.skillFilePath)).toBe(normalize(path.join(targetDir, "SKILL.md")));
    const installedSkill = await fsp.readFile(path.join(targetDir, "SKILL.md"), "utf8");
    expect(installedSkill).toContain("name: codegraph");
  });

  it("skill install uses the universal agents skills directory when requested", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-skill-agents-"));
    const skillsDir = path.join(tmpDir, ".agents", "skills");
    const targetDir = path.join(skillsDir, "codegraph");
    const env = {
      HOME: tmpDir,
      USERPROFILE: tmpDir,
      CODEX_HOME: "",
    };

    const result = await runCliCommandDetailed(
      ["skill", "install", "--agent", "agents"],
      undefined,
      process.cwd(),
      env,
    );
    const payload = JSON.parse(result.stdout) as {
      agent: string;
      installed: boolean;
      skillFilePath: string;
      targetDir: string;
    };

    expect(payload.agent).toBe("agents");
    expect(payload.installed).toBe(true);
    expect(normalize(payload.targetDir)).toBe(normalize(targetDir));
    expect(normalize(payload.skillFilePath)).toBe(normalize(path.join(targetDir, "SKILL.md")));
    const installedSkill = await fsp.readFile(path.join(targetDir, "SKILL.md"), "utf8");
    expect(installedSkill).toContain("name: codegraph");
  });

  it("resolves all agent default skill install targets", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-skill-matrix-"));
    const cases: Array<{ agent: SkillInstallAgent; targetDir: string }> = [
      { agent: "agents", targetDir: path.join(tmpDir, ".agents", "skills", "codegraph") },
      { agent: "claude", targetDir: path.join(tmpDir, ".claude", "skills", "codegraph") },
      { agent: "codex", targetDir: path.join(tmpDir, ".codex", "skills", "codegraph") },
      { agent: "cursor", targetDir: path.join(tmpDir, ".cursor", "skills", "codegraph") },
      { agent: "gemini", targetDir: path.join(tmpDir, ".gemini", "skills", "codegraph") },
      { agent: "opencode", targetDir: path.join(tmpDir, ".config", "opencode", "skills", "codegraph") },
    ];

    for (const entry of cases) {
      expect(normalize(getSkillTargetDirForAgent(entry.agent, tmpDir, { CODEX_HOME: "" }))).toBe(
        normalize(entry.targetDir),
      );
    }
    expect(normalize(getSkillTargetDirForAgent("codex", tmpDir, { CODEX_HOME: path.join(tmpDir, "codex-home") }))).toBe(
      normalize(path.join(tmpDir, "codex-home", "skills", "codegraph")),
    );
  });

  it("skill install copies the bundled skill into the Cursor skills directory", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-skill-cursor-"));
    const skillsDir = path.join(tmpDir, ".cursor", "skills");
    const targetDir = path.join(skillsDir, "codegraph");

    await fsp.mkdir(skillsDir, { recursive: true });
    const result = await runCliCommandDetailed(["skill", "install", "--target", targetDir], undefined, tmpDir);
    const payload = JSON.parse(result.stdout) as {
      installed: boolean;
      skillFilePath: string;
      targetDir: string;
    };

    expect(payload.installed).toBe(true);
    expect(normalize(payload.targetDir)).toBe(normalize(targetDir));
    expect(normalize(payload.skillFilePath)).toBe(normalize(path.join(targetDir, "SKILL.md")));
    const skill = await fsp.readFile(path.join(targetDir, "SKILL.md"), "utf8");
    expect(skill).toContain("name: codegraph");
  });

  it("skill doctor reports an agent-specific default target", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-cli-skill-doctor-agent-"));
    const targetDir = path.join(tmpDir, ".config", "opencode", "skills", "codegraph");
    const env = {
      HOME: tmpDir,
      USERPROFILE: tmpDir,
      CODEX_HOME: "",
    };

    await fsp.mkdir(path.dirname(targetDir), { recursive: true });
    const result = await runCliCommandDetailed(["skill", "doctor", "--agent", "opencode"], undefined, process.cwd(), env);
    const report = JSON.parse(result.stdout) as {
      agent?: string;
      defaultTargetDir: string;
      installTargetDir: string;
      requestedTargetDir?: string;
    };

    expect(report.agent).toBe("opencode");
    expect(normalize(report.defaultTargetDir)).toBe(normalize(targetDir));
    expect(normalize(report.installTargetDir)).toBe(normalize(targetDir));
    expect(report.requestedTargetDir).toBeUndefined();
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

  it("grep rejects invalid --max-hits values", async () => {
    await expect(
      runCliCommand(["grep", "--root", tsRoot, "--pattern", "helperFunction", "--max-hits", "0"]),
    ).rejects.toThrow(/Invalid --max-hits value "0"/i);
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

  it("search returns ranked agent-ready results", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cli-search-"));
    await fsp.writeFile(
      path.join(root, "auth.ts"),
      "export function validateUser(token: string) { return !!token.length; }\n",
    );
    await fsp.writeFile(
      path.join(root, "main.ts"),
      "import { validateUser } from './auth';\nexport const ok = validateUser('token');\n",
    );

    const stdout = await runCliCommand(["search", "validate user", "--root", root, "--json"]);
    const response = JSON.parse(stdout) as {
      results: Array<{ label: string; rankReasons: string[]; followUps: string[] }>;
    };

    expect(response.results[0]?.label).toContain("validateUser");
    expect(response.results[0]?.rankReasons.length).toBeGreaterThan(0);
    expect(response.results[0]?.followUps.some((cmd) => cmd.includes("codegraph refs"))).toBeTruthy();
  });

  it("orient returns compact first-turn context", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cli-orient-"));
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    await fsp.writeFile(path.join(root, "src", "run.ts"), "export function run() { return 1; }\n");

    const stdout = await runCliCommand(["orient", "src", "--root", root, "--budget", "small", "--json"]);
    const response = JSON.parse(stdout) as {
      schemaVersion: number;
      tree: Array<{ path: string }>;
      handles: Array<{ handle: string }>;
    };

    expect(response.schemaVersion).toBe(1);
    expect(response.tree.some((entry) => entry.path === "src/run.ts")).toBeTruthy();
    expect(response.handles.some((handle) => handle.handle.startsWith("file:"))).toBeTruthy();
  });

  it("orient prints compact pretty output", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cli-orient-pretty-"));
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    await fsp.writeFile(path.join(root, "src", "run.ts"), "export function run() { return 1; }\n");

    const stdout = await runCliCommand(["orient", "src", "--root", root, "--budget", "small", "--pretty"]);

    expect(stdout).toContain("Summary");
    expect(stdout).toContain("Tree");
    expect(stdout).toContain("Recommended next");
    expect(stdout).toContain("codegraph packet get");
    expect(stdout).toContain("file:");
  });

  it("packet get returns a bounded packet for file handles", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cli-packet-"));
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    await fsp.writeFile(path.join(root, "src", "run.ts"), "export function run() { return 1; }\n");

    const stdout = await runCliCommand(["packet", "get", "file:src%2Frun.ts", "--root", root, "--json"]);
    const response = JSON.parse(stdout) as {
      schemaVersion: number;
      kind: string;
      packet: { target: { file?: string } };
    };

    expect(response.schemaVersion).toBe(1);
    expect(response.kind).toBe("file");
    expect(response.packet.target.file).toBe("src/run.ts");
  });

  it("packet get reports accepted prefixes for invalid handles", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cli-packet-invalid-"));

    await expect(runCliCommandDetailed(["packet", "get", "bogus:thing", "--root", root])).rejects.toThrow(
      /Expected one of: file:, symbol:, chunk:, sql:, graph:/,
    );
  });

  it("explain returns compact architecture context", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cli-explain-"));
    await fsp.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");
    await fsp.writeFile(
      path.join(root, "api.ts"),
      "import { validateUser } from './auth';\nexport const ok = validateUser(1);\n",
    );

    const stdout = await runCliCommand(["explain", "auth.ts", "--root", root, "--json"]);
    const response = JSON.parse(stdout) as {
      target: { file: string };
      symbols: Array<{ name: string }>;
      reverseDependencies: Array<{ file: string }>;
    };

    expect(response.target.file).toBe("auth.ts");
    expect(response.symbols.some((symbol) => symbol.name === "validateUser")).toBeTruthy();
    expect(response.reverseDependencies.some((entry) => entry.file === "api.ts")).toBeTruthy();
  });

  it("explain accepts space-separated --max-symbols values", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cli-explain-symbol-limit-"));
    await fsp.writeFile(path.join(root, "many.ts"), "export const one = 1;\nexport const two = 2;\n");

    const stdout = await runCliCommand(["explain", "many.ts", "--root", root, "--max-symbols", "1", "--json"]);
    const response = JSON.parse(stdout) as {
      target: { file: string };
      symbols: Array<{ name: string }>;
      limits: { symbols: number };
    };

    expect(response.target.file).toBe("many.ts");
    expect(response.symbols).toHaveLength(1);
    expect(response.limits.symbols).toBe(1);
  });

  it("explain requires a complete changed-context range", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cli-explain-range-"));
    await fsp.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n");

    await expect(runCliCommandDetailed(["explain", "auth.ts", "--root", root, "--changed-context"])).rejects.toThrow(
      /--changed-context requires --base and --head/,
    );
  });

  it("artifact build writes an agent-ready artifact bundle", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cli-artifact-"));
    const outDir = path.join(root, "out");
    await fsp.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");

    const stdout = await runCliCommand(["artifact", "build", "--root", root, "--out", outDir, "--json"]);
    const result = JSON.parse(stdout) as { manifestPath: string; artifacts: Record<string, string> };

    expect(result.manifestPath.endsWith("manifest.json")).toBeTruthy();
    expect(result.artifacts.sqlite).toBe("codegraph.sqlite");
    expect(await fsp.stat(path.join(outDir, "manifest.json"))).toBeTruthy();
  });

  it("artifact build treats --sqlite as a boolean artifact selector", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cli-artifact-sqlite-"));
    const outDir = path.join(root, "out");
    await fsp.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");

    const stdout = await runCliCommand([
      "artifact",
      "build",
      "--root",
      root,
      "--out",
      outDir,
      "--sqlite",
      "--graph-json",
      "--json",
    ]);
    const result = JSON.parse(stdout) as { artifacts: Record<string, string | undefined> };

    expect(result.artifacts).toEqual({
      sqlite: "codegraph.sqlite",
      graphJson: "graph.json",
    });
    expect(await fsp.stat(path.join(outDir, "codegraph.sqlite"))).toBeTruthy();
    expect(await fsp.stat(path.join(outDir, "graph.json"))).toBeTruthy();
    await expect(fsp.stat(path.join(outDir, "CODEGRAPH_REPORT.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsp.stat(path.join(outDir, "questions.json"))).rejects.toMatchObject({ code: "ENOENT" });
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

  it("impact CLI applies codegraph.config.json discovery ignores to raw diff changed files", async () => {
    const root = await mkTmpDir("dg-impact-config-ignore-");
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    await fsp.mkdir(path.join(root, "tests", "samples"), { recursive: true });
    await fsp.writeFile(
      path.join(root, "codegraph.config.json"),
      JSON.stringify({ discovery: { ignoreGlobs: ["tests/samples/**"] } }),
      "utf8",
    );
    await fsp.writeFile(path.join(root, "src", "main.ts"), "export const main = 1;\n", "utf8");
    await fsp.writeFile(path.join(root, "tests", "samples", "fixture.ts"), "export const fixture = 1;\n", "utf8");
    const diffText = [
      "diff --git a/src/main.ts b/src/main.ts",
      "index 1111111..2222222 100644",
      "--- a/src/main.ts",
      "+++ b/src/main.ts",
      "@@ -1 +1 @@",
      "-export const main = 0;",
      "+export const main = 1;",
      "diff --git a/tests/samples/fixture.ts b/tests/samples/fixture.ts",
      "index 3333333..4444444 100644",
      "--- a/tests/samples/fixture.ts",
      "+++ b/tests/samples/fixture.ts",
      "@@ -1 +1 @@",
      "-export const fixture = 0;",
      "+export const fixture = 1;",
      "",
    ].join("\n");

    const stdout = await runCliCommand(["impact", root, "--provider", "raw"], diffText);
    const report = JSON.parse(stdout) as {
      changedFiles: Array<{ file: string }>;
      diagnostics?: { changedFilesIgnored?: number };
    };

    expect(report.changedFiles.map((entry) => entry.file)).toEqual(["src/main.ts"]);
    expect(report.diagnostics?.changedFilesIgnored).toBe(1);
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

  it("review CLI applies codegraph.config.json discovery ignores to git changed files", async () => {
    const root = await mkTmpDir("dg-review-config-ignore-");
    initGitRepo(root);
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    await fsp.mkdir(path.join(root, "tests", "samples"), { recursive: true });
    await fsp.writeFile(
      path.join(root, "codegraph.config.json"),
      JSON.stringify({ discovery: { ignoreGlobs: ["tests/samples/**"] } }),
      "utf8",
    );
    await fsp.writeFile(path.join(root, "src", "main.ts"), "export function value() { return 1; }\n", "utf8");
    await fsp.writeFile(
      path.join(root, "tests", "samples", "fixture.ts"),
      "export function fixture() { return 1; }\n",
      "utf8",
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "initial"]);

    await fsp.writeFile(path.join(root, "src", "main.ts"), "export function value() { return 2; }\n", "utf8");
    await fsp.writeFile(
      path.join(root, "tests", "samples", "fixture.ts"),
      "export function fixture() { return 2; }\n",
      "utf8",
    );

    const stdout = await runCliCommand(["review", "--root", root, "--base", "HEAD", "--head", "WORKTREE"]);
    const report = JSON.parse(stdout) as {
      status?: string;
      changedFiles: Array<{ file: string }>;
    };

    expect(report.status).toBe("ok");
    expect(report.changedFiles.map((entry) => entry.file)).toEqual(["src/main.ts"]);
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

  it("review CLI accepts space-separated --max-callsites values", async () => {
    const root = await mkTmpDir("dg-review-cli-callsites-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    const featureFile = path.join(srcDir, "feature.ts");
    const consumerFile = path.join(srcDir, "consumer.ts");
    await fsp.writeFile(
      featureFile,
      ["export function greet(name: string) {", "  return `hi ${name}`;", "}", ""].join("\n"),
      "utf8",
    );
    await fsp.writeFile(
      consumerFile,
      ["import { greet } from './feature';", "", "export function run() {", "  return greet('world');", "}", ""].join(
        "\n",
      ),
      "utf8",
    );
    initGitRepo(root);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "initial"]);

    await fsp.writeFile(
      featureFile,
      ["export function greet(name: string) {", "  return `hello ${name}`;", "}", ""].join("\n"),
      "utf8",
    );

    const stdout = await runCliCommand([
      "review",
      "--root",
      root,
      "--base",
      "HEAD",
      "--head",
      "WORKTREE",
      "--include-symbol-details",
      "--max-callsites",
      "0",
    ]);
    const report = JSON.parse(stdout) as {
      changedFiles: Array<{ file: string; symbols?: Array<{ name: string; callsites?: unknown[] }> }>;
    };
    const changedFile = report.changedFiles.find((entry) => entry.file === "src/feature.ts");
    const greet = changedFile?.symbols?.find((symbol) => symbol.name === "greet");

    expect(greet).toBeDefined();
    expect(greet?.callsites).toBeUndefined();
  });

  it("review CLI rejects invalid numeric limits", async () => {
    const root = await mkTmpDir("dg-review-cli-invalid-number-");
    initGitRepo(root);
    await fsp.writeFile(path.join(root, "main.ts"), "export function value() { return 1; }\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "initial"]);

    await fsp.writeFile(path.join(root, "main.ts"), "export function value() { return 2; }\n", "utf8");

    await expect(
      runCliCommand(["review", "--root", root, "--base", "HEAD", "--head", "WORKTREE", "--max-tests", "nope"]),
    ).rejects.toThrow(/Invalid --max-tests value "nope"/i);
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

  it("mcp serve help documents read-only agent tools", async () => {
    const stdout = await runCliCommand(["mcp", "serve", "--help"]);

    expect(stdout).toContain("search");
    expect(stdout).toContain("query_sqlite");
    expect(stdout).toContain("read-only");
  });
});
