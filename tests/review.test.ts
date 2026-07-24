import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import {
  buildProjectIndex,
  buildProjectIndexFromFiles,
  buildReviewReport,
  type ReviewBuildReport,
  type ReviewReport,
} from "../src/index.js";
import * as indexerBuild from "../src/indexer/build-index.js";
import * as indexerNavigation from "../src/indexer/navigation.js";
import type { BuildReport, IncrementalBuildOptions, SymbolDef } from "../src/indexer/types.js";
import * as impactMap from "../src/impact/map.js";
import { collectDuplicateLeadSummary } from "../src/duplicatesLeads.js";
import { findDuplicates, findDuplicatesWithPreparedAnalysis, prepareDuplicateAnalysis } from "../src/duplicates.js";
import { runGit } from "./helpers/git.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function normalize(file: string): string {
  return file.replace(/\\/g, "/");
}

describe("Review report", () => {
  it("summarizes changed files and symbols", async () => {
    const root = await mkTmpDir("dg-review-");
    const filePath = path.join(root, "foo.ts");
    await fsp.writeFile(filePath, `export const a = 1;\n`, "utf8");

    await buildProjectIndex(root, { cache: "disk", threads: 2 });
    const report = await buildReviewReport(root, {
      cache: "disk",
      files: [filePath],
    });

    expect(report.schemaVersion).toBe(2);
    expect(report.status).toBe("ok");
    expect(report.riskSummary.level).toBeDefined();
    expect(report.reviewTasks.length).toBeGreaterThan(0);
    expect(report.changedFiles.length).toBe(1);
    expect(Array.isArray(report.changedFiles[0]?.symbols)).toBe(true);
    expect(report.changedFiles[0]?.symbols?.some((s) => s.name === "a")).toBe(true);
    expect(Array.isArray(report.candidateTests)).toBe(true);
    expect(report.diagnostics?.missingFiles ?? []).toEqual([]);
  });

  it("includes definition snippets and callsites when enabled", async () => {
    const root = await mkTmpDir("dg-review-details-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    const featureFile = path.join(srcDir, "feature.ts");
    const consumerFile = path.join(srcDir, "consumer.ts");
    await fsp.writeFile(
      featureFile,
      [`export function greet(name: string) {`, `  return \`hi \${name}\`;`, `}`, ``].join("\n"),
      "utf8",
    );
    await fsp.writeFile(
      consumerFile,
      [`import { greet } from './feature';`, ``, `export function run() {`, `  greet('world');`, `}`, ``].join("\n"),
      "utf8",
    );

    await buildProjectIndex(root);
    await fsp.writeFile(
      featureFile,
      [`export function greet(name: string) {`, `  return \`hello \${name}\`;`, `}`, ``].join("\n"),
      "utf8",
    );

    const report = await buildReviewReport(root, {
      files: [featureFile],
      includeSymbolDetails: true,
      maxCallsites: 2,
    });
    const featureSummary = report.changedFiles.find((entry) => entry.file === "src/feature.ts");
    expect(featureSummary).toBeDefined();
    const greetSummary = featureSummary?.symbols.find((symbol) => symbol.name === "greet");
    expect(greetSummary).toBeDefined();
    expect(greetSummary?.definitionSnippet).toContain("function greet");
    const callsites = greetSummary?.callsites ?? [];
    expect(callsites.length).toBeGreaterThan(0);
    expect(callsites.length).toBeLessThanOrEqual(2);
    expect(
      callsites.some(
        (site) => site.file === "src/consumer.ts" && (site.range.start.line === 1 || site.range.start.line === 4),
      ),
    ).toBe(true);
  });

  it("includes call compatibility hints for changed TypeScript signatures", async () => {
    const root = await mkTmpDir("dg-review-call-compat-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    const apiFile = path.join(srcDir, "api.ts");
    const mainFile = path.join(srcDir, "main.ts");
    await fsp.writeFile(apiFile, "export function helper(a: string, b: number) { return a + b; }\n", "utf8");
    await fsp.writeFile(mainFile, 'import { helper } from "./api";\nexport const value = helper("x");\n', "utf8");

    const diffText = [
      "diff --git a/src/api.ts b/src/api.ts",
      "index 1234567..abcdef0 100644",
      "--- a/src/api.ts",
      "+++ b/src/api.ts",
      "@@ -1,1 +1,1 @@",
      "-export function helper(a: string) { return a; }",
      "+export function helper(a: string, b: number) { return a + b; }",
      "",
    ].join("\n");

    const report = await buildReviewReport(root, {
      diffText,
      includeSymbolDetails: true,
      maxCallsites: 5,
    });

    const apiSummary = report.changedFiles.find((entry) => entry.file === "src/api.ts");
    const helper = apiSummary?.symbols.find((symbol) => symbol.name === "helper");
    expect(helper?.callCompatibility).toContainEqual(
      expect.objectContaining({
        status: "likely_mismatch",
        reason: "argument_count_below_minimum",
        callsiteFile: "src/main.ts",
        expected: { minArgs: 2, maxArgs: 2, confidence: "high" },
        actual: { argCount: 1, confidence: "high" },
      }),
    );
  });

  it("preserves copy similarity metadata in changed file summaries", async () => {
    const root = await mkTmpDir("dg-review-copy-metadata-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(path.join(srcDir, "source.ts"), "export function sourceValue() { return 1; }\n", "utf8");
    await fsp.writeFile(path.join(srcDir, "copied.ts"), "export function copiedValue() { return 1; }\n", "utf8");

    const diffText = [
      "diff --git a/src/source.ts b/src/copied.ts",
      "similarity index 91%",
      "copy from src/source.ts",
      "copy to src/copied.ts",
      "--- a/src/source.ts",
      "+++ b/src/copied.ts",
      "@@ -1,1 +1,1 @@",
      "-export function sourceValue() { return 1; }",
      "+export function copiedValue() { return 1; }",
      "",
    ].join("\n");

    const report = await buildReviewReport(root, { diffText });
    const summary = report.changedFiles.find((entry) => entry.file === "src/copied.ts");

    expect(summary).toMatchObject({
      oldFile: "src/source.ts",
      similarityIndex: 91,
    });
  });

  it("omits oldFile metadata for normal modified diffs", async () => {
    const root = await mkTmpDir("dg-review-modified-summary-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(path.join(srcDir, "feature.ts"), "export function feature() { return 1; }\n", "utf8");

    const diffText = [
      "diff --git a/src/feature.ts b/src/feature.ts",
      "index 1234567..abcdef0 100644",
      "--- a/src/feature.ts",
      "+++ b/src/feature.ts",
      "@@ -1,1 +1,1 @@",
      "-export function feature() { return 1; }",
      "+export function feature() { return 2; }",
      "",
    ].join("\n");

    const report = await buildReviewReport(root, { diffText });
    const summary = report.changedFiles.find((entry) => entry.file === "src/feature.ts");

    expect(summary).toBeDefined();
    expect("oldFile" in summary!).toBe(false);
  });

  it("includes call compatibility hints when symbol details are disabled", async () => {
    const root = await mkTmpDir("dg-review-call-compat-summary-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    const apiFile = path.join(srcDir, "api.ts");
    const mainFile = path.join(srcDir, "main.ts");
    await fsp.writeFile(apiFile, "export function helper(a = 1, b: string) { return b; }\n", "utf8");
    await fsp.writeFile(mainFile, 'import { helper } from "./api";\nexport const value = helper("x");\n', "utf8");

    const diffText = [
      "diff --git a/src/api.ts b/src/api.ts",
      "index 1234567..abcdef0 100644",
      "--- a/src/api.ts",
      "+++ b/src/api.ts",
      "@@ -1,1 +1,1 @@",
      "-export function helper(a = 1) { return a; }",
      "+export function helper(a = 1, b: string) { return b; }",
      "",
    ].join("\n");

    const report = await buildReviewReport(root, {
      diffText,
      includeSymbolDetails: false,
      maxCallsites: 5,
    });

    const apiSummary = report.changedFiles.find((entry) => entry.file === "src/api.ts");
    const helper = apiSummary?.symbols.find((symbol) => symbol.name === "helper");
    expect(helper?.definitionSnippet).toBeUndefined();
    expect(helper?.callsites).toBeUndefined();
    expect(helper?.callCompatibility).toContainEqual(
      expect.objectContaining({
        status: "likely_mismatch",
        reason: "argument_count_below_minimum",
        callsiteFile: "src/main.ts",
        expected: { minArgs: 2, maxArgs: 2, confidence: "high" },
        actual: { argCount: 1, confidence: "high" },
      }),
    );
  });

  it("limits symbols to diff hunks and includes diff snippets when provided", async () => {
    const root = await mkTmpDir("dg-review-diff-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    const featureFile = path.join(srcDir, "feature.ts");
    await fsp.writeFile(
      featureFile,
      [`export function alpha() {`, `  return 2;`, `}`, ``, `export function beta() {`, `  return 5;`, `}`, ``].join(
        "\n",
      ),
      "utf8",
    );

    await buildProjectIndex(root);

    const diffText = [
      "diff --git a/src/feature.ts b/src/feature.ts",
      "index 1234567..abcdef0 100644",
      "--- a/src/feature.ts",
      "+++ b/src/feature.ts",
      "@@ -1,3 +1,3 @@",
      " export function alpha() {",
      "-  return 1;",
      "+  return 2;",
      " }",
      "",
    ].join("\n");

    const report = await buildReviewReport(root, {
      files: [featureFile],
      diffText,
      includeSymbolDetails: true,
    });

    const summary = report.changedFiles.find((entry) => entry.file === "src/feature.ts");
    expect(summary).toBeDefined();
    const symbols = summary?.symbols ?? [];
    expect(symbols.some((symbol) => symbol.name === "alpha")).toBe(true);
    expect(symbols.some((symbol) => symbol.name === "beta")).toBe(false);

    const alpha = symbols.find((symbol) => symbol.name === "alpha");
    expect(alpha?.diffSnippets?.some((snippet) => snippet.includes("return 2;"))).toBe(true);
  });

  it("treats raw diff text as a source of changed files", async () => {
    const root = await mkTmpDir("dg-review-diff-only-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    const featureFile = path.join(srcDir, "feature.ts");
    await fsp.writeFile(
      featureFile,
      [`export function alpha() {`, `  return 2;`, `}`, ``, `export function beta() {`, `  return 5;`, `}`, ``].join(
        "\n",
      ),
      "utf8",
    );

    const report = await buildReviewReport(root, {
      diffText: [
        "diff --git a/src/feature.ts b/src/feature.ts",
        "index 1234567..abcdef0 100644",
        "--- a/src/feature.ts",
        "+++ b/src/feature.ts",
        "@@ -1,3 +1,3 @@",
        " export function alpha() {",
        "-  return 1;",
        "+  return 2;",
        " }",
        "",
      ].join("\n"),
      includeSymbolDetails: true,
    });

    expect(report.status).toBe("ok");
    expect(report.summary.filesChanged).toBe(1);
    const summary = report.changedFiles.find((entry) => entry.file === "src/feature.ts");
    expect(summary).toBeDefined();
    const symbols = summary?.symbols ?? [];
    expect(symbols.some((symbol) => symbol.name === "alpha")).toBe(true);
    expect(symbols.some((symbol) => symbol.name === "beta")).toBe(false);
  });

  it("filters raw diff files with discovery ignoreGlobs", async () => {
    const root = await mkTmpDir("dg-review-diff-ignore-");
    const srcDir = path.join(root, "src");
    const sampleDir = path.join(root, "tests", "samples");
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(sampleDir, { recursive: true });
    await fsp.writeFile(path.join(srcDir, "feature.ts"), "export function feature() { return 2; }\n", "utf8");
    await fsp.writeFile(path.join(sampleDir, "fixture.ts"), "export function fixture() { return 2; }\n", "utf8");

    const report = await buildReviewReport(root, {
      discovery: { ignoreGlobs: [" tests\\samples\\** "] },
      diffText: [
        "diff --git a/src/feature.ts b/src/feature.ts",
        "index 1234567..abcdef0 100644",
        "--- a/src/feature.ts",
        "+++ b/src/feature.ts",
        "@@ -1 +1 @@",
        "-export function feature() { return 1; }",
        "+export function feature() { return 2; }",
        "diff --git a/tests/samples/fixture.ts b/tests/samples/fixture.ts",
        "index 1234567..abcdef0 100644",
        "--- a/tests/samples/fixture.ts",
        "+++ b/tests/samples/fixture.ts",
        "@@ -1 +1 @@",
        "-export function fixture() { return 1; }",
        "+export function fixture() { return 2; }",
        "",
      ].join("\n"),
      includeSymbolDetails: true,
    });

    expect(report.status).toBe("ok");
    expect(report.changedFiles.map((entry) => entry.file)).toEqual(["src/feature.ts"]);
  });

  it("filters child-root review files with discovery ignoreGlobs relative to globRoot", async () => {
    const root = await mkTmpDir("dg-review-child-root-diff-ignore-");
    const testsRoot = path.join(root, "tests");
    const unitDir = path.join(testsRoot, "unit");
    const sampleDir = path.join(testsRoot, "samples");
    await fsp.mkdir(unitDir, { recursive: true });
    await fsp.mkdir(sampleDir, { recursive: true });
    await fsp.writeFile(path.join(unitDir, "app.test.ts"), "export function appTest() { return 2; }\n", "utf8");
    await fsp.writeFile(path.join(sampleDir, "fixture.ts"), "export function fixture() { return 2; }\n", "utf8");

    const report = await buildReviewReport(testsRoot, {
      discovery: {
        globRoot: root,
        ignoreGlobs: ["tests/samples/**"],
      },
      diffText: [
        "diff --git a/unit/app.test.ts b/unit/app.test.ts",
        "index 1234567..abcdef0 100644",
        "--- a/unit/app.test.ts",
        "+++ b/unit/app.test.ts",
        "@@ -1 +1 @@",
        "-export function appTest() { return 1; }",
        "+export function appTest() { return 2; }",
        "diff --git a/samples/fixture.ts b/samples/fixture.ts",
        "index 1234567..abcdef0 100644",
        "--- a/samples/fixture.ts",
        "+++ b/samples/fixture.ts",
        "@@ -1 +1 @@",
        "-export function fixture() { return 1; }",
        "+export function fixture() { return 2; }",
        "",
      ].join("\n"),
      includeSymbolDetails: true,
    });

    expect(report.status).toBe("ok");
    expect(report.changedFiles.map((entry) => entry.file)).toEqual(["unit/app.test.ts"]);
  });

  it("rejects raw diff files outside the project root", async () => {
    const root = await mkTmpDir("dg-review-diff-outside-");
    const outsideFile = path.resolve("README.md");

    await expect(
      buildReviewReport(root, {
        diffText: [
          `diff --git a/${outsideFile} b/${outsideFile}`,
          "index 1234567..abcdef0 100644",
          `--- a/${outsideFile}`,
          `+++ b/${outsideFile}`,
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "",
        ].join("\n"),
      }),
    ).rejects.toThrow(/outside project root/);
  });

  it("identifies git-tracked changed files without explicit listings", async () => {
    const root = await mkTmpDir("dg-review-git-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "test@git.local"]);
    runGit(root, ["config", "user.name", "Codegraph Bot"]);
    const filePath = path.join(root, "tracked.ts");
    await fsp.writeFile(filePath, `export const value = 1;\n`, "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);
    await fsp.writeFile(filePath, `export const value = 2;\n`, "utf8");
    runGit(root, ["add", "tracked.ts"]);
    runGit(root, ["commit", "-m", "change"]);

    const base = runGit(root, ["rev-parse", "HEAD^"]);
    const report = await buildReviewReport(root, { gitBase: base });

    expect(report.status).toBe("ok");
    expect(report.summary.filesChanged).toBe(1);
    expect(report.changedFiles[0]?.file).toBe("tracked.ts");
    expect(report.base).toBe(base);
    expect(report.head).toBe("HEAD");
  });

  it("reports modified tracked non-indexed files as updated", async () => {
    const root = await mkTmpDir("dg-review-git-non-indexed-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "test@git.local"]);
    runGit(root, ["config", "user.name", "Codegraph Bot"]);
    const files: Record<string, string> = {
      "build.ps1": "Write-Output 'base'\n",
      "README.md": "# Base\n",
      justfile: "build:\n  echo base\n",
    };
    await Promise.all(
      Object.entries(files).map(async ([file, source]) => await fsp.writeFile(path.join(root, file), source, "utf8")),
    );
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);
    await Promise.all(
      Object.entries(files).map(
        async ([file, source]) => await fsp.writeFile(path.join(root, file), `${source}# changed\n`, "utf8"),
      ),
    );

    const report = await buildReviewReport(root, { gitBase: "HEAD", gitHead: "WORKTREE" });
    const summaries = new Map(report.changedFiles.map((changedFile) => [changedFile.file, changedFile]));

    for (const file of Object.keys(files)) {
      expect(summaries.get(file)).toMatchObject({ status: "updated" });
    }
  });

  it("reuses a complete disk-cached project index for an unchanged git review range", async () => {
    const root = await mkTmpDir("dg-review-git-disk-warm-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "test@git.local"]);
    runGit(root, ["config", "user.name", "Codegraph Bot"]);
    const srcDir = path.join(root, "src");
    const testsDir = path.join(root, "tests");
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(testsDir, { recursive: true });
    await fsp.writeFile(path.join(srcDir, "helper-a.ts"), "export const helperA = () => 1;\n", "utf8");
    await fsp.writeFile(path.join(srcDir, "helper-b.ts"), "export const helperB = () => 2;\n", "utf8");
    await fsp.writeFile(
      path.join(srcDir, "service.ts"),
      "import { helperA } from './helper-a';\nexport const service = () => helperA();\n",
      "utf8",
    );
    await fsp.writeFile(
      path.join(testsDir, "service.test.ts"),
      "import { service } from '../src/service';\nservice();\n",
      "utf8",
    );
    const duplicateSource = [
      "export function normalizeInvoiceRows(rows: Array<{ amount: number; tax: number }>) {",
      "  const totals: number[] = [];",
      "  const labels: string[] = [];",
      "  for (const row of rows) {",
      "    const subtotal = row.amount + row.tax;",
      "    const rounded = Math.round(subtotal * 100) / 100;",
      '    const label = rounded > 100 ? "large" : "small";',
      "    labels.push(label);",
      "    totals.push(rounded);",
      "  }",
      '  return totals.map((value, index) => labels[index] + ":" + value.toFixed(2)).join(",");',
      "}",
      "",
    ].join("\n");
    await fsp.writeFile(path.join(srcDir, "duplicate-a.ts"), duplicateSource, "utf8");
    await fsp.writeFile(path.join(srcDir, "duplicate-b.ts"), duplicateSource, "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);

    await fsp.writeFile(
      path.join(srcDir, "service.ts"),
      "import { helperB } from './helper-b';\nexport const service = () => helperB();\n",
      "utf8",
    );
    await fsp.writeFile(path.join(srcDir, "duplicate-a.ts"), duplicateSource.replace("large", "huge"), "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "review range"]);
    const base = runGit(root, ["rev-parse", "HEAD^"]);

    const coldIndexReport: BuildReport = { timings: {} };
    const cold = await buildReviewReport(root, {
      gitBase: base,
      gitHead: "HEAD",
      cache: "disk",
      report: { timings: {}, indexReport: coldIndexReport },
    });
    const warmIndexReport: BuildReport = { timings: {} };
    const warm = await buildReviewReport(root, {
      gitBase: base,
      gitHead: "HEAD",
      cache: "disk",
      report: { timings: {}, indexReport: warmIndexReport },
    });
    const uncachedIndexReport: BuildReport = { timings: {} };
    const uncached = await buildReviewReport(root, {
      gitBase: base,
      gitHead: "HEAD",
      cache: "off",
      report: { timings: {}, indexReport: uncachedIndexReport },
    });
    const parityView = (report: ReviewReport) => ({
      changedFiles: report.changedFiles,
      changedSymbols: report.changedFiles.flatMap((file) => file.symbols),
      graphDelta: report.graphDelta,
      candidateTests: report.candidateTests,
      duplicateTasks: report.reviewTasks.filter((task) => task.reason === "duplicate-sibling"),
    });

    expect(coldIndexReport.files?.parsed ?? 0).toBeGreaterThan(0);
    expect(warmIndexReport.files?.parsed ?? 0).toBe(0);
    expect(parityView(warm)).toEqual(parityView(cold));
    expect(parityView(uncached)).toEqual(parityView(cold));
    expect(uncachedIndexReport.files?.cached ?? 0).toBe(0);
    expect(uncachedIndexReport.files?.parsed ?? 0).toBe(uncachedIndexReport.files?.total);
    expect(cold.graphDelta.length).toBeGreaterThan(0);
    expect(cold.candidateTests.some((candidate) => candidate.file === "tests/service.test.ts")).toBe(true);
    expect(cold.reviewTasks.some((task) => task.reason === "duplicate-sibling")).toBe(true);
  });

  it("reports the default git head when a git comparison has no changes", async () => {
    const root = await mkTmpDir("dg-review-git-no-changes-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "test@git.local"]);
    runGit(root, ["config", "user.name", "Codegraph Bot"]);
    await fsp.writeFile(path.join(root, "tracked.ts"), `export const value = 1;\n`, "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);

    const report = await buildReviewReport(root, { gitBase: "HEAD" });

    expect(report.status).toBe("no_changes");
    expect(report.base).toBe("HEAD");
    expect(report.head).toBe("HEAD");
  });

  it("reports graph-only analysis for no-change native-off reviews", async () => {
    const root = await mkTmpDir("dg-review-git-no-changes-native-off-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "test@git.local"]);
    runGit(root, ["config", "user.name", "Codegraph Bot"]);
    await fsp.writeFile(path.join(root, "tracked.ts"), `export const value = 1;\n`, "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);
    const indexReport: BuildReport = {
      timings: {},
      backend: {
        native: {
          available: true,
          enabled: false,
          supportedLanguageIds: [],
          filesUsed: 0,
          filesFellBack: 0,
          fallbackReasons: {},
          byLanguage: {},
          errors: [],
        },
      },
    };

    const report = await buildReviewReport(root, {
      gitBase: "HEAD",
      native: "off",
      report: { timings: {}, indexReport },
    });

    expect(report.status).toBe("no_changes");
    expect(report.analysis?.backend).toBe("graph-only");
    expect(report.analysis?.mode).toBe("reduced");
    expect(report.analysis?.label).toBe("reduced graph-only");
  });

  it("applies discovery filters to changed git comparisons", async () => {
    const root = await mkTmpDir("dg-review-git-changed-discovery-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "test@git.local"]);
    runGit(root, ["config", "user.name", "Codegraph Bot"]);
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    await fsp.writeFile(path.join(root, "package.json"), `{"name":"demo"}\n`, "utf8");
    const trackedFile = path.join(root, "src", "tracked.ts");
    await fsp.writeFile(trackedFile, `export const value = 1;\n`, "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);
    await fsp.writeFile(trackedFile, `export const value = 2;\n`, "utf8");
    await fsp.writeFile(path.join(root, "package.json"), `{"name":"demo","version":"1.0.0"}\n`, "utf8");

    const report = await buildReviewReport(root, {
      gitBase: "HEAD",
      gitHead: "WORKTREE",
      discovery: { includeGlobs: ["src/**"], globRoot: root },
    });

    expect(report.status).toBe("ok");
    expect(report.changedFiles.some((changedFile) => changedFile.file === "package.json")).toBe(false);
  });

  it("applies discovery include globs to hidden paths", async () => {
    const root = await mkTmpDir("dg-review-git-dot-discovery-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "test@git.local"]);
    runGit(root, ["config", "user.name", "Codegraph Bot"]);
    const workflowFile = path.join(root, ".github", "workflows", "ci.yml");
    await fsp.mkdir(path.dirname(workflowFile), { recursive: true });
    await fsp.writeFile(workflowFile, "name: ci\n", "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);
    await fsp.writeFile(workflowFile, "name: ci\non: push\n", "utf8");

    const report = await buildReviewReport(root, {
      gitBase: "HEAD",
      gitHead: "WORKTREE",
      discovery: { includeGlobs: ["**/*.yml"], globRoot: root },
    });

    expect(report.status).toBe("ok");
    expect(report.changedFiles.some((changedFile) => changedFile.file === ".github/workflows/ci.yml")).toBe(true);
  });

  it("refreshes and retires ignored untracked files explicitly reviewed through a warm disk cache", async () => {
    const root = await mkTmpDir("dg-review-ignored-untracked-warm-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "test@git.local"]);
    runGit(root, ["config", "user.name", "Codegraph Bot"]);
    await fsp.writeFile(path.join(root, ".gitignore"), "extras/\n", "utf8");
    await fsp.writeFile(
      path.join(root, "main.ts"),
      'import { firstIgnoredValue } from "./extras/ignored";\nexport const main = firstIgnoredValue;\n',
      "utf8",
    );
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);

    const ignoredFile = path.join(root, "extras", "ignored.ts");
    await fsp.mkdir(path.dirname(ignoredFile), { recursive: true });
    await fsp.writeFile(ignoredFile, "export const firstIgnoredValue = 1;\n", "utf8");
    const firstReport = await buildReviewReport(root, { cache: "disk", files: [ignoredFile] });
    expect(firstReport.changedFiles[0]?.symbols.some((symbol) => symbol.name === "firstIgnoredValue")).toBe(true);

    await fsp.writeFile(ignoredFile, "export const secondIgnoredValue = 22;\n", "utf8");
    const secondBuildReport: ReviewBuildReport = { timings: {}, indexReport: { timings: {} } };
    const secondReport = await buildReviewReport(root, {
      cache: "disk",
      files: [ignoredFile],
      report: secondBuildReport,
    });
    expect(secondReport.changedFiles[0]?.symbols.some((symbol) => symbol.name === "secondIgnoredValue")).toBe(true);
    expect(secondReport.changedFiles[0]?.symbols.some((symbol) => symbol.name === "firstIgnoredValue")).toBe(false);
    expect(secondBuildReport.indexReport?.files?.parsed ?? 0).toBeGreaterThan(0);

    const ordinaryIndex = await indexerBuild.buildProjectIndexIncremental(root, { cache: "disk" });
    const normalizedIgnoredFile = normalize(ignoredFile);
    expect(ordinaryIndex.byFile.has(normalizedIgnoredFile)).toBe(false);
    expect(ordinaryIndex.graph.edges.some((edge) => edge.from === normalizedIgnoredFile)).toBe(false);
    const coldIndex = await buildProjectIndex(root, { cache: "off" });
    expect([...ordinaryIndex.graph.nodes].sort()).toEqual([...coldIndex.graph.nodes].sort());
    expect(ordinaryIndex.graph.edges).toEqual(coldIndex.graph.edges);
    const manifest = JSON.parse(
      await fsp.readFile(path.join(root, ".codegraph-cache", "index-v1", "manifest.json"), "utf8"),
    ) as { transientFiles?: string[] };
    expect(manifest.transientFiles).toEqual([]);
  });

  it("unions explicitly reviewed files outside discovery globs into the complete project index", async () => {
    const root = await mkTmpDir("dg-review-git-explicit-discovery-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "test@git.local"]);
    runGit(root, ["config", "user.name", "Codegraph Bot"]);
    const includedFile = path.join(root, "src", "included.ts");
    const explicitFile = path.join(root, "extras", "explicit.ts");
    await fsp.mkdir(path.dirname(includedFile), { recursive: true });
    await fsp.mkdir(path.dirname(explicitFile), { recursive: true });
    await fsp.writeFile(includedFile, "export const included = 1;\n", "utf8");
    await fsp.writeFile(explicitFile, "export const explicitValue = 1;\n", "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);
    await fsp.writeFile(explicitFile, "export const explicitValue = 2;\n", "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "change explicit"]);
    const base = runGit(root, ["rev-parse", "HEAD^"]);
    const firstIndexReport: BuildReport = { timings: {} };
    const reviewBuildReport: ReviewBuildReport = { timings: {}, indexReport: firstIndexReport };

    const report = await buildReviewReport(root, {
      files: [explicitFile],
      gitBase: base,
      gitHead: "HEAD",
      cache: "disk",
      discovery: { includeGlobs: ["src/**"], globRoot: root },
      report: reviewBuildReport,
    });
    const warmIndexReport: BuildReport = { timings: {} };
    const warmReport = await buildReviewReport(root, {
      files: [explicitFile],
      gitBase: base,
      gitHead: "HEAD",
      cache: "disk",
      discovery: { includeGlobs: ["src/**"], globRoot: root },
      report: { timings: {}, indexReport: warmIndexReport },
    });

    expect(report.status).toBe("ok");
    expect(report.changedFiles.map((changedFile) => changedFile.file)).toEqual(["extras/explicit.ts"]);
    expect(report.changedFiles[0]?.symbols.some((symbol) => symbol.name === "explicitValue")).toBe(true);
    expect(reviewBuildReport.index?.byFile.has(normalize(includedFile))).toBe(true);
    expect(reviewBuildReport.index?.byFile.has(normalize(explicitFile))).toBe(true);
    expect(warmReport.changedFiles).toEqual(report.changedFiles);
    expect(warmIndexReport.files?.parsed ?? 0).toBe(0);
  });

  it("reports renames from inside discovery include globs", async () => {
    const root = await mkTmpDir("dg-review-git-rename-discovery-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "test@git.local"]);
    runGit(root, ["config", "user.name", "Codegraph Bot"]);
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    await fsp.mkdir(path.join(root, "docs"), { recursive: true });
    const sourceFile = path.join(root, "src", "tracked.ts");
    const movedFile = path.join(root, "docs", "tracked.ts");
    await fsp.writeFile(sourceFile, `export const value = 1;\n`, "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);
    await fsp.rename(sourceFile, movedFile);

    const report = await buildReviewReport(root, {
      gitBase: "HEAD",
      gitHead: "WORKTREE",
      discovery: { includeGlobs: ["src/**"], globRoot: root },
    });
    expect(report.changedFiles.some((changedFile) => changedFile.file === "src/tracked.ts")).toBe(true);
    expect(report.status).toBe("ok");
    expect(report.changedFiles.length).toBeGreaterThan(0);
  });

  it("models renames from included paths into ignored paths as scoped deletions", async () => {
    const root = await mkTmpDir("dg-review-git-rename-ignore-discovery-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "test@git.local"]);
    runGit(root, ["config", "user.name", "Codegraph Bot"]);
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    await fsp.mkdir(path.join(root, "src", "generated"), { recursive: true });
    const sourceFile = path.join(root, "src", "tracked.ts");
    const movedFile = path.join(root, "src", "generated", "tracked.ts");
    await fsp.writeFile(sourceFile, `export const value = 1;\n`, "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);
    await fsp.rename(sourceFile, movedFile);

    const report = await buildReviewReport(root, {
      gitBase: "HEAD",
      gitHead: "WORKTREE",
      discovery: { includeGlobs: ["src/**"], ignoreGlobs: ["src/generated/**"], globRoot: root },
    });

    expect(report.status).toBe("ok");
    expect(report.changedFiles.some((changedFile) => changedFile.file === "src/tracked.ts")).toBe(true);
    expect(report.changedFiles.some((changedFile) => changedFile.file === "src/generated/tracked.ts")).toBe(false);
  });

  it("models renames into ignored paths as scoped deletions without include globs", async () => {
    const root = await mkTmpDir("dg-review-git-rename-ignore-only-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "test@git.local"]);
    runGit(root, ["config", "user.name", "Codegraph Bot"]);
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    await fsp.mkdir(path.join(root, "src", "generated"), { recursive: true });
    const sourceFile = path.join(root, "src", "tracked.ts");
    const movedFile = path.join(root, "src", "generated", "tracked.ts");
    await fsp.writeFile(sourceFile, `export const value = 1;\n`, "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);
    await fsp.rename(sourceFile, movedFile);

    const report = await buildReviewReport(root, {
      gitBase: "HEAD",
      gitHead: "WORKTREE",
      discovery: { ignoreGlobs: ["src/generated/**"], globRoot: root },
    });

    expect(report.status).toBe("ok");
    expect(report.changedFiles.some((changedFile) => changedFile.file === "src/tracked.ts")).toBe(true);
    expect(report.changedFiles.some((changedFile) => changedFile.file === "src/generated/tracked.ts")).toBe(false);
  });

  it("surfaces invalid git revisions instead of reporting no changes", async () => {
    const root = await mkTmpDir("dg-review-invalid-git-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "test@git.local"]);
    runGit(root, ["config", "user.name", "Codegraph Bot"]);
    await fsp.writeFile(path.join(root, "tracked.ts"), `export const value = 1;\n`, "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);

    await expect(buildReviewReport(root, { gitBase: "definitely-not-a-ref" })).rejects.toThrow(/definitely-not-a-ref/);
  });

  it("reports deleted files surfaced by git diffs", async () => {
    const root = await mkTmpDir("dg-review-deleted-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "delete@git.local"]);
    runGit(root, ["config", "user.name", "Codegraph Bot"]);
    const filePath = path.join(root, "gone.ts");
    const testFile = path.join(root, "gone.test.ts");
    await fsp.writeFile(filePath, `export const gone = true;\n`, "utf8");
    await fsp.writeFile(testFile, `import { gone } from './gone';\nexport const seen = gone;\n`, "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);
    runGit(root, ["rm", "gone.ts"]);
    runGit(root, ["commit", "-m", "remove"]);

    const base = runGit(root, ["rev-parse", "HEAD^"]);
    const report = await buildReviewReport(root, {
      gitBase: base,
      cache: "memory",
    });

    expect(report.summary.filesChanged).toBe(1);
    expect(report.changedFiles[0]?.status).toBe("deleted");
    expect(report.changedFiles[0]?.symbols.some((symbol) => symbol.name === "gone")).toBe(true);
    expect(report.changedFiles[0]?.symbols.some((symbol) => symbol.exported)).toBe(true);
    expect(report.summary.symbolsChanged).toBe(1);
    expect(report.riskSummary.signals).toContain("exported-symbols-changed");
    expect(report.candidateTests).toContainEqual({
      file: "gone.test.ts",
      confidence: "high",
      reason: "importsChanged",
    });
    expect(report.diagnostics).toBeUndefined();
  });

  it("treats barrel export edits as exported symbol changes", async () => {
    const root = await mkTmpDir("dg-review-barrel-edit-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    const aFile = path.join(srcDir, "a.ts");
    const bFile = path.join(srcDir, "b.ts");
    const indexFile = path.join(srcDir, "index.ts");
    await fsp.writeFile(aFile, `export const fromA = 1;\n`, "utf8");
    await fsp.writeFile(bFile, `export const fromB = 2;\n`, "utf8");
    await fsp.writeFile(indexFile, `export * from './a';\n`, "utf8");

    await buildProjectIndex(root, { cache: "memory" });
    await fsp.writeFile(indexFile, `export * from './b';\n`, "utf8");

    const report = await buildReviewReport(root, {
      files: [indexFile],
      cache: "memory",
      includeSymbolDetails: true,
      diffText: [
        "diff --git a/src/index.ts b/src/index.ts",
        "index 1111111..2222222 100644",
        "--- a/src/index.ts",
        "+++ b/src/index.ts",
        "@@ -1 +1 @@",
        "-export * from './a';",
        "+export * from './b';",
        "",
      ].join("\n"),
    });

    const fileSummary = report.changedFiles.find((entry) => entry.file === "src/index.ts");
    expect(fileSummary?.symbols).toContainEqual(
      expect.objectContaining({
        name: "*",
        kind: "exportStar",
        exported: true,
      }),
    );
    expect(report.summary.symbolsChanged).toBe(1);
    expect(report.riskSummary.signals).toContain("exported-symbols-changed");
    expect(report.riskSummary.level).toBe("medium");
  });

  it("reconstructs deleted files from raw diff text", async () => {
    const root = await mkTmpDir("dg-review-diff-delete-");
    const srcDir = path.join(root, "src");
    const testsDir = path.join(root, "tests");
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(testsDir, { recursive: true });
    const libFile = path.join(srcDir, "lib.ts");
    const testFile = path.join(testsDir, "lib.test.ts");
    await fsp.writeFile(libFile, `export const gone = 1;\n`, "utf8");
    await fsp.writeFile(testFile, `import { gone } from '../src/lib';\nexport const seen = gone;\n`, "utf8");

    await buildProjectIndex(root, { cache: "memory" });
    await fsp.unlink(libFile);

    const report = await buildReviewReport(root, {
      files: [libFile],
      cache: "memory",
      includeSymbolDetails: true,
      diffText: [
        "diff --git a/src/lib.ts b/src/lib.ts",
        "deleted file mode 100644",
        "index 1111111..0000000",
        "--- a/src/lib.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-export const gone = 1;",
        "",
      ].join("\n"),
    });

    expect(report.changedFiles[0]?.status).toBe("deleted");
    expect(report.changedFiles[0]?.symbols).toContainEqual(
      expect.objectContaining({
        name: "gone",
        exported: true,
      }),
    );
    expect(report.summary.symbolsChanged).toBe(1);
    expect(report.riskSummary.signals).toContain("exported-symbols-changed");
    expect(report.candidateTests).toContainEqual({
      file: "tests/lib.test.ts",
      confidence: "high",
      reason: "importsChanged",
    });
  });

  it("respects directory-prefixed custom test patterns for sparse deleted-file review candidates", async () => {
    const root = await mkTmpDir("dg-review-custom-tests-");
    const srcDir = path.join(root, "src");
    const checksDir = path.join(root, "checks");
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(checksDir, { recursive: true });
    const libFile = path.join(srcDir, "lib.ts");
    const verifyFile = path.join(checksDir, "lib.verify.ts");
    await fsp.writeFile(libFile, `export const gone = 1;\n`, "utf8");
    await fsp.writeFile(verifyFile, `import { gone } from '../src/lib';\nexport const seen = gone;\n`, "utf8");

    await buildProjectIndex(root, { cache: "memory" });
    await fsp.unlink(libFile);

    const report = await buildReviewReport(root, {
      files: [libFile],
      cache: "memory",
      testPatterns: ["^checks/.*\\.verify\\.ts$"],
      diffText: [
        "diff --git a/src/lib.ts b/src/lib.ts",
        "deleted file mode 100644",
        "index 1111111..0000000",
        "--- a/src/lib.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-export const gone = 1;",
        "",
      ].join("\n"),
    });

    expect(report.candidateTests).toContainEqual({
      file: "checks/lib.verify.ts",
      confidence: "high",
      reason: "importsChanged",
    });
  });

  it("treats alias imports as direct deleted-file test candidates", async () => {
    const root = await mkTmpDir("dg-review-alias-import-");
    const srcDir = path.join(root, "src");
    const testsDir = path.join(root, "tests");
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(testsDir, { recursive: true });
    const libFile = path.join(srcDir, "lib.ts");
    const testFile = path.join(testsDir, "lib.test.ts");
    await fsp.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@lib": ["src/lib.ts"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fsp.writeFile(libFile, `export const gone = 1;\n`, "utf8");
    await fsp.writeFile(testFile, `import { gone } from '@lib';\nexport const seen = gone;\n`, "utf8");

    await buildProjectIndex(root, { cache: "memory" });
    await fsp.unlink(libFile);

    const report = await buildReviewReport(root, {
      files: [libFile],
      cache: "memory",
      diffText: [
        "diff --git a/src/lib.ts b/src/lib.ts",
        "deleted file mode 100644",
        "index 1111111..0000000",
        "--- a/src/lib.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-export const gone = 1;",
        "",
      ].join("\n"),
    });

    expect(report.candidateTests).toContainEqual({
      file: "tests/lib.test.ts",
      confidence: "high",
      reason: "importsChanged",
    });
  });

  it("treats workspace package imports as direct deleted-file test candidates", async () => {
    const root = await mkTmpDir("dg-review-workspace-import-");
    const libDir = path.join(root, "packages", "lib");
    const appDir = path.join(root, "packages", "app");
    const libFile = path.join(libDir, "src", "index.ts");
    const testFile = path.join(appDir, "tests", "lib.test.ts");

    await fsp.mkdir(path.dirname(libFile), { recursive: true });
    await fsp.mkdir(path.dirname(testFile), { recursive: true });
    await fsp.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ private: true, workspaces: ["packages/*"] }, null, 2),
      "utf8",
    );
    await fsp.writeFile(
      path.join(libDir, "package.json"),
      JSON.stringify({ name: "@repo/lib", main: "src/index.ts" }, null, 2),
      "utf8",
    );
    await fsp.writeFile(path.join(appDir, "package.json"), JSON.stringify({ name: "@repo/app" }, null, 2), "utf8");
    await fsp.writeFile(libFile, `export const gone = 1;\n`, "utf8");
    await fsp.writeFile(testFile, `import { gone } from '@repo/lib';\nexport const seen = gone;\n`, "utf8");

    await buildProjectIndex(root, { cache: "memory" });
    await fsp.unlink(libFile);

    const report = await buildReviewReport(root, {
      files: [libFile],
      cache: "memory",
      diffText: [
        "diff --git a/packages/lib/src/index.ts b/packages/lib/src/index.ts",
        "deleted file mode 100644",
        "index 1111111..0000000",
        "--- a/packages/lib/src/index.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-export const gone = 1;",
        "",
      ].join("\n"),
    });

    expect(report.candidateTests).toContainEqual({
      file: "packages/app/tests/lib.test.ts",
      confidence: "high",
      reason: "importsChanged",
    });
    expect(report.graphDelta).toContainEqual({
      from: "packages/app/tests/lib.test.ts",
      to: { type: "file", path: "packages/lib/src/index.ts" },
      raw: "@repo/lib",
    });
  });

  it("treats .jsx imports as direct deleted-file test candidates for .tsx files", async () => {
    const root = await mkTmpDir("dg-review-jsx-tsx-delete-");
    const srcDir = path.join(root, "src");
    const testsDir = path.join(root, "tests");
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(testsDir, { recursive: true });
    const viewFile = path.join(srcDir, "view.tsx");
    const testFile = path.join(testsDir, "view.test.tsx");
    await fsp.writeFile(viewFile, `export function View() { return null; }\n`, "utf8");
    await fsp.writeFile(testFile, `import { View } from '../src/view.jsx';\nexport const seen = View;\n`, "utf8");

    await buildProjectIndex(root, { cache: "memory" });
    await fsp.unlink(viewFile);

    const report = await buildReviewReport(root, {
      files: [viewFile],
      cache: "memory",
      diffText: [
        "diff --git a/src/view.tsx b/src/view.tsx",
        "deleted file mode 100644",
        "index 1111111..0000000",
        "--- a/src/view.tsx",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-export function View() { return null; }",
        "",
      ].join("\n"),
    });

    expect(report.candidateTests).toContainEqual({
      file: "tests/view.test.tsx",
      confidence: "high",
      reason: "importsChanged",
    });
    expect(report.graphDelta).toContainEqual({
      from: "tests/view.test.tsx",
      to: { type: "file", path: "src/view.tsx" },
      raw: "../src/view.jsx",
    });
  });

  it("treats side-effect imports as direct deleted-file test candidates", async () => {
    const root = await mkTmpDir("dg-review-side-effect-");
    const srcDir = path.join(root, "src");
    const testsDir = path.join(root, "tests");
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(testsDir, { recursive: true });
    const libFile = path.join(srcDir, "lib.ts");
    const testFile = path.join(testsDir, "lib.test.ts");
    await fsp.writeFile(libFile, `export const gone = 1;\n`, "utf8");
    await fsp.writeFile(testFile, `import '../src/lib';\n`, "utf8");

    await buildProjectIndex(root, { cache: "memory" });
    await fsp.unlink(libFile);

    const report = await buildReviewReport(root, {
      files: [libFile],
      cache: "memory",
      diffText: [
        "diff --git a/src/lib.ts b/src/lib.ts",
        "deleted file mode 100644",
        "index 1111111..0000000",
        "--- a/src/lib.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-export const gone = 1;",
        "",
      ].join("\n"),
    });

    expect(report.candidateTests).toContainEqual({
      file: "tests/lib.test.ts",
      confidence: "high",
      reason: "importsChanged",
    });
  });

  it("does not classify every file as a test when the project root path contains tests", async () => {
    const tempParent = path.join(process.cwd(), "tests", ".tmp");
    await fsp.mkdir(tempParent, { recursive: true });
    const root = await fsp.mkdtemp(path.join(tempParent, "dg-review-root-tests-"));
    try {
      const srcDir = path.join(root, "src");
      await fsp.mkdir(srcDir, { recursive: true });
      const libFile = path.join(srcDir, "lib.ts");
      await fsp.writeFile(libFile, `export const gone = 1;\n`, "utf8");
      await fsp.writeFile(
        path.join(root, "main.ts"),
        `import { gone } from "./src/lib";\nexport const seen = gone;\n`,
        "utf8",
      );

      await buildProjectIndex(root, { cache: "memory" });
      await fsp.unlink(libFile);

      const report = await buildReviewReport(root, {
        files: [libFile],
        cache: "memory",
        diffText: [
          "diff --git a/src/lib.ts b/src/lib.ts",
          "deleted file mode 100644",
          "index 1111111..0000000",
          "--- a/src/lib.ts",
          "+++ /dev/null",
          "@@ -1 +0,0 @@",
          "-export const gone = 1;",
          "",
        ].join("\n"),
      });

      expect(report.candidateTests).toHaveLength(0);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("includes importer edges for deleted files in graphDelta", async () => {
    const root = await mkTmpDir("dg-review-deleted-edges-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    const libFile = path.join(srcDir, "lib.ts");
    const mainFile = path.join(srcDir, "main.ts");
    await fsp.writeFile(libFile, `export const gone = 1;\n`, "utf8");
    await fsp.writeFile(mainFile, `import { gone } from './lib';\nexport const seen = gone;\n`, "utf8");

    await buildProjectIndex(root, { cache: "memory" });
    await fsp.unlink(libFile);

    const report = await buildReviewReport(root, {
      files: [libFile],
      cache: "memory",
      diffText: [
        "diff --git a/src/lib.ts b/src/lib.ts",
        "deleted file mode 100644",
        "index 1111111..0000000",
        "--- a/src/lib.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-export const gone = 1;",
        "",
      ].join("\n"),
    });

    expect(report.graphDelta).toContainEqual({
      from: "src/main.ts",
      to: { type: "file", path: "src/lib.ts" },
      raw: "./lib",
    });
  });

  it("includes deleted consumer import edges in graphDelta", async () => {
    const root = await mkTmpDir("dg-review-deleted-consumer-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    const libFile = path.join(srcDir, "lib.ts");
    const consumerFile = path.join(srcDir, "consumer.ts");
    await fsp.writeFile(libFile, `export const lib = 1;\n`, "utf8");
    await fsp.writeFile(consumerFile, `import { lib } from './lib';\nexport const seen = lib;\n`, "utf8");

    await buildProjectIndex(root, { cache: "memory" });
    await fsp.unlink(consumerFile);

    const report = await buildReviewReport(root, {
      files: [consumerFile],
      cache: "memory",
      diffText: [
        "diff --git a/src/consumer.ts b/src/consumer.ts",
        "deleted file mode 100644",
        "index 1111111..0000000",
        "--- a/src/consumer.ts",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-import { lib } from './lib';",
        "-export const seen = lib;",
        "",
      ].join("\n"),
    });

    expect(report.graphDelta).toContainEqual({
      from: "src/consumer.ts",
      to: { type: "file", path: "src/lib.ts" },
      raw: "./lib",
    });
  });

  it("includes deleted-to-deleted import edges without relying on warm caches", async () => {
    const root = await mkTmpDir("dg-review-deleted-chain-cold-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    const depFile = path.join(srcDir, "dep.ts");
    const consumerFile = path.join(srcDir, "consumer.ts");
    await fsp.writeFile(depFile, `export const dep = 1;\n`, "utf8");
    await fsp.writeFile(consumerFile, `import { dep } from './dep';\nexport const seen = dep;\n`, "utf8");

    await fsp.unlink(consumerFile);
    await fsp.unlink(depFile);

    const report = await buildReviewReport(root, {
      files: [consumerFile, depFile],
      cache: "memory",
      diffText: [
        "diff --git a/src/consumer.ts b/src/consumer.ts",
        "deleted file mode 100644",
        "index 1111111..0000000",
        "--- a/src/consumer.ts",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-import { dep } from './dep';",
        "-export const seen = dep;",
        "",
        "diff --git a/src/dep.ts b/src/dep.ts",
        "deleted file mode 100644",
        "index 2222222..0000000",
        "--- a/src/dep.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-export const dep = 1;",
        "",
      ].join("\n"),
    });

    expect(report.graphDelta).toContainEqual({
      from: "src/consumer.ts",
      to: { type: "file", path: "src/dep.ts" },
      raw: "./dep",
    });
  });

  it("includes deleted consumer alias import edges in graphDelta", async () => {
    const root = await mkTmpDir("dg-review-deleted-alias-consumer-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    const libFile = path.join(srcDir, "lib.ts");
    const consumerFile = path.join(srcDir, "consumer.ts");
    await fsp.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@lib": ["src/lib.ts"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fsp.writeFile(libFile, `export const lib = 1;\n`, "utf8");
    await fsp.writeFile(consumerFile, `import { lib } from '@lib';\nexport const seen = lib;\n`, "utf8");

    await buildProjectIndex(root, { cache: "memory" });
    await fsp.unlink(consumerFile);

    const report = await buildReviewReport(root, {
      files: [consumerFile],
      cache: "memory",
      diffText: [
        "diff --git a/src/consumer.ts b/src/consumer.ts",
        "deleted file mode 100644",
        "index 1111111..0000000",
        "--- a/src/consumer.ts",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-import { lib } from '@lib';",
        "-export const seen = lib;",
        "",
      ].join("\n"),
    });

    expect(report.graphDelta).toContainEqual({
      from: "src/consumer.ts",
      to: { type: "file", path: "src/lib.ts" },
      raw: "@lib",
    });
  });

  it("includes deleted-to-deleted alias import edges on a cold review pass", async () => {
    const root = await mkTmpDir("dg-review-deleted-alias-chain-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    const depFile = path.join(srcDir, "dep.ts");
    const consumerFile = path.join(srcDir, "consumer.ts");
    await fsp.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@dep": ["src/dep.ts"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fsp.writeFile(depFile, `export const dep = 1;\n`, "utf8");
    await fsp.writeFile(consumerFile, `import { dep } from '@dep';\nexport const seen = dep;\n`, "utf8");

    await fsp.unlink(consumerFile);
    await fsp.unlink(depFile);

    const report = await buildReviewReport(root, {
      files: [consumerFile, depFile],
      cache: "memory",
      diffText: [
        "diff --git a/src/consumer.ts b/src/consumer.ts",
        "deleted file mode 100644",
        "index 1111111..0000000",
        "--- a/src/consumer.ts",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-import { dep } from '@dep';",
        "-export const seen = dep;",
        "",
        "diff --git a/src/dep.ts b/src/dep.ts",
        "deleted file mode 100644",
        "index 2222222..0000000",
        "--- a/src/dep.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-export const dep = 1;",
        "",
      ].join("\n"),
    });

    expect(report.graphDelta).toContainEqual({
      from: "src/consumer.ts",
      to: { type: "file", path: "src/dep.ts" },
      raw: "@dep",
    });
  });

  it("includes deleted consumer workspace import edges in graphDelta", async () => {
    const root = await mkTmpDir("dg-review-deleted-workspace-consumer-");
    const libDir = path.join(root, "packages", "lib");
    const appDir = path.join(root, "packages", "app");
    const libFile = path.join(libDir, "src", "index.ts");
    const consumerFile = path.join(appDir, "src", "consumer.ts");

    await fsp.mkdir(path.dirname(libFile), { recursive: true });
    await fsp.mkdir(path.dirname(consumerFile), { recursive: true });
    await fsp.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ private: true, workspaces: ["packages/*"] }, null, 2),
      "utf8",
    );
    await fsp.writeFile(
      path.join(libDir, "package.json"),
      JSON.stringify({ name: "@repo/lib", main: "src/index.ts" }, null, 2),
      "utf8",
    );
    await fsp.writeFile(path.join(appDir, "package.json"), JSON.stringify({ name: "@repo/app" }, null, 2), "utf8");
    await fsp.writeFile(libFile, `export const lib = 1;\n`, "utf8");
    await fsp.writeFile(consumerFile, `import { lib } from '@repo/lib';\nexport const seen = lib;\n`, "utf8");

    await buildProjectIndex(root, { cache: "memory" });
    await fsp.unlink(consumerFile);

    const report = await buildReviewReport(root, {
      files: [consumerFile],
      cache: "memory",
      diffText: [
        "diff --git a/packages/app/src/consumer.ts b/packages/app/src/consumer.ts",
        "deleted file mode 100644",
        "index 1111111..0000000",
        "--- a/packages/app/src/consumer.ts",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-import { lib } from '@repo/lib';",
        "-export const seen = lib;",
        "",
      ].join("\n"),
    });

    expect(report.graphDelta).toContainEqual({
      from: "packages/app/src/consumer.ts",
      to: { type: "file", path: "packages/lib/src/index.ts" },
      raw: "@repo/lib",
    });
  });

  it("includes deleted-to-deleted workspace import edges on a cold review pass", async () => {
    const root = await mkTmpDir("dg-review-deleted-workspace-chain-");
    const libDir = path.join(root, "packages", "lib");
    const appDir = path.join(root, "packages", "app");
    const depFile = path.join(libDir, "src", "index.ts");
    const consumerFile = path.join(appDir, "src", "consumer.ts");

    await fsp.mkdir(path.dirname(depFile), { recursive: true });
    await fsp.mkdir(path.dirname(consumerFile), { recursive: true });
    await fsp.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ private: true, workspaces: ["packages/*"] }, null, 2),
      "utf8",
    );
    await fsp.writeFile(
      path.join(libDir, "package.json"),
      JSON.stringify({ name: "@repo/lib", main: "src/index.ts" }, null, 2),
      "utf8",
    );
    await fsp.writeFile(path.join(appDir, "package.json"), JSON.stringify({ name: "@repo/app" }, null, 2), "utf8");
    await fsp.writeFile(depFile, `export const dep = 1;\n`, "utf8");
    await fsp.writeFile(consumerFile, `import { dep } from '@repo/lib';\nexport const seen = dep;\n`, "utf8");

    await fsp.unlink(consumerFile);
    await fsp.unlink(depFile);

    const report = await buildReviewReport(root, {
      files: [consumerFile, depFile],
      cache: "memory",
      diffText: [
        "diff --git a/packages/app/src/consumer.ts b/packages/app/src/consumer.ts",
        "deleted file mode 100644",
        "index 1111111..0000000",
        "--- a/packages/app/src/consumer.ts",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-import { dep } from '@repo/lib';",
        "-export const seen = dep;",
        "",
        "diff --git a/packages/lib/src/index.ts b/packages/lib/src/index.ts",
        "deleted file mode 100644",
        "index 2222222..0000000",
        "--- a/packages/lib/src/index.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-export const dep = 1;",
        "",
      ].join("\n"),
    });

    expect(report.graphDelta).toContainEqual({
      from: "packages/app/src/consumer.ts",
      to: { type: "file", path: "packages/lib/src/index.ts" },
      raw: "@repo/lib",
    });
  });

  it("reports deleted re-export files as exported API changes", async () => {
    const root = await mkTmpDir("dg-review-deleted-barrel-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "delete@git.local"]);
    runGit(root, ["config", "user.name", "Codegraph Bot"]);
    const srcDir = path.join(root, "src");
    const testsDir = path.join(root, "tests");
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(testsDir, { recursive: true });
    const implFile = path.join(srcDir, "impl.ts");
    const barrelFile = path.join(srcDir, "index.ts");
    const testFile = path.join(testsDir, "index.test.ts");
    await fsp.writeFile(implFile, `export const impl = 1;\n`, "utf8");
    await fsp.writeFile(barrelFile, `export * from './impl';\n`, "utf8");
    await fsp.writeFile(testFile, `import { impl } from '../src/index';\nexport const seen = impl;\n`, "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);
    runGit(root, ["rm", "src/index.ts"]);
    runGit(root, ["commit", "-m", "remove barrel"]);

    const base = runGit(root, ["rev-parse", "HEAD^"]);
    const report = await buildReviewReport(root, {
      gitBase: base,
      cache: "memory",
      includeSymbolDetails: true,
    });

    const barrelSummary = report.changedFiles.find((entry) => entry.file === "src/index.ts");
    expect(barrelSummary?.status).toBe("deleted");
    expect(barrelSummary?.symbols).toContainEqual(
      expect.objectContaining({
        name: "*",
        kind: "exportStar",
        exported: true,
      }),
    );
    expect(report.summary.symbolsChanged).toBe(1);
    expect(report.riskSummary.signals).toContain("exported-symbols-changed");
    expect(report.candidateTests).toContainEqual({
      file: "tests/index.test.ts",
      confidence: "high",
      reason: "importsChanged",
    });
    expect(report.graphDelta).toContainEqual({
      from: "src/index.ts",
      to: { type: "file", path: "src/impl.ts" },
      raw: "./impl",
    });
  });

  it("includes deleted alias re-export edges on a cold review pass", async () => {
    const root = await mkTmpDir("dg-review-deleted-alias-reexport-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    const depFile = path.join(srcDir, "dep.ts");
    const barrelFile = path.join(srcDir, "index.ts");
    await fsp.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@dep": ["src/dep.ts"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fsp.writeFile(depFile, `export const dep = 1;\n`, "utf8");
    await fsp.writeFile(barrelFile, `export * from '@dep';\n`, "utf8");

    await fsp.unlink(barrelFile);
    await fsp.unlink(depFile);

    const report = await buildReviewReport(root, {
      files: [barrelFile, depFile],
      cache: "memory",
      diffText: [
        "diff --git a/src/index.ts b/src/index.ts",
        "deleted file mode 100644",
        "index 1111111..0000000",
        "--- a/src/index.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-export * from '@dep';",
        "",
        "diff --git a/src/dep.ts b/src/dep.ts",
        "deleted file mode 100644",
        "index 2222222..0000000",
        "--- a/src/dep.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-export const dep = 1;",
        "",
      ].join("\n"),
    });

    expect(report.graphDelta).toContainEqual({
      from: "src/index.ts",
      to: { type: "file", path: "src/dep.ts" },
      raw: "@dep",
    });
  });

  it("marks explicitly missing files as missing instead of deleted", async () => {
    const root = await mkTmpDir("dg-review-missing-");
    const missingFile = path.join(root, "missing.ts");

    const report = await buildReviewReport(root, {
      files: [missingFile],
    });

    expect(report.status).toBe("ok");
    expect(report.schemaVersion).toBe(2);
    expect(report.changedFiles[0]?.file).toBe("missing.ts");
    expect(report.changedFiles[0]?.status).toBe("missing");
    expect(report.diagnostics?.missingFiles).toEqual(["missing.ts"]);
    expect(report.diagnostics?.symbolMappingParseFailures).toEqual([]);
    expect(report.riskSummary.signals).toContain("missing-files");
    expect(report.reviewTasks.some((task) => task.reason === "missing-files")).toBe(true);
  });

  it("rejects explicit files outside the project root", async () => {
    const root = await mkTmpDir("dg-review-root-boundary-");
    const outsideFile = path.resolve("README.md");

    await expect(
      buildReviewReport(root, {
        files: [outsideFile],
      }),
    ).rejects.toThrow(/outside project root/i);
  });

  it("reports review diagnostics when symbol mapping degrades", async () => {
    const root = await mkTmpDir("dg-review-parse-failure-");
    const filePath = path.join(root, "feature.ts");
    await fsp.writeFile(filePath, `export const value = 1;\n`, "utf8");

    await buildProjectIndex(root);

    const locateSpy = vi.spyOn(impactMap, "locateChangedSymbolsWithLines").mockResolvedValue({
      changedSymbols: [],
      changedLines: new Set<number>(),
      parseFailed: true,
    });

    try {
      const report = await buildReviewReport(root, {
        files: [filePath],
        diffText: [
          "diff --git a/feature.ts b/feature.ts",
          "index 1234567..abcdef0 100644",
          "--- a/feature.ts",
          "+++ b/feature.ts",
          "@@ -1 +1 @@",
          "-export const value = 0;",
          "+export const value = 1;",
          "",
        ].join("\n"),
      });

      expect(report.diagnostics?.missingFiles).toEqual([]);
      expect(report.diagnostics?.symbolMappingParseFailures).toEqual(["feature.ts"]);
      expect(report.riskSummary.signals).toContain("symbol-mapping-degraded");
      expect(report.reviewTasks.some((task) => task.reason === "symbol-mapping-degraded")).toBe(true);
    } finally {
      locateSpy.mockRestore();
    }
  });

  it("does not escalate symbol mapping degradation for document-only files", async () => {
    const root = await mkTmpDir("dg-review-doc-parse-failure-");
    const filePath = path.join(root, "README.md");
    await fsp.writeFile(filePath, `# Guide\n\nInitial text.\n`, "utf8");

    await buildProjectIndex(root);

    const locateSpy = vi.spyOn(impactMap, "locateChangedSymbolsWithLines").mockResolvedValue({
      changedSymbols: [],
      changedLines: new Set<number>(),
      parseFailed: true,
    });

    try {
      const report = await buildReviewReport(root, {
        files: [filePath],
        diffText: [
          "diff --git a/README.md b/README.md",
          "index 1234567..abcdef0 100644",
          "--- a/README.md",
          "+++ b/README.md",
          "@@ -1,3 +1,3 @@",
          " # Guide",
          "-Initial text.",
          "+Updated text.",
          "",
        ].join("\n"),
      });

      expect(report.diagnostics?.symbolMappingParseFailures).toEqual(["README.md"]);
      expect(report.riskSummary.signals).not.toContain("symbol-mapping-degraded");
      expect(report.reviewTasks.some((task) => task.reason === "symbol-mapping-degraded")).toBe(false);
    } finally {
      locateSpy.mockRestore();
    }
  });

  it("returns candidate tests after warming the manifest cache", async () => {
    const root = await mkTmpDir("dg-review-candidates-");
    const srcDir = path.join(root, "src");
    const testsDir = path.join(root, "tests");
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(testsDir, { recursive: true });
    const featureFile = path.join(srcDir, "feature.ts");
    const testFile = path.join(testsDir, "feature.test.ts");
    await fsp.writeFile(featureFile, `export function helper() { return 1; }\n`, "utf8");
    await fsp.writeFile(testFile, `import { helper } from '../src/feature';\nhelper();\n`, "utf8");

    await buildProjectIndex(root);
    const manifestPath = path.join(root, ".codegraph-cache", "index-v1", "manifest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);

    await fsp.writeFile(featureFile, `export function helper() { return 2; }\n`, "utf8");
    const report = await buildReviewReport(root, {
      files: [featureFile],
      maxCandidates: 5,
    });

    expect(report.summary.candidateTests).toBeGreaterThan(0);
    expect(report.candidateTests.some((candidate) => candidate.file === "tests/feature.test.ts")).toBe(true);
    expect(report.candidateTests.some((candidate) => candidate.confidence === "high")).toBe(true);
  });

  it("processes symbol details across files in parallel", async () => {
    const root = await mkTmpDir("dg-review-parallel-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    const alphaFile = path.join(srcDir, "alpha.ts");
    const betaFile = path.join(srcDir, "beta.ts");
    await fsp.writeFile(alphaFile, `export function alpha() { return 'a'; }\n`, "utf8");
    await fsp.writeFile(betaFile, `export function beta() { return 'b'; }\n`, "utf8");

    await buildProjectIndex(root);

    type RefResult = Awaited<ReturnType<typeof indexerNavigation.findReferences>>;
    const deferreds: Array<{
      promise: Promise<RefResult>;
      resolve: (value: RefResult) => void;
      def: SymbolDef | null;
    }> = [];

    const createDeferred = (def: SymbolDef | null) => {
      let resolve: (value: RefResult) => void = () => {};
      const promise = new Promise<RefResult>((res) => {
        resolve = res;
      });
      const entry = { promise, resolve, def };
      deferreds.push(entry);
      return entry;
    };

    const findSpy = vi.spyOn(indexerNavigation, "findReferences").mockImplementation((idx, req) => {
      const def = "def" in req ? req.def : null;
      const entry = createDeferred(def ?? null);
      return entry.promise;
    });

    try {
      const reportPromise = buildReviewReport(root, {
        files: [alphaFile, betaFile],
        includeSymbolDetails: true,
        maxCallsites: 1,
      });

      const waitFor = async (predicate: () => boolean) => {
        for (let i = 0; i < 50; i += 1) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("Timed out waiting for parallel calls");
      };

      await waitFor(() => deferreds.length === 2);

      for (const entry of deferreds) {
        if (!entry.def) {
          entry.resolve({ status: "not_found", reason: "missing def" });
          continue;
        }
        entry.resolve({
          status: "ok",
          definition: entry.def,
          references: [],
        });
      }

      const report = await reportPromise;
      expect(report.status).toBe("ok");
      expect(report.changedFiles.length).toBe(2);
    } finally {
      findSpy.mockRestore();
    }
  });

  it("respects reference concurrency limits", async () => {
    const root = await mkTmpDir("dg-review-concurrency-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    const alphaFile = path.join(srcDir, "alpha.ts");
    const betaFile = path.join(srcDir, "beta.ts");
    await fsp.writeFile(alphaFile, `export function alpha() { return 'a'; }\n`, "utf8");
    await fsp.writeFile(betaFile, `export function beta() { return 'b'; }\n`, "utf8");

    await buildProjectIndex(root);

    type RefResult = Awaited<ReturnType<typeof indexerNavigation.findReferences>>;
    const deferreds: Array<{ resolve: (value: RefResult) => void }> = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const findSpy = vi.spyOn(indexerNavigation, "findReferences").mockImplementation(() => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      let resolveFn: (value: RefResult) => void = () => {};
      const promise = new Promise<RefResult>((resolve) => {
        resolveFn = resolve;
      });
      deferreds.push({
        resolve: (value: RefResult) => {
          inFlight -= 1;
          resolveFn(value);
        },
      });
      return promise;
    });

    try {
      const reportPromise = buildReviewReport(root, {
        files: [alphaFile, betaFile],
        includeSymbolDetails: true,
        maxCallsites: 1,
        referenceConcurrency: 1,
      });

      const waitFor = async (predicate: () => boolean) => {
        for (let i = 0; i < 50; i += 1) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("Timed out waiting for findReferences calls");
      };

      await waitFor(() => deferreds.length === 1);
      deferreds[0]?.resolve({ status: "not_found", reason: "missing def" });

      await waitFor(() => deferreds.length === 2);
      deferreds[1]?.resolve({ status: "not_found", reason: "missing def" });

      const report = await reportPromise;
      expect(report.status).toBe("ok");
      expect(maxInFlight).toBe(1);
    } finally {
      findSpy.mockRestore();
    }
  });

  it("keeps parsed trees and bounds reference work for review callsites", async () => {
    const root = await mkTmpDir("dg-review-reference-bounds-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    const featureFile = path.join(srcDir, "feature.ts");
    const consumerFile = path.join(srcDir, "consumer.ts");
    await fsp.writeFile(featureFile, `export function greet(name: string) { return name; }\n`, "utf8");
    await fsp.writeFile(
      consumerFile,
      `import { greet } from './feature';\nexport const run = () => greet('hi');\n`,
      "utf8",
    );

    await buildProjectIndex(root);

    const originalBuildProjectIndexIncremental = indexerBuild.buildProjectIndexIncremental;
    const originalFindReferences = indexerNavigation.findReferences;
    const capturedIndexOpts: Array<IncrementalBuildOptions | undefined> = [];
    const capturedReferenceLimits: number[] = [];

    const buildSpy = vi
      .spyOn(indexerBuild, "buildProjectIndexIncremental")
      .mockImplementation(async (projectRoot, opts) => {
        capturedIndexOpts.push(opts);
        return await originalBuildProjectIndexIncremental(projectRoot, opts);
      });

    const findSpy = vi.spyOn(indexerNavigation, "findReferences").mockImplementation(async (idx, req, opts) => {
      if (opts?.maxReferences !== undefined) {
        capturedReferenceLimits.push(opts.maxReferences);
      }
      return await originalFindReferences(idx, req, opts);
    });

    try {
      const report = await buildReviewReport(root, {
        files: [featureFile],
        includeSymbolDetails: true,
        maxCallsites: 2,
      });

      expect(report.status).toBe("ok");
      expect(capturedIndexOpts.some((opts) => opts?.keepParsed)).toBe(true);
      expect(capturedReferenceLimits.length).toBeGreaterThan(0);
      expect(capturedReferenceLimits.every((value) => value === 3)).toBe(true);
    } finally {
      findSpy.mockRestore();
      buildSpy.mockRestore();
    }
  });

  it("applies review depth presets to symbol details and graph options", async () => {
    const root = await mkTmpDir("dg-review-presets-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    const featureFile = path.join(srcDir, "feature.ts");
    await fsp.writeFile(
      featureFile,
      [`export function greet(name: string) {`, `  return \`hello \${name}\`;`, `}`, ``].join("\n"),
      "utf8",
    );
    const consumers = ["alpha", "beta", "gamma"].map((name) => ({
      name,
      file: path.join(srcDir, `${name}.ts`),
    }));
    for (const consumer of consumers) {
      await fsp.writeFile(
        consumer.file,
        [
          `import { greet } from './feature';`,
          ``,
          `export function run${consumer.name}() {`,
          `  return greet('${consumer.name}');`,
          `}`,
          ``,
        ].join("\n"),
        "utf8",
      );
    }

    await buildProjectIndex(root);

    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental");
    try {
      const minimal = await buildReviewReport(root, {
        files: [featureFile],
        reviewDepth: "minimal",
      });
      const standard = await buildReviewReport(root, {
        files: [featureFile],
        reviewDepth: "standard",
      });
      const deep = await buildReviewReport(root, {
        files: [featureFile],
        reviewDepth: "deep",
      });

      const findGreet = (report: Awaited<typeof minimal>) =>
        report.changedFiles
          .find((entry) => entry.file === "src/feature.ts")
          ?.symbols.find((symbol) => symbol.name === "greet");

      const minimalGreet = findGreet(minimal);
      expect(minimalGreet).toBeDefined();
      expect(minimalGreet?.definitionSnippet).toBeUndefined();
      expect(minimalGreet?.callsites).toBeUndefined();

      const standardGreet = findGreet(standard);
      expect(standardGreet?.definitionSnippet).toContain("function greet");
      expect(standardGreet?.callsites?.length).toBeGreaterThan(0);
      expect(standardGreet?.callsites?.length).toBeLessThanOrEqual(2);

      const deepGreet = findGreet(deep);
      expect(deepGreet?.callsites?.length).toBe(3);

      const fastFlags = buildSpy.mock.calls.map((call) => call[1]?.graph?.fast);
      expect(fastFlags[0]).toBe(true);
      expect(fastFlags[1]).toBe(false);
      expect(fastFlags[2]).toBe(false);
    } finally {
      buildSpy.mockRestore();
    }
  });

  it("adds duplicate sibling review tasks for changed duplicate implementations", async () => {
    const root = await mkTmpDir("dg-review-duplicates-");
    runGit(root, ["init"]);
    runGit(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    const source = `
export function normalizeInvoiceRows(rows: Array<{ amount: number; tax: number }>) {
  const totals: number[] = [];
  const labels: string[] = [];
  for (const row of rows) {
    const subtotal = row.amount + row.tax;
    const rounded = Math.round(subtotal * 100) / 100;
    const label = rounded > 100 ? "large" : "small";
    labels.push(label);
    totals.push(rounded);
  }
  const encoded = totals.map((value, index) => labels[index] + ":" + value.toFixed(2));
  return encoded.filter((value) => value.includes(":")).join(",");
}
`;
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    await fsp.writeFile(path.join(root, "src/a.ts"), source, "utf8");
    await fsp.writeFile(path.join(root, "src/b.ts"), source, "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);

    await fsp.writeFile(path.join(root, "src/a.ts"), source.replace("large", "huge"), "utf8");

    const reviewBuildReport: ReviewBuildReport = { timings: {} };
    const report = await buildReviewReport(root, {
      gitBase: "HEAD",
      gitHead: "WORKTREE",
      report: reviewBuildReport,
    });
    const task = report.reviewTasks.find((entry) => entry.reason === "duplicate-sibling");
    const index = reviewBuildReport.index;
    const preparedAnalysis = reviewBuildReport.duplicateAnalysis;
    if (!index || !preparedAnalysis) throw new Error("Review duplicate preparation was not retained");
    const unpreparedSummary = await collectDuplicateLeadSummary({
      index,
      projectRoot: root,
      scope: "all",
    });
    const preparedSummary = await collectDuplicateLeadSummary({
      index,
      projectRoot: root,
      scope: "all",
      preparedAnalysis,
    });

    expect(task).toBeDefined();
    expect(task?.title).toBe("Check related duplicate implementation");
    expect(task?.description).toContain("src/b.ts");
    expect(task?.priority).toBe("high");
    expect(preparedSummary).toEqual(unpreparedSummary);
    expect(preparedSummary?.leads.length ?? 0).toBeGreaterThan(0);
    expect(Object.keys(reviewBuildReport)).not.toContain("duplicateAnalysis");
  });

  it("keeps duplicate sibling tasks for symbol-free changed regions in files with changed symbols", async () => {
    const root = await mkTmpDir("dg-review-duplicate-top-level-");
    runGit(root, ["init"]);
    runGit(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    const topLevelSource = [
      "['one', 'two', 'three', 'four']",
      "  .concat(['red', 'blue', 'green', 'yellow'])",
      "  .map((value) => value.toUpperCase())",
      "  .filter((value) => value.length > 0)",
      "  .join(',');",
      "",
    ].join("\n");
    const bSource = `${topLevelSource}export function changed() { return 1; }\n`;
    await fsp.writeFile(path.join(root, "src/a.ts"), topLevelSource, "utf8");
    await fsp.writeFile(path.join(root, "src/b.ts"), bSource, "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);

    await fsp.writeFile(
      path.join(root, "src/b.ts"),
      `${topLevelSource}\nexport function changed() { return 2; }\n`,
      "utf8",
    );

    const report = await buildReviewReport(root, { gitBase: "HEAD", gitHead: "WORKTREE" });
    const task = report.reviewTasks.find(
      (entry) => entry.reason === "duplicate-sibling" && entry.description.includes("src/a.ts"),
    );

    expect(task).toBeDefined();
  });
  it("applies scoped bucket-size limits identically to prepared and direct duplicate analysis", async () => {
    const root = await mkTmpDir("dg-review-duplicate-scoped-buckets-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    const source = [
      '["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"]',
      "  .map((value, index) => value.toUpperCase() + String(index))",
      "  .filter((value) => value.length > 3)",
      '  .reduce((result, value) => result + ":" + value, "");',
      "",
    ].join("\n");
    const files = Array.from({ length: 4 }, (_, index) => path.join(srcDir, `copy-${index}.ts`));
    await Promise.all(files.map(async (file) => await fsp.writeFile(file, source, "utf8")));
    const index = await buildProjectIndex(root, { cache: "off" });
    const preparationOptions = {
      projectRoot: root,
      includeSmall: true,
      minTokens: 1,
    };
    const prepared = await prepareDuplicateAnalysis(index, preparationOptions);
    const scopedFiles = files.slice(0, 2);
    const atBoundaryOptions = {
      ...preparationOptions,
      files: scopedFiles,
      minConfidence: "high" as const,
      maxBucketSize: 2,
      limit: 10,
    };
    const overBoundaryOptions = {
      ...atBoundaryOptions,
      maxBucketSize: 1,
    };

    const directAtBoundary = await findDuplicates(index, atBoundaryOptions);
    const preparedAtBoundary = await findDuplicatesWithPreparedAnalysis(prepared, atBoundaryOptions);
    const directOverBoundary = await findDuplicates(index, overBoundaryOptions);
    const preparedOverBoundary = await findDuplicatesWithPreparedAnalysis(prepared, overBoundaryOptions);

    expect(preparedAtBoundary).toEqual(directAtBoundary);
    expect(directAtBoundary.groups.length).toBeGreaterThan(0);
    expect(preparedOverBoundary).toEqual(directOverBoundary);
    expect(directOverBoundary.groups).toEqual([]);
    expect(directOverBoundary.omittedCounts.oversizedBuckets).toBeGreaterThan(0);
  });
  it("keeps a changed test ahead of low-confidence pattern fill-ins before limiting", async () => {
    const root = await mkTmpDir("dg-review-changed-test-");
    const changedTest = path.join(root, "z-changed.test.ts");
    const patternTest = path.join(root, "a-pattern.test.ts");
    await fsp.writeFile(changedTest, "export const changed = 1;\n", "utf8");
    await fsp.writeFile(patternTest, "export const pattern = 1;\n", "utf8");
    await buildProjectIndex(root, { cache: "disk" });
    await fsp.writeFile(changedTest, "export const changed = 2;\n", "utf8");

    const report = await buildReviewReport(root, {
      cache: "disk",
      files: [changedTest],
      maxCandidates: 1,
    });

    expect(report.candidateTests).toEqual([
      {
        file: "z-changed.test.ts",
        confidence: "high",
        reason: "changedTest",
      },
    ]);
  });
});

describe("Indexing helper", () => {
  it("keeps star-import expansions in sync between full and subset builds", async () => {
    const root = await mkTmpDir("dg-review-indexer-");
    const libDir = path.join(root, "lib");
    await fsp.mkdir(libDir, { recursive: true });
    const utilsPath = path.join(libDir, "utils.ts");
    const indexPath = path.join(libDir, "index.ts");
    await fsp.writeFile(utilsPath, `export function helper() { return 'ok'; }\n`, "utf8");
    await fsp.writeFile(indexPath, `export * from './utils';\n`, "utf8");

    const fullIndex = await buildProjectIndex(root);
    const fullModule = fullIndex.byFile.get(normalize(indexPath));
    if (!fullModule) throw new Error("Full index missing index.ts");
    const utilsNormalized = normalize(utilsPath);
    const fullExportStar = fullModule.exports.find(
      (exp) =>
        exp.type === "exportStar" &&
        typeof exp.fromModule === "string" &&
        normalize(exp.fromModule) === utilsNormalized,
    );
    expect(fullExportStar).toBeDefined();

    const subsetIndex = await buildProjectIndexFromFiles(root, [indexPath, utilsPath]);
    const subsetModule = subsetIndex.byFile.get(normalize(indexPath));
    if (!subsetModule) throw new Error("Subset index missing index.ts");
    const subsetExportStar = subsetModule.exports.find(
      (exp) =>
        exp.type === "exportStar" &&
        typeof exp.fromModule === "string" &&
        normalize(exp.fromModule) === utilsNormalized,
    );
    expect(subsetExportStar).toBeDefined();
  });

  it("keeps Ruby star-import namespace expansion in sync for incremental builds", async () => {
    const root = await mkTmpDir("dg-review-ruby-incremental-");
    const utilPath = path.join(root, "util.rb");
    const mainPath = path.join(root, "main.rb");
    await fsp.writeFile(utilPath, ["class Tool", "  VALUE = 1", "end", ""].join("\n"), "utf8");
    await fsp.writeFile(mainPath, ["require_relative './util'", "", "value = Tool::VALUE", ""].join("\n"), "utf8");

    const normalizedMainPath = mainPath.replace(/\\/g, "/");
    const fullIndex = await buildProjectIndex(root, { cache: "disk" });
    const fullMainModule = fullIndex.byFile.get(normalizedMainPath);
    expect(fullMainModule).toBeDefined();

    const incrementalIndex = await indexerBuild.buildProjectIndexIncremental(root, {
      cache: "disk",
      files: [mainPath],
    });
    const incrementalMainModule = incrementalIndex.byFile.get(normalizedMainPath);
    expect(incrementalMainModule).toBeDefined();

    const hasToolNamespaceImport = (imports: NonNullable<typeof fullMainModule>["imports"]) =>
      imports.some(
        (imp) => imp.kind === "namespace" && imp.localNS === "Tool" && imp.resolved === utilPath.replace(/\\/g, "/"),
      );

    expect(hasToolNamespaceImport(fullMainModule?.imports ?? [])).toBe(true);
    expect(hasToolNamespaceImport(incrementalMainModule?.imports ?? [])).toBe(true);
  });
});

describe("review duplicate and candidate budget gates", () => {
  it("duplicateTasks: false skips duplicate analysis work", async () => {
    const root = await mkTmpDir("dg-review-duplicates-off-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "test@git.local"]);
    runGit(root, ["config", "user.name", "Codegraph Bot"]);
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    const duplicateSource = [
      "export function normalizeInvoiceRows(rows: Array<{ amount: number; tax: number }>) {",
      "  const totals: number[] = [];",
      "  const labels: string[] = [];",
      "  for (const row of rows) {",
      "    const subtotal = row.amount + row.tax;",
      "    const rounded = Math.round(subtotal * 100) / 100;",
      '    const label = rounded > 100 ? "large" : "small";',
      "    labels.push(label);",
      "    totals.push(rounded);",
      "  }",
      '  return totals.map((value, index) => labels[index] + ":" + value.toFixed(2)).join(",");',
      "}",
      "",
    ].join("\n");
    await fsp.writeFile(path.join(srcDir, "duplicate-a.ts"), duplicateSource, "utf8");
    await fsp.writeFile(path.join(srcDir, "duplicate-b.ts"), duplicateSource, "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);
    await fsp.writeFile(path.join(srcDir, "duplicate-a.ts"), duplicateSource.replace("large", "huge"), "utf8");
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "change"]);
    const base = runGit(root, ["rev-parse", "HEAD^"]);

    const enabledReport: ReviewBuildReport = { timings: {} };
    const enabled = await buildReviewReport(root, {
      gitBase: base,
      gitHead: "HEAD",
      report: enabledReport,
    });
    const disabledReport: ReviewBuildReport = { timings: {} };
    const disabled = await buildReviewReport(root, {
      gitBase: base,
      gitHead: "HEAD",
      duplicateTasks: false,
      report: disabledReport,
    });

    expect(enabled.reviewTasks.some((task) => task.reason === "duplicate-sibling")).toBe(true);
    expect(disabled.reviewTasks.some((task) => task.reason === "duplicate-sibling")).toBe(false);
    expect(disabledReport.duplicateAnalysis).toBeUndefined();
    expect(disabledReport.timings.duplicateAnalysisMs).toBe(0);
  });

  it("marks changed test files as high-confidence changedTest candidates", async () => {
    const root = await mkTmpDir("dg-review-changed-test-candidate-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "test@git.local"]);
    runGit(root, ["config", "user.name", "Codegraph Bot"]);
    const srcDir = path.join(root, "src");
    const testsDir = path.join(root, "tests");
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(testsDir, { recursive: true });
    await fsp.writeFile(path.join(srcDir, "math.ts"), "export const add = (a: number, b: number) => a + b;\n", "utf8");
    await fsp.writeFile(
      path.join(testsDir, "math.test.ts"),
      "import { add } from '../src/math';\nadd(1, 2);\n",
      "utf8",
    );
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);
    await fsp.writeFile(
      path.join(testsDir, "math.test.ts"),
      "import { add } from '../src/math';\nadd(2, 2);\n",
      "utf8",
    );
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "test change"]);
    const base = runGit(root, ["rev-parse", "HEAD^"]);

    const report = await buildReviewReport(root, { gitBase: base, gitHead: "HEAD" });
    expect(report.candidateTests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "tests/math.test.ts",
          confidence: "high",
          reason: "changedTest",
        }),
      ]),
    );
  });
});
