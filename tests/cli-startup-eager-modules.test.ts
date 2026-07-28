import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cliPath = path.resolve(process.cwd(), "dist", "cli.js");
const sourceCliPath = path.resolve(process.cwd(), "src", "cli.ts");
const workerPoolPath = path.resolve(process.cwd(), "src", "worker", "nativeWorkerPool.ts");

/** Project modules under dist/ that load while handling lightweight CLI entrypoints. */
function countDistModulesLoaded(args: string[]): {
  count: number;
  modules: string[];
  stdout: string;
  status: number | null;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-eager-modules-"));
  const preloadPath = path.join(dir, "count-dist-modules.mjs");
  fs.writeFileSync(
    preloadPath,
    `import { registerHooks } from "node:module";
const loaded = new Set();
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && /[/\\\\]dist[/\\\\]/.test(url) && url.endsWith(".js")) {
      loaded.add(url);
    }
    return nextLoad(url, context);
  },
});
process.on("exit", () => {
  console.error(\`MODULE_COUNT=\${loaded.size}\`);
  for (const url of [...loaded].sort()) console.error(\`MODULE=\${url}\`);
});
`,
  );

  try {
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(preloadPath).href, cliPath, ...args], {
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    const stderr = result.stderr ?? "";
    const match = /MODULE_COUNT=(\d+)/.exec(stderr);
    if (!match) {
      throw new Error(`Failed to count modules for ${args.join(" ")}. status=${result.status} stderr=${result.stderr}`);
    }
    const modules = [...stderr.matchAll(/^MODULE=(.+)$/gm)].map((entry) => entry[1]!);
    return { count: Number(match[1]), modules, stdout: result.stdout ?? "", status: result.status };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function measureCliStartup(args: string[]): number {
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  if (result.status !== 0) {
    throw new Error(`CLI startup failed for ${args.join(" ")}: ${result.stderr}`);
  }
  return performance.now() - startedAt;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function modulePathEndsWith(moduleUrl: string, suffix: string): boolean {
  return moduleUrl.includes(suffix.replaceAll("\\", "/")) || moduleUrl.includes(suffix.replaceAll("/", "\\"));
}

describe("CLI startup eager module loading", () => {
  it("keeps command handlers and heavy discovery behind dynamic import()", async () => {
    const source = await fs.promises.readFile(sourceCliPath, "utf8");
    const staticHandlerImports = [
      'from "./cli/chunk.js"',
      'from "./cli/doctor.js"',
      'from "./cli/drift.js"',
      'from "./cli/duplicates.js"',
      'from "./cli/explain.js"',
      'from "./cli/explore.js"',
      'from "./cli/file.js"',
      'from "./cli/graphDelta.js"',
      'from "./cli/graphQueries.js"',
      'from "./cli/grep.js"',
      'from "./cli/impact.js"',
      'from "./cli/install.js"',
      'from "./cli/lifecycle.js"',
      'from "./cli/index.js"',
      'from "./cli/inspect.js"',
      'from "./cli/orient.js"',
      'from "./cli/navigation.js"',
      'from "./cli/packet.js"',
      'from "./cli/review.js"',
      'from "./cli/search.js"',
      'from "./cli/skill.js"',
      'from "./cli/symbols.js"',
      'from "./cli/typeHierarchy.js"',
      'from "./cli/callHierarchy.js"',
      'from "./cli/renamePreview.js"',
      'from "./cli/refactorPlan.js"',
      'from "./cli/artifact.js"',
      'from "./cli/graph.js"',
      'from "./cli/mcp.js"',
      'from "./cli/sql.js"',
      'from "./graph-builder.js"',
      'from "./lifecycle/manifest.js"',
      'from "./config.js"',
      'from "./util/git.js"',
      'from "./util/projectFiles.js"',
      'from "./cli/discoveryGlobs.js"',
      'from "./util/includeRoots.js"',
    ];

    for (const line of source.split(/\r?\n/)) {
      if (!line.startsWith("import ")) continue;
      if (line.startsWith("import type ")) continue;
      for (const fragment of staticHandlerImports) {
        expect(line, `unexpected static import of ${fragment}`).not.toContain(fragment);
      }
    }

    expect(source).toContain('await import("./cli/orient.js")');
    expect(source).toContain('await import("./cli/search.js")');
    expect(source).toContain('await import("./cli/doctor.js")');
    expect(source).toContain("loadConfigHelpers");
    expect(source).toContain("loadProjectFilesHelpers");
  });

  it("keeps os.cpus() behind worker-pool sizing, not module scope", async () => {
    const source = await fs.promises.readFile(workerPoolPath, "utf8");
    expect(source).toMatch(/function resolveThreadCount\([\s\S]*os\.cpus\(\)/);
    const moduleScope = source.split("function resolveThreadCount")[0] ?? "";
    expect(moduleScope).not.toContain("os.cpus()");
  });

  it("loads fewer than 30 dist modules for no args, --version, --help, and doctor", () => {
    const noArgs = countDistModulesLoaded([]);
    expect(noArgs.status).toBe(0);
    expect(noArgs.stdout).toContain("Start here:");
    expect(noArgs.count).toBeLessThan(30);
    expect(noArgs.modules.some((url) => modulePathEndsWith(url, "/projectFiles.js"))).toBe(false);
    expect(noArgs.modules.some((url) => modulePathEndsWith(url, "/config.js"))).toBe(false);

    const version = countDistModulesLoaded(["--version"]);
    expect(version.status).toBe(0);
    expect(version.stdout.trim().length).toBeGreaterThan(0);
    expect(version.count).toBeLessThan(30);
    expect(version.modules.some((url) => modulePathEndsWith(url, "/duplicates.js"))).toBe(false);
    expect(version.modules.some((url) => modulePathEndsWith(url, "/projectFiles.js"))).toBe(false);
    expect(version.modules.some((url) => modulePathEndsWith(url, "/config.js"))).toBe(false);
    expect(version.modules.some((url) => modulePathEndsWith(url, "/git.js"))).toBe(false);

    const help = countDistModulesLoaded(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage:");
    expect(help.count).toBeLessThan(30);
    expect(help.modules.some((url) => modulePathEndsWith(url, "/duplicates.js"))).toBe(false);
    expect(help.modules.some((url) => modulePathEndsWith(url, "/projectFiles.js"))).toBe(false);

    const doctor = countDistModulesLoaded(["doctor", "--json"]);
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain('"package"');
    expect(doctor.count).toBeLessThan(30);
    expect(doctor.modules.some((url) => modulePathEndsWith(url, "/duplicates.js"))).toBe(false);
    expect(doctor.modules.some((url) => modulePathEndsWith(url, "/projectFiles.js"))).toBe(false);
    expect(doctor.modules.some((url) => modulePathEndsWith(url, "/config.js"))).toBe(false);
  });
  it("keeps no-argument median startup within 10% of --version", () => {
    measureCliStartup([]);
    measureCliStartup(["--version"]);
    const noArgsSamples: number[] = [];
    const versionSamples: number[] = [];
    for (let sample = 0; sample < 11; sample += 1) {
      if (sample % 2) {
        noArgsSamples.push(measureCliStartup([]));
        versionSamples.push(measureCliStartup(["--version"]));
      } else {
        versionSamples.push(measureCliStartup(["--version"]));
        noArgsSamples.push(measureCliStartup([]));
      }
    }

    expect(median(noArgsSamples) / median(versionSamples)).toBeLessThanOrEqual(1.1);
  });
});
