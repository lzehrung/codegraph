import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseLcov, writeCoverageMarkdownReports } from "../scripts/coverage-markdown-lib.mjs";

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-coverage-md-"));
}

describe("coverage markdown reports", () => {
  it("parses LCOV summary and detail records", () => {
    const rootDir = createTempRoot();
    const sourcePath = path.join(rootDir, "src", "example.ts");
    const parsed = parseLcov(
      [
        `SF:${sourcePath}`,
        "FN:1,used",
        "FN:5,unused",
        "FNDA:3,used",
        "FNDA:0,unused",
        "DA:1,3",
        "DA:2,0",
        "BRDA:1,0,0,2",
        "BRDA:1,0,1,-",
        "end_of_record",
      ].join("\n"),
      rootDir,
    );

    expect(parsed.totals.lines).toEqual({ found: 2, hit: 1 });
    expect(parsed.totals.functions).toEqual({ found: 2, hit: 1 });
    expect(parsed.totals.branches).toEqual({ found: 2, hit: 1 });
    expect(parsed.files[0]?.file).toBe("src/example.ts");
  });

  it("writes compact Markdown summaries from available LCOV reports", () => {
    const rootDir = createTempRoot();
    const jsCoverageDir = path.join(rootDir, "coverage", "js");
    fs.mkdirSync(jsCoverageDir, { recursive: true });
    fs.writeFileSync(
      path.join(jsCoverageDir, "lcov.info"),
      [
        "SF:src/covered.ts",
        "DA:1,1",
        "DA:2,1",
        "LF:2",
        "LH:2",
        "FNF:1",
        "FNH:1",
        "BRF:0",
        "BRH:0",
        "end_of_record",
        "SF:src/uncovered.ts",
        "DA:1,0",
        "DA:2,0",
        "LF:2",
        "LH:0",
        "FNF:1",
        "FNH:0",
        "BRF:1",
        "BRH:0",
        "end_of_record",
        "SF:src/types.ts",
        "DA:1,0",
        "DA:2,0",
        "LF:2",
        "LH:0",
        "FNF:0",
        "FNH:0",
        "BRF:0",
        "BRH:0",
        "end_of_record",
      ].join("\n"),
      "utf8",
    );

    const writtenPaths = writeCoverageMarkdownReports({ rootDir, mode: "js" });
    const markdownPath = path.join(rootDir, "docs", "coverage", "js.md");
    const indexPath = path.join(rootDir, "docs", "coverage", "README.md");
    const markdown = fs.readFileSync(markdownPath, "utf8");
    const index = fs.readFileSync(indexPath, "utf8");

    expect(writtenPaths).toContain(markdownPath);
    expect(writtenPaths).toContain(indexPath);
    expect(markdown).toContain("# JavaScript/TypeScript Coverage");
    expect(markdown).toContain("| Lines | 2 | 6 | 33.33% |");
    expect(markdown).toContain("| `src/uncovered.ts` | 0.00% | 0.00% | 0.00% |");
    expect(markdown).toContain("## Type-Only Or Re-Export Files");
    expect(markdown).toContain("| `src/types.ts` | 0.00% | n/a | n/a |");
    expect(index).toContain("[JavaScript/TypeScript](./js.md)");
    expect(index).toContain("npm run coverage:markdown");
  });
});
