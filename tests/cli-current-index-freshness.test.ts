import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import { captureCli, runCliOrThrow } from "./helpers/cli.js";
import { createTempProjectRoot } from "./helpers/filesystem.js";
import { runGit } from "./helpers/git.js";
import { CURRENT_QUERY_FAMILY_CASES } from "./helpers/currentQueryFamilies.js";

const CHECK_START = "Checking project index";
const CHECK_COMPLETE = "Checked project index";
const BUILD_START = "Building project index";
const UPDATE_START = "Updating project index";

async function createFreshnessProject(prefix: string): Promise<string> {
  const root = await createTempProjectRoot(prefix, [
    {
      path: path.join("src", "app.ts"),
      contents: "import { helper } from './helper.js';\nexport function app() {\n  return helper();\n}\n",
    },
    { path: path.join("src", "helper.ts"), contents: "export function helper() {\n  return 1;\n}\n" },
    { path: path.join("src", "unused.ts"), contents: "export const unused = 0;\n" },
    { path: path.join("tests", "app.test.ts"), contents: "import { app } from '../src/app.js';\napp();\n" },
  ]);
  runGit(root, ["init"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "initial"]);
  return root;
}

// One representative command per current-query wiring family, plus the whole-project graph
// summaries that historically bypassed the incremental loader and one AgentSession-backed
// command. The exhaustive mutation matrix lives in tests/load-current-index.test.ts.
const FAMILIES: Array<{ name: string; args: (root: string) => string[] }> = [
  ...CURRENT_QUERY_FAMILY_CASES.map((entry) => ({
    name: `${entry.family} (${entry.command})`,
    args: entry.args,
  })),
  { name: "project summary (apisurface)", args: (root: string) => ["apisurface", "--root", root, "--json"] },
  { name: "project summary (cycles)", args: (root: string) => ["cycles", "--root", root, "--json"] },
  { name: "scoped summary (hotspots)", args: (root: string) => ["hotspots", "--root", root, "--json"] },
  { name: "agent-session (search)", args: (root: string) => ["search", "helper", "--root", root, "--json"] },
];

function stableJson(raw: string): unknown {
  const parsed: unknown = JSON.parse(raw);
  return stripNondeterministic(parsed);
}

function stripNondeterministic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNondeterministic);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      // Timings and cache provenance legitimately differ between a cold and a warm run.
      const isVolatile =
        key === "timings" ||
        key === "elapsedMs" ||
        key === "generatedAt" ||
        key === "freshness" ||
        key === "indexCache";
      if (isVolatile) continue;
      result[key] = stripNondeterministic(entry);
    }
    return result;
  }
  return value;
}

describe("CLI current-state index freshness", () => {
  it.each(FAMILIES)("validates instead of rebuilding on a warm run: $name", async (family) => {
    const root = await createFreshnessProject("dg-freshness-family-");
    const args = [...family.args(root), "--progress"];

    const cold = await captureCli(args);
    expect(cold.exitCode ?? 0).toBe(0);

    const warm = await captureCli(args);
    expect(warm.exitCode ?? 0).toBe(0);
    expect(warm.stderr).toContain(CHECK_START);
    expect(warm.stderr).toContain(CHECK_COMPLETE);
    expect(warm.stderr).not.toContain(BUILD_START);
    expect(warm.stderr).not.toContain(UPDATE_START);
    expect(stableJson(warm.stdout)).toEqual(stableJson(cold.stdout));
  });

  it("requires no manual index or sync before the first query", async () => {
    const root = await createFreshnessProject("dg-freshness-cold-");
    const result = await runCliOrThrow(["deps", "src/app.ts", "--root", root, "--json"]);
    expect(JSON.parse(result.stdout)).toEqual([{ file: `${root.replace(/\\/g, "/")}/src/helper.ts`, depth: 1 }]);
    await expect(fsp.stat(path.join(root, ".codegraph", "cache", "index-v1", "manifest.json"))).resolves.toBeDefined();
  });

  it("observes a repository change automatically on the next query", async () => {
    const root = await createFreshnessProject("dg-freshness-mutate-");
    await runCliOrThrow(["deps", "src/app.ts", "--root", root, "--json"]);

    await fsp.writeFile(path.join(root, "src", "extra.ts"), "export function extra() {\n  return 2;\n}\n", "utf8");
    await fsp.writeFile(
      path.join(root, "src", "app.ts"),
      "import { helper } from './helper.js';\nimport { extra } from './extra.js';\nexport function app() {\n  return helper() + extra();\n}\n",
      "utf8",
    );

    const updated = await runCliOrThrow(["deps", "src/app.ts", "--root", root, "--json", "--progress"]);
    const dependencies = (JSON.parse(updated.stdout) as Array<{ file: string }>).map((entry) =>
      path.posix.basename(entry.file),
    );
    expect(dependencies.sort()).toEqual(["extra.ts", "helper.ts"]);
    expect(updated.stderr).toContain(CHECK_START);
  });

  it("keeps the diff range out of index freshness for impact", async () => {
    const root = await createFreshnessProject("dg-freshness-impact-range-");
    await fsp.writeFile(path.join(root, "src", "helper.ts"), "export function helper() {\n  return 42;\n}\n", "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "change helper"]);

    const warmup = await captureCli(["impact", "--root", root, "--base", "HEAD~1", "--json", "--progress"]);
    expect(warmup.exitCode ?? 0).toBe(0);

    // A different diff range must not invalidate the index it just validated.
    const warm = await captureCli(["impact", "--root", root, "--base", "HEAD", "--json", "--progress"]);
    expect(warm.exitCode ?? 0).toBe(0);
    expect(warm.stderr).toContain(CHECK_COMPLETE);
    expect(warm.stderr).not.toContain(BUILD_START);
    expect(warm.stderr).not.toContain(UPDATE_START);
  });

  it("bypasses persisted reuse with --cache off", async () => {
    const root = await createFreshnessProject("dg-freshness-cache-off-");
    await runCliOrThrow(["deps", "src/app.ts", "--root", root, "--json"]);
    const result = await captureCli(["deps", "src/app.ts", "--root", root, "--json", "--cache", "off", "--progress"]);
    expect(result.exitCode ?? 0).toBe(0);
    expect(result.stderr).not.toContain(CHECK_COMPLETE);
  });
});
