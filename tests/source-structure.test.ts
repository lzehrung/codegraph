import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

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
      "src/util/specifiers.ts",
      "src/util/workspace.ts",
    ];

    for (const relativePath of expectedModules) {
      expect(fs.existsSync(path.join(repoRoot, relativePath)), relativePath).toBeTruthy();
    }
    expect(sourceLineCount("src/util.ts")).toBeLessThanOrEqual(80);
  });
});
