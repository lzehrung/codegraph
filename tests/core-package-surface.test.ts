import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectCorePackageFiles, isForbiddenCorePackagePath } from "../scripts/stage-core-package-lib.mjs";

const repoRoot = process.cwd();
const distRoot = path.join(repoRoot, "dist");
const corePackagePath = path.join(repoRoot, "packages", "codegraph-core", "package.json");
const rootPackagePath = path.join(repoRoot, "package.json");

describe("codegraph-core package surface", () => {
  it("stages library entrypoints without CLI, MCP, installer, or bin modules", () => {
    expect(fs.existsSync(path.join(distRoot, "index.js"))).toBe(true);
    const files = collectCorePackageFiles(distRoot);
    expect(files.length).toBeGreaterThan(100);
    expect(files.some(isForbiddenCorePackagePath)).toBe(false);
    expect(files).toContain("agent/query-index/queryIndexWorker.js");
    expect(files.some((file) => file.includes("mcp/"))).toBe(false);
    expect(files.some((file) => file.startsWith("cli/") || file.includes("/cli/"))).toBe(false);
  });

  it("publishes a dependency set without MCP or installer-only packages", () => {
    const corePackage = JSON.parse(fs.readFileSync(corePackagePath, "utf8")) as {
      name: string;
      dependencies: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      exports: Record<string, unknown>;
    };
    const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, "utf8")) as {
      dependencies: Record<string, string>;
    };

    expect(corePackage.name).toBe("@lzehrung/codegraph-core");
    expect(Object.keys(corePackage.exports).sort()).toEqual([
      ".",
      "./agent",
      "./graphs",
      "./impact",
      "./indexer",
      "./languages",
    ]);
    expect(corePackage.dependencies["fast-glob"]).toBeTruthy();
    expect(corePackage.dependencies.zod).toBeTruthy();
    expect(corePackage.dependencies["@modelcontextprotocol/server"]).toBeUndefined();
    expect(corePackage.dependencies["@modelcontextprotocol/node"]).toBeUndefined();
    expect(corePackage.dependencies["jsonc-parser"]).toBeUndefined();
    expect(corePackage.dependencies["smol-toml"]).toBeUndefined();
    expect(corePackage.optionalDependencies?.["@lzehrung/codegraph-native"]).toBeTruthy();
    expect(rootPackage.dependencies["@lzehrung/codegraph-core"]).toBeTruthy();
    expect(rootPackage.dependencies["@modelcontextprotocol/server"]).toBeTruthy();
    expect(rootPackage.dependencies["jsonc-parser"]).toBeTruthy();
  });
});
