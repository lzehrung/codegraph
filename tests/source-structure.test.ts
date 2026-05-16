import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceLineCount(relativePath: string): number {
  const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8").trimEnd();
  return source.split(/\r?\n/).length;
}

describe("source module structure", () => {
  test("keeps shared utility concerns in focused modules", () => {
    const expectedModules = [
      "src/util/ast.ts",
      "src/util/comments.ts",
      "src/util/git.ts",
      "src/util/paths.ts",
      "src/util/projectFiles.ts",
      "src/util/resolution.ts",
      "src/util/resolutionCandidates.ts",
      "src/util/specifiers.ts",
      "src/util/workspace.ts",
    ];

    for (const relativePath of expectedModules) {
      expect(fs.existsSync(path.join(repoRoot, relativePath)), relativePath).toBeTruthy();
    }
    expect(sourceLineCount("src/util.ts")).toBeLessThanOrEqual(80);
    expect(fs.readFileSync(path.join(repoRoot, "src/util/workspace.ts"), "utf8")).not.toContain("./resolution.js");
    expect(fs.readFileSync(path.join(repoRoot, "src/util/resolutionCandidates.ts"), "utf8")).not.toContain("./workspace.js");
  });

  test("keeps the native crate split by runtime concern", () => {
    const expectedModules = [
      "packages/codegraph-native/src/languages.rs",
      "packages/codegraph-native/src/parser_pool.rs",
      "packages/codegraph-native/src/projection.rs",
      "packages/codegraph-native/src/query.rs",
      "packages/codegraph-native/src/types.rs",
    ];

    for (const relativePath of expectedModules) {
      expect(fs.existsSync(path.join(repoRoot, relativePath)), relativePath).toBeTruthy();
    }
    expect(sourceLineCount("packages/codegraph-native/src/lib.rs")).toBeLessThanOrEqual(280);
  });

  test("keeps standalone CLI commands in command modules", () => {
    const expectedModules = [
      "src/cli/chunk.ts",
      "src/cli/artifact.ts",
      "src/cli/doctor.ts",
      "src/cli/explain.ts",
      "src/cli/graphDelta.ts",
      "src/cli/help.ts",
      "src/cli/mcp.ts",
      "src/cli/packageInfo.ts",
      "src/cli/search.ts",
      "src/cli/skill.ts",
      "src/cli/sql.ts",
    ];

    for (const relativePath of expectedModules) {
      expect(fs.existsSync(path.join(repoRoot, relativePath)), relativePath).toBeTruthy();
    }
    expect(sourceLineCount("src/cli.ts")).toBeLessThanOrEqual(2400);
  });
});
