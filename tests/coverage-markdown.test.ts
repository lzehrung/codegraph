import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { describe, expect, it } from "vitest";
import { parseLcov, writeCoverageMarkdownReports } from "../scripts/coverage-markdown-lib.mjs";

const repoPrettierConfigPath = fileURLToPath(new URL("../.prettierrc.json", import.meta.url));
const compactTableSeparator = "| --- | ---: | ---: | ---: |";

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-coverage-md-"));
}

function writeJsLcovFixture(rootDir: string) {
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

  it("writes Prettier-formatted Markdown summaries from available LCOV reports", async () => {
    const rootDir = createTempRoot();
    writeJsLcovFixture(rootDir);

    const writtenPaths = await writeCoverageMarkdownReports({ rootDir, mode: "js" });
    const markdownPath = path.join(rootDir, "docs", "coverage", "js.md");
    const indexPath = path.join(rootDir, "docs", "coverage", "README.md");
    const markdown = fs.readFileSync(markdownPath, "utf8");
    const index = fs.readFileSync(indexPath, "utf8");

    expect(writtenPaths).toContain(markdownPath);
    expect(writtenPaths).toContain(indexPath);
    expect(markdown).toContain("# JavaScript/TypeScript Coverage");
    expect(markdown).toContain("| Lines     |   2 |     6 |   33.33% |");
    expect(markdown).toContain("| `src/uncovered.ts` |   0.00% |     0.00% |    0.00% |");
    expect(markdown).toContain("## Type-Only Or Re-Export Files");
    expect(markdown).toContain("| `src/types.ts` | 0.00% |       n/a |      n/a |");
    expect(markdown).not.toContain("| Lines | 2 | 6 | 33.33% |");
    expect(markdown).not.toContain(compactTableSeparator);
    expect(index).toContain("[JavaScript/TypeScript](./js.md)");
    expect(index).toContain("npm run coverage:markdown");
  });

  it("writes Markdown that already matches Prettier and is byte-stable across reruns", async () => {
    const rootDir = createTempRoot();
    writeJsLcovFixture(rootDir);
    const markdownPath = path.join(rootDir, "docs", "coverage", "js.md");

    await writeCoverageMarkdownReports({ rootDir, mode: "js" });
    const first = fs.readFileSync(markdownPath);
    await writeCoverageMarkdownReports({ rootDir, mode: "js" });
    const second = fs.readFileSync(markdownPath);
    expect(second).toEqual(first);

    const prettierConfig = await prettier.resolveConfig(repoPrettierConfigPath);
    if (!prettierConfig) {
      throw new Error(`Unable to resolve Prettier config from ${repoPrettierConfigPath}`);
    }
    const markdown = first.toString("utf8");
    const formatted = await prettier.format(markdown, {
      ...prettierConfig,
      filepath: markdownPath,
    });
    expect(markdown).toBe(formatted);
    expect(markdown).not.toContain(compactTableSeparator);
  });
});
