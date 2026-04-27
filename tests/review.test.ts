import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  buildProjectIndex,
  buildProjectIndexFromFiles,
  buildReviewReport,
} from "../src/index.js";
import * as indexer from "../src/indexer.js";
import * as impactMap from "../src/impact/map.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function runGit(root: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.status}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
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
    expect(report.changedFiles[0]?.symbols.some((s) => s.name === "a")).toBe(
      true,
    );
  });

  it("includes definition snippets and callsites when enabled", async () => {
    const root = await mkTmpDir("dg-review-details-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    const featureFile = path.join(srcDir, "feature.ts");
    const consumerFile = path.join(srcDir, "consumer.ts");
    await fsp.writeFile(
      featureFile,
      [
        `export function greet(name: string) {`,
        `  return \`hi \${name}\`;`,
        `}`,
        ``,
      ].join("\n"),
      "utf8",
    );
    await fsp.writeFile(
      consumerFile,
      [
        `import { greet } from './feature';`,
        ``,
        `export function run() {`,
        `  greet('world');`,
        `}`,
        ``,
      ].join("\n"),
      "utf8",
    );

    await buildProjectIndex(root);
    await fsp.writeFile(
      featureFile,
      [
        `export function greet(name: string) {`,
        `  return \`hello \${name}\`;`,
        `}`,
        ``,
      ].join("\n"),
      "utf8",
    );

    const report = await buildReviewReport(root, {
      files: [featureFile],
      includeSymbolDetails: true,
      maxCallsites: 2,
    });
    const featureSummary = report.changedFiles.find(
      (entry) => entry.file === "src/feature.ts",
    );
    expect(featureSummary).toBeDefined();
    const greetSummary = featureSummary?.symbols.find(
      (symbol) => symbol.name === "greet",
    );
    expect(greetSummary).toBeDefined();
    expect(greetSummary?.definitionSnippet).toContain("function greet");
    const callsites = greetSummary?.callsites ?? [];
    expect(callsites.length).toBeGreaterThan(0);
    expect(callsites.length).toBeLessThanOrEqual(2);
    expect(
      callsites.some(
        (site) =>
          site.file === "src/consumer.ts" &&
          (site.range.start.line === 1 || site.range.start.line === 4),
      ),
    ).toBe(true);
  });

  it("limits symbols to diff hunks and includes diff snippets when provided", async () => {
    const root = await mkTmpDir("dg-review-diff-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    const featureFile = path.join(srcDir, "feature.ts");
    await fsp.writeFile(
      featureFile,
      [
        `export function alpha() {`,
        `  return 2;`,
        `}`,
        ``,
        `export function beta() {`,
        `  return 5;`,
        `}`,
        ``,
      ].join("\n"),
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

    const summary = report.changedFiles.find(
      (entry) => entry.file === "src/feature.ts",
    );
    expect(summary).toBeDefined();
    const symbols = summary?.symbols ?? [];
    expect(symbols.some((symbol) => symbol.name === "alpha")).toBe(true);
    expect(symbols.some((symbol) => symbol.name === "beta")).toBe(false);

    const alpha = symbols.find((symbol) => symbol.name === "alpha");
    expect(
      alpha?.diffSnippets?.some((snippet) => snippet.includes("return 2;")),
    ).toBe(true);
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

  it("surfaces invalid git revisions instead of reporting no changes", async () => {
    const root = await mkTmpDir("dg-review-invalid-git-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "test@git.local"]);
    runGit(root, ["config", "user.name", "Codegraph Bot"]);
    await fsp.writeFile(
      path.join(root, "tracked.ts"),
      `export const value = 1;\n`,
      "utf8",
    );
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);

    await expect(
      buildReviewReport(root, { gitBase: "definitely-not-a-ref" }),
    ).rejects.toThrow(/definitely-not-a-ref/);
  });

  it("reports deleted files surfaced by git diffs", async () => {
    const root = await mkTmpDir("dg-review-deleted-");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "delete@git.local"]);
    runGit(root, ["config", "user.name", "Codegraph Bot"]);
    const filePath = path.join(root, "gone.ts");
    const testFile = path.join(root, "gone.test.ts");
    await fsp.writeFile(filePath, `export const gone = true;\n`, "utf8");
    await fsp.writeFile(
      testFile,
      `import { gone } from './gone';\nexport const seen = gone;\n`,
      "utf8",
    );
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
    expect(
      report.changedFiles[0]?.symbols.some((symbol) => symbol.name === "gone"),
    ).toBe(true);
    expect(
      report.changedFiles[0]?.symbols.some((symbol) => symbol.exported),
    ).toBe(true);
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

    const fileSummary = report.changedFiles.find(
      (entry) => entry.file === "src/index.ts",
    );
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
    await fsp.writeFile(
      testFile,
      `import { gone } from '../src/lib';\nexport const seen = gone;\n`,
      "utf8",
    );

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
    await fsp.writeFile(
      verifyFile,
      `import { gone } from '../src/lib';\nexport const seen = gone;\n`,
      "utf8",
    );

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
    await fsp.writeFile(
      testFile,
      `import { gone } from '@lib';\nexport const seen = gone;\n`,
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
    await fsp.writeFile(
      path.join(appDir, "package.json"),
      JSON.stringify({ name: "@repo/app" }, null, 2),
      "utf8",
    );
    await fsp.writeFile(libFile, `export const gone = 1;\n`, "utf8");
    await fsp.writeFile(
      testFile,
      `import { gone } from '@repo/lib';\nexport const seen = gone;\n`,
      "utf8",
    );

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
    await fsp.writeFile(
      testFile,
      `import { View } from '../src/view.jsx';\nexport const seen = View;\n`,
      "utf8",
    );

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
    await fsp.writeFile(
      mainFile,
      `import { gone } from './lib';\nexport const seen = gone;\n`,
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
    await fsp.writeFile(
      consumerFile,
      `import { lib } from './lib';\nexport const seen = lib;\n`,
      "utf8",
    );

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
    await fsp.writeFile(
      consumerFile,
      `import { dep } from './dep';\nexport const seen = dep;\n`,
      "utf8",
    );

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
    await fsp.writeFile(
      consumerFile,
      `import { lib } from '@lib';\nexport const seen = lib;\n`,
      "utf8",
    );

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
    await fsp.writeFile(
      consumerFile,
      `import { dep } from '@dep';\nexport const seen = dep;\n`,
      "utf8",
    );

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
    await fsp.writeFile(
      path.join(appDir, "package.json"),
      JSON.stringify({ name: "@repo/app" }, null, 2),
      "utf8",
    );
    await fsp.writeFile(libFile, `export const lib = 1;\n`, "utf8");
    await fsp.writeFile(
      consumerFile,
      `import { lib } from '@repo/lib';\nexport const seen = lib;\n`,
      "utf8",
    );

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
    await fsp.writeFile(
      path.join(appDir, "package.json"),
      JSON.stringify({ name: "@repo/app" }, null, 2),
      "utf8",
    );
    await fsp.writeFile(depFile, `export const dep = 1;\n`, "utf8");
    await fsp.writeFile(
      consumerFile,
      `import { dep } from '@repo/lib';\nexport const seen = dep;\n`,
      "utf8",
    );

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
    await fsp.writeFile(
      testFile,
      `import { impl } from '../src/index';\nexport const seen = impl;\n`,
      "utf8",
    );
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

    const barrelSummary = report.changedFiles.find(
      (entry) => entry.file === "src/index.ts",
    );
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
    expect(
      report.reviewTasks.some((task) => task.reason === "missing-files"),
    ).toBe(true);
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

    const locateSpy = vi
      .spyOn(impactMap, "locateChangedSymbolsWithLines")
      .mockResolvedValue({
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
      expect(report.diagnostics?.symbolMappingParseFailures).toEqual([
        "feature.ts",
      ]);
      expect(report.riskSummary.signals).toContain("symbol-mapping-degraded");
      expect(
        report.reviewTasks.some(
          (task) => task.reason === "symbol-mapping-degraded",
        ),
      ).toBe(true);
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
    await fsp.writeFile(
      featureFile,
      `export function helper() { return 1; }\n`,
      "utf8",
    );
    await fsp.writeFile(
      testFile,
      `import { helper } from '../src/feature';\nhelper();\n`,
      "utf8",
    );

    await buildProjectIndex(root);
    const manifestPath = path.join(
      root,
      ".codegraph-cache",
      "index-v1",
      "manifest.json",
    );
    expect(fs.existsSync(manifestPath)).toBe(true);

    await fsp.writeFile(
      featureFile,
      `export function helper() { return 2; }\n`,
      "utf8",
    );
    const report = await buildReviewReport(root, {
      files: [featureFile],
      maxCandidates: 5,
    });

    expect(report.summary.candidateTests).toBeGreaterThan(0);
    expect(
      report.candidateTests.some(
        (candidate) => candidate.file === "tests/feature.test.ts",
      ),
    ).toBe(true);
    expect(
      report.candidateTests.some(
        (candidate) => candidate.confidence === "high",
      ),
    ).toBe(true);
  });

  it("processes symbol details across files in parallel", async () => {
    const root = await mkTmpDir("dg-review-parallel-");
    const srcDir = path.join(root, "src");
    await fsp.mkdir(srcDir, { recursive: true });
    const alphaFile = path.join(srcDir, "alpha.ts");
    const betaFile = path.join(srcDir, "beta.ts");
    await fsp.writeFile(
      alphaFile,
      `export function alpha() { return 'a'; }\n`,
      "utf8",
    );
    await fsp.writeFile(
      betaFile,
      `export function beta() { return 'b'; }\n`,
      "utf8",
    );

    await buildProjectIndex(root);

    type RefResult = Awaited<ReturnType<typeof indexer.findReferences>>;
    const deferreds: Array<{
      promise: Promise<RefResult>;
      resolve: (value: RefResult) => void;
      def: indexer.SymbolDef | null;
    }> = [];

    const createDeferred = (def: indexer.SymbolDef | null) => {
      let resolve: (value: RefResult) => void = () => {};
      const promise = new Promise<RefResult>((res) => {
        resolve = res;
      });
      const entry = { promise, resolve, def };
      deferreds.push(entry);
      return entry;
    };

    const findSpy = vi
      .spyOn(indexer, "findReferences")
      .mockImplementation((idx, req) => {
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
    await fsp.writeFile(
      alphaFile,
      `export function alpha() { return 'a'; }\n`,
      "utf8",
    );
    await fsp.writeFile(
      betaFile,
      `export function beta() { return 'b'; }\n`,
      "utf8",
    );

    await buildProjectIndex(root);

    type RefResult = Awaited<ReturnType<typeof indexer.findReferences>>;
    const deferreds: Array<{ resolve: (value: RefResult) => void }> = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const findSpy = vi
      .spyOn(indexer, "findReferences")
      .mockImplementation(() => {
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
    await fsp.writeFile(
      featureFile,
      `export function greet(name: string) { return name; }\n`,
      "utf8",
    );
    await fsp.writeFile(
      consumerFile,
      `import { greet } from './feature';\nexport const run = () => greet('hi');\n`,
      "utf8",
    );

    await buildProjectIndex(root);

    const originalBuildProjectIndexIncremental =
      indexer.buildProjectIndexIncremental;
    const originalFindReferences = indexer.findReferences;
    const capturedIndexOpts: Array<
      indexer.IncrementalBuildOptions | undefined
    > = [];
    const capturedReferenceLimits: number[] = [];

    const buildSpy = vi
      .spyOn(indexer, "buildProjectIndexIncremental")
      .mockImplementation(async (projectRoot, opts) => {
        capturedIndexOpts.push(opts);
        return await originalBuildProjectIndexIncremental(projectRoot, opts);
      });

    const findSpy = vi
      .spyOn(indexer, "findReferences")
      .mockImplementation(async (idx, req, opts) => {
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
      [
        `export function greet(name: string) {`,
        `  return \`hello \${name}\`;`,
        `}`,
        ``,
      ].join("\n"),
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

    const buildSpy = vi.spyOn(indexer, "buildProjectIndexIncremental");
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
});

describe("Indexing helper", () => {
  it("keeps star-import expansions in sync between full and subset builds", async () => {
    const root = await mkTmpDir("dg-review-indexer-");
    const libDir = path.join(root, "lib");
    await fsp.mkdir(libDir, { recursive: true });
    const utilsPath = path.join(libDir, "utils.ts");
    const indexPath = path.join(libDir, "index.ts");
    await fsp.writeFile(
      utilsPath,
      `export function helper() { return 'ok'; }\n`,
      "utf8",
    );
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

    const subsetIndex = await buildProjectIndexFromFiles(root, [
      indexPath,
      utilsPath,
    ]);
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
    await fsp.writeFile(
      utilPath,
      ["class Tool", "  VALUE = 1", "end", ""].join("\n"),
      "utf8",
    );
    await fsp.writeFile(
      mainPath,
      ["require_relative './util'", "", "value = Tool::VALUE", ""].join("\n"),
      "utf8",
    );

    const normalizedMainPath = mainPath.replace(/\\/g, "/");
    const fullIndex = await buildProjectIndex(root, { cache: "disk" });
    const fullMainModule = fullIndex.byFile.get(normalizedMainPath);
    expect(fullMainModule).toBeDefined();

    const incrementalIndex = await indexer.buildProjectIndexIncremental(root, {
      cache: "disk",
      files: [mainPath],
    });
    const incrementalMainModule =
      incrementalIndex.byFile.get(normalizedMainPath);
    expect(incrementalMainModule).toBeDefined();

    const hasToolNamespaceImport = (
      imports: NonNullable<typeof fullMainModule>["imports"],
    ) =>
      imports.some(
        (imp) =>
          imp.kind === "namespace" &&
          imp.localNS === "Tool" &&
          imp.resolved === utilPath.replace(/\\/g, "/"),
      );

    expect(hasToolNamespaceImport(fullMainModule?.imports ?? [])).toBe(true);
    expect(hasToolNamespaceImport(incrementalMainModule?.imports ?? [])).toBe(
      true,
    );
  });
});
