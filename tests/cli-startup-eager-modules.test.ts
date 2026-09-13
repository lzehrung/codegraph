import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cliPath = path.resolve(process.cwd(), "dist", "cli.js");

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

function modulePathEndsWith(moduleUrl: string, suffix: string): boolean {
  return moduleUrl.includes(suffix.replaceAll("\\", "/")) || moduleUrl.includes(suffix.replaceAll("/", "\\"));
}

/**
 * Basenames of heavy command modules that the CLI dispatcher family must keep behind dynamic
 * `import()`. A command may load its own module only when that command runs.
 */
const HEAVY_COMMAND_MODULES = [
  "artifact.js",
  "call-hierarchy.js",
  "chunk.js",
  "config.js",
  "discovery-globs.js",
  "doctor.js",
  "drift.js",
  "duplicates.js",
  "explain.js",
  "explore.js",
  "file.js",
  "git.js",
  "graph-builder.js",
  "graph.js",
  "graph-delta.js",
  "graph-queries.js",
  "grep.js",
  "impact.js",
  "include-roots.js",
  "inspect.js",
  "install.js",
  "lifecycle.js",
  "manifest.js",
  "mcp.js",
  "navigation.js",
  "orient.js",
  "packet.js",
  "project-files.js",
  "refactor-plan.js",
  "rename-preview.js",
  "review.js",
  "search.js",
  "skill.js",
  "sql.js",
  "symbols.js",
  "type-hierarchy.js",
  "windows-process-drain.js",
];

function assertNoHeavyCommandModulesLoaded(modules: string[], exempt: readonly string[] = []): void {
  const exemptSet = new Set(exempt);
  for (const moduleName of HEAVY_COMMAND_MODULES) {
    if (exemptSet.has(moduleName)) continue;
    expect(
      modules.some((url) => modulePathEndsWith(url, `/${moduleName}`)),
      `unexpected eager load of ${moduleName}`,
    ).toBe(false);
  }
}

describe("CLI startup eager module loading", () => {
  it("keeps lightweight CLI commands within the startup module budget", () => {
    const noArgs = countDistModulesLoaded([]);
    expect(noArgs.status).toBe(0);
    expect(noArgs.stdout).toContain("Start here:");
    expect(noArgs.count).toBeLessThan(30);
    assertNoHeavyCommandModulesLoaded(noArgs.modules);

    const version = countDistModulesLoaded(["--version"]);
    expect(version.status).toBe(0);
    expect(version.stdout.trim().length).toBeGreaterThan(0);
    expect(version.count).toBeLessThan(30);
    assertNoHeavyCommandModulesLoaded(version.modules);

    const help = countDistModulesLoaded(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage:");
    expect(help.count).toBeLessThan(30);
    assertNoHeavyCommandModulesLoaded(help.modules);

    const doctor = countDistModulesLoaded(["doctor", "--json"]);
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain('"package"');
    // Doctor inspects the native addon, which legitimately registers the Windows teardown drain,
    // but not the document-link extractors.
    expect(doctor.count).toBeLessThan(33);
    expect(doctor.modules.some((url) => modulePathEndsWith(url, "/document-links.js"))).toBe(false);
    // Doctor is expected to load its own command module; every other heavy command module must not.
    expect(doctor.modules.some((url) => modulePathEndsWith(url, "/doctor.js"))).toBe(true);
    assertNoHeavyCommandModulesLoaded(doctor.modules, ["doctor.js", "windows-process-drain.js"]);
  });
  it("keeps no-argument eager module count within a small factor of --version", () => {
    const noArgs = countDistModulesLoaded([]);
    const version = countDistModulesLoaded(["--version"]);
    expect(noArgs.status).toBe(0);
    expect(version.status).toBe(0);
    // Deterministic contract: bare entry must not load a large multiple of --version modules.
    expect(noArgs.count).toBeLessThanOrEqual(Math.max(version.count * 2, version.count + 10));
    expect(noArgs.count).toBeGreaterThanOrEqual(version.count);
  });
});
