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

describe("CLI startup eager module loading", () => {
  it("keeps lightweight CLI commands within the startup module budget", () => {
    const noArgs = countDistModulesLoaded([]);
    expect(noArgs.status).toBe(0);
    expect(noArgs.stdout).toContain("Start here:");
    expect(noArgs.count).toBeLessThan(30);
    expect(noArgs.modules.some((url) => modulePathEndsWith(url, "/project-files.js"))).toBe(false);
    expect(noArgs.modules.some((url) => modulePathEndsWith(url, "/config.js"))).toBe(false);
    expect(noArgs.modules.some((url) => modulePathEndsWith(url, "/windows-process-drain.js"))).toBe(false);

    const version = countDistModulesLoaded(["--version"]);
    expect(version.status).toBe(0);
    expect(version.stdout.trim().length).toBeGreaterThan(0);
    expect(version.count).toBeLessThan(30);
    expect(version.modules.some((url) => modulePathEndsWith(url, "/duplicates.js"))).toBe(false);
    expect(version.modules.some((url) => modulePathEndsWith(url, "/project-files.js"))).toBe(false);
    expect(version.modules.some((url) => modulePathEndsWith(url, "/config.js"))).toBe(false);
    expect(version.modules.some((url) => modulePathEndsWith(url, "/git.js"))).toBe(false);
    expect(version.modules.some((url) => modulePathEndsWith(url, "/windows-process-drain.js"))).toBe(false);

    const help = countDistModulesLoaded(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage:");
    expect(help.count).toBeLessThan(30);
    expect(help.modules.some((url) => modulePathEndsWith(url, "/duplicates.js"))).toBe(false);
    expect(help.modules.some((url) => modulePathEndsWith(url, "/project-files.js"))).toBe(false);
    expect(help.modules.some((url) => modulePathEndsWith(url, "/windows-process-drain.js"))).toBe(false);

    const doctor = countDistModulesLoaded(["doctor", "--json"]);
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain('"package"');
    // Doctor loads the native runtime, but not the document-link extractors.
    expect(doctor.count).toBeLessThan(33);
    expect(doctor.modules.some((url) => modulePathEndsWith(url, "/document-links.js"))).toBe(false);
    expect(doctor.modules.some((url) => modulePathEndsWith(url, "/duplicates.js"))).toBe(false);
    expect(doctor.modules.some((url) => modulePathEndsWith(url, "/project-files.js"))).toBe(false);
    expect(doctor.modules.some((url) => modulePathEndsWith(url, "/config.js"))).toBe(false);
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
