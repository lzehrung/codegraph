import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function readJson(relativePath: string): Record<string, unknown> {
  const absolutePath = path.resolve(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf8")) as Record<string, unknown>;
}

function readText(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function declarationHasOwnJsDoc(declarationText: string, symbol: string): boolean {
  const declarationMatch = new RegExp(`export declare function ${symbol}\\b`).exec(declarationText);
  if (!declarationMatch) {
    return false;
  }
  const beforeDeclaration = declarationText.slice(0, declarationMatch.index).trimEnd();
  return /\/\*\*[\s\S]*\*\/$/.test(beforeDeclaration);
}

function typeDeclarationHasOwnJsDoc(declarationText: string, symbol: string): boolean {
  const declarationMatch = new RegExp(`export type ${symbol}\\b`).exec(declarationText);
  if (!declarationMatch) {
    return false;
  }
  const beforeDeclaration = declarationText.slice(0, declarationMatch.index).trimEnd();
  return /\/\*\*[\s\S]*\*\/$/.test(beforeDeclaration);
}

function extractExportedTypeDeclaration(source: string, typeName: string): string {
  const declarationStart = source.indexOf(`export type ${typeName} =`);
  expect(declarationStart).toBeGreaterThan(-1);

  let depth = 0;
  for (let index = declarationStart; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      depth += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      continue;
    }
    if (character === ";" && depth === 0) {
      return source.slice(declarationStart, index + 1);
    }
  }

  throw new Error(`Could not find complete declaration for ${typeName}`);
}

function moduleSpecifier(fromDirectory: string, toFile: string): string {
  const relativePath = path.relative(fromDirectory, toFile).replaceAll(path.sep, "/");
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function expectTypeScriptSurfaceCheck(source: string): void {
  const fixtureDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-codegraph-ts-surface-"));
  const fixturePath = path.join(fixtureDir, "impact-streaming-options.check.ts");
  const rootDistSpecifier = moduleSpecifier(fixtureDir, path.resolve(process.cwd(), "dist/index.js"));
  const fixtureSource = source.replaceAll("../dist/index.js", rootDistSpecifier);
  fs.writeFileSync(fixturePath, fixtureSource, "utf8");

  try {
    const tscPath = path.resolve(process.cwd(), "node_modules/typescript/bin/tsc");
    const result = spawnSync(
      process.execPath,
      [
        tscPath,
        "--noEmit",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--strict",
        "--exactOptionalPropertyTypes",
        "--skipLibCheck",
        fixturePath,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

function listFilesRecursive(relativePath: string, extension: string): string[] {
  const root = path.resolve(process.cwd(), relativePath);
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (entry.isFile() && absolutePath.endsWith(extension)) {
        files.push(path.relative(process.cwd(), absolutePath).replace(/\\/g, "/"));
      }
    }
  };
  visit(root);
  return files.sort();
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function readFrontmatter(source: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  return match?.[1] ?? "";
}

function frontmatterHasUnsafePlainColon(line: string): boolean {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex < 0) {
    return false;
  }

  const value = line.slice(separatorIndex + 1).trim();
  const quotedValue = value.startsWith('"') || value.startsWith("'");
  return !quotedValue && value.includes(": ");
}

function workflowRunCommands(workflow: string): string[] {
  return workflow
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("run: "))
    .map((line) => line.slice("run: ".length));
}

function commandOptionValue(command: string, optionName: string): string | undefined {
  const parts = command.split(/\s+/);
  const optionIndex = parts.indexOf(optionName);
  return optionIndex >= 0 ? parts[optionIndex + 1] : undefined;
}

function readNativeArtifactPackages(baseDir: string): Record<string, unknown>[] {
  const nativeArtifactsDir = path.resolve(baseDir, "packages/codegraph-native/npm");
  if (!fs.existsSync(nativeArtifactsDir)) {
    return [];
  }
  return fs
    .readdirSync(nativeArtifactsDir, {
      withFileTypes: true,
    })
    .filter((entry) => entry.isDirectory())
    .map(
      (entry) =>
        JSON.parse(fs.readFileSync(path.join(nativeArtifactsDir, entry.name, "package.json"), "utf8")) as Record<
          string,
          unknown
        >,
    );
}

describe("package metadata", () => {
  it("treats a missing native artifact staging directory as no staged artifact packages", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-package-metadata-"));
    fs.mkdirSync(path.join(tempDir, "packages", "codegraph-native"), {
      recursive: true,
    });

    expect(readNativeArtifactPackages(tempDir)).toEqual([]);
  });

  it("keeps the declared MIT license text and package metadata aligned", () => {
    const licensePath = path.resolve(process.cwd(), "LICENSE");
    const rootPackage = readJson("package.json");
    const nativePackage = readJson("packages/codegraph-native/package.json");
    const nativeArtifactPackages = readNativeArtifactPackages(process.cwd());

    expect(fs.existsSync(licensePath)).toBe(true);
    expect(fs.readFileSync(licensePath, "utf8")).toContain("MIT License");
    expect(rootPackage.license).toBe("MIT");
    expect(nativePackage.license).toBe("MIT");

    expect(nativePackage.repository).toEqual({
      type: "git",
      url: "git+https://github.com/lzehrung/codegraph.git",
      directory: "packages/codegraph-native",
    });

    for (const artifactPackage of nativeArtifactPackages) {
      expect(artifactPackage.license).toBe("MIT");
    }
  });

  it("keeps the native package optional at the root package boundary", () => {
    const rootPackage = readJson("package.json");
    const nativePackage = readJson("packages/codegraph-native/package.json");
    const dependencies = readStringRecord(rootPackage.dependencies);
    const optionalDependencies = readStringRecord(rootPackage.optionalDependencies);
    const nativeVersion = typeof nativePackage.version === "string" ? nativePackage.version : "";

    expect(dependencies["@lzehrung/codegraph-native"]).toBeUndefined();
    expect(optionalDependencies["@lzehrung/codegraph-native"]).toBe(`^${nativeVersion}`);
  });

  it("ships the raw bundled skill directory without a stale archive copy", () => {
    const rootPackage = readJson("package.json");
    const files =
      Array.isArray(rootPackage.files) && rootPackage.files.every((entry) => typeof entry === "string")
        ? rootPackage.files
        : [];

    expect(files).toContain("codegraph-skill");
    expect(files).not.toContain("codegraph.skill");
  });

  it("keeps bundled skill frontmatter safe for Codex YAML parsing", () => {
    const skillDoc = readText("codegraph-skill/codegraph/SKILL.md");
    const frontmatter = readFrontmatter(skillDoc);

    expect(frontmatter).toContain("name: codegraph");
    expect(frontmatter).toContain(
      'description: "Use for repo structure, symbol navigation, dependency analysis, duplicate triage, and PR impact review when plain text search is too shallow."',
    );
    expect(frontmatter.split(/\r?\n/).filter(frontmatterHasUnsafePlainColon)).toEqual([]);
  });

  it("keeps the published CLI bin path normalized for npm", () => {
    const rootPackage = readJson("package.json");
    const bin = readStringRecord(rootPackage.bin);

    expect(bin.codegraph).toBe("dist/cli.js");
  });

  it("requires a Node runtime with built-in SQLite authorizers", () => {
    const rootPackage = readJson("package.json");
    const engines = readStringRecord(rootPackage.engines);

    expect(engines.node).toBe(">=24.10");
  });

  it("keeps the root package description aligned with the multi-language surface", () => {
    const rootPackage = readJson("package.json");
    const description = typeof rootPackage.description === "string" ? rootPackage.description : "";
    const normalizedDescription = description.toLowerCase();

    expect(normalizedDescription).toContain("multi-language");
    expect(normalizedDescription).not.toContain("js/ts/python monorepos");
  });

  it("keeps lint as a non-mutating verification gate and exposes lint:fix separately", () => {
    const rootPackage = readJson("package.json");
    const scripts = readStringRecord(rootPackage.scripts);
    const eslintConfig = readText("eslint.config.js");

    expect(scripts.lint).toBe('npx eslint "src/**/*.ts" "tests/**/*.ts"');
    expect(scripts["lint:fix"]).toBe('npx eslint "src/**/*.ts" "tests/**/*.ts" --fix');
    expect(eslintConfig).toContain('"tests/languages/samples/**"');
    expect(eslintConfig).toContain('"prefer-const": "error"');
  });

  it("keeps implementation modules from importing through the public barrel", () => {
    const barrelImportPattern =
      /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["'](?:\.\/|(?:\.\.\/)+)index\.js["']|import\(["'](?:\.\/|(?:\.\.\/)+)index\.js["']\)/;
    expect(barrelImportPattern.test('import { value } from "../../index.js";')).toBe(true);
    expect(barrelImportPattern.test('import { value } from "./impact/index.js";')).toBe(false);
    const offenders = listFilesRecursive("src", ".ts").filter((relativePath) => {
      if (relativePath === "src/index.ts") {
        return false;
      }
      return barrelImportPattern.test(readText(relativePath));
    });

    expect(offenders).toEqual([]);
  });

  it("keeps implementation modules from importing through broad internal barrels", () => {
    const broadBarrelImportPattern =
      /\bimport\s+(?:type\s+)?(?:[^;]*?\s+from\s+)?["'](?:\.\/|(?:\.\.\/)+)(?:util|graphs|indexer)\.js["']|import\(["'](?:\.\/|(?:\.\.\/)+)(?:util|graphs|indexer)\.js["']\)/;
    const facadeFiles = new Set(["src/index.ts", "src/graphs.ts", "src/indexer.ts"]);
    const offenders = listFilesRecursive("src", ".ts").filter((relativePath) => {
      if (facadeFiles.has(relativePath)) {
        return false;
      }
      return broadBarrelImportPattern.test(readText(relativePath));
    });

    expect(offenders).toEqual([]);
  });

  it("keeps the graph public module as a lightweight facade", () => {
    const graphFacade = readText("src/graphs.ts");

    expect(graphFacade).not.toContain("export async function collectGraph");
    expect(graphFacade).not.toContain("export async function collectEdgesForFile");
    expect(graphFacade.split(/\r?\n/).length).toBeLessThanOrEqual(130);
  });

  it("keeps graph assembly separate from per-file edge collection", () => {
    const graphBuilder = readText("src/graph-builder.ts");
    const edgeCollector = readText("src/graph-edge-collector.ts");

    expect(graphBuilder).toContain('from "./graph-edge-collector.js"');
    expect(graphBuilder).toContain("export async function collectGraph");
    expect(graphBuilder).not.toContain("export async function collectEdgesForFile");
    expect(edgeCollector).toContain("export async function collectEdgesForFile");
    expect(edgeCollector).not.toContain("export async function collectGraph");
  });

  it("routes prepare through the install-aware prepare script", () => {
    const rootPackage = readJson("package.json");
    const scripts = readStringRecord(rootPackage.scripts);

    expect(scripts.prepare).toBe("node ./scripts/prepare-package.mjs");
  });

  it("keeps npm test on the fast suite and benchmark coverage opt-in", () => {
    const rootPackage = readJson("package.json");
    const scripts = readStringRecord(rootPackage.scripts);

    expect(scripts.test).toBe("npm run test:fast");
    expect(scripts["test:fast"]).toContain("--exclude tests/bench-harness.test.ts");
    expect(scripts["test:fast"]).toContain("--exclude tests/native-semantic-parity.test.ts");
    expect(scripts["test:bench"]).toContain("tests/bench-harness.test.ts");
  });

  it("keeps native-required and reduced-mode fallback test lanes explicit", () => {
    const rootPackage = readJson("package.json");
    const scripts = readStringRecord(rootPackage.scripts);

    expect(scripts["test:native"]).toBe(
      "npm run test:native:rust && npm run test:native:required && npm run test:native:fallback",
    );
    expect(scripts["test:native:required"]).toBe("node ./scripts/run-native-required-tests.mjs");
    expect(scripts["test:native:fallback"]).toContain("tests/native-fallback-reporting.test.ts");
    expect(scripts["test:native:fallback"]).toContain("tests/native-fallback-contract.test.ts");
    expect(scripts["test:ci"]).toContain("--reporter=json");
    expect(scripts["test:ci"]).toContain("--exclude tests/native-worker-parity.test.ts");
  });

  it("exposes opt-in JavaScript, native, and Markdown coverage reporting", () => {
    const rootPackage = readJson("package.json");
    const scripts = readStringRecord(rootPackage.scripts);
    const vitestConfig = readText("vitest.config.ts");
    const devDependencies = readStringRecord(rootPackage.devDependencies);
    const coverageScript = readText("scripts/coverage.mjs");
    const gitignore = readText(".gitignore");

    expect(scripts["test:coverage"]).toBe("node ./scripts/coverage.mjs js");
    expect(scripts["test:coverage:native"]).toBe("node ./scripts/coverage.mjs native");
    expect(scripts["test:coverage:all"]).toBe("node ./scripts/coverage.mjs all");
    expect(scripts["coverage:markdown"]).toBe("node ./scripts/coverage-markdown.mjs all");
    expect(scripts["coverage:setup:native"]).toBe(
      "rustup component add llvm-tools-preview && cargo install cargo-llvm-cov --locked",
    );
    expect(scripts["native:check-artifacts"]).toBe("node ./scripts/check-native-artifacts.mjs");
    expect(scripts["native:stage-local"]).toBe("node ./scripts/stage-native-package.mjs");
    expect(devDependencies["@vitest/coverage-v8"]).toBeDefined();
    expect(vitestConfig).toContain('provider: "v8"');
    expect(vitestConfig).toContain('include: ["src/**/*.{ts,tsx}"]');
    expect(vitestConfig).toContain('"src/indexer/import-types.ts"');
    expect(vitestConfig).not.toContain('"src/impact/types.ts"');
    expect(vitestConfig).toContain('reporter: ["text", "html", "lcov"]');
    expect(vitestConfig).toContain('reportsDirectory: "./coverage/js"');
    expect(coverageScript).toContain("cargo llvm-cov");
    expect(coverageScript).toContain("coverage/native");
    expect(coverageScript).toContain("tests/bench-harness.test.ts");
    expect(coverageScript).toContain("--maxWorkers");
    expect(coverageScript).not.toContain("--minWorkers");
    expect(coverageScript).toContain("writeCoverageMarkdownReports");
    expect(coverageScript).toContain("native/html/index.html");
    expect(coverageScript).toContain("<iframe");
    expect(gitignore).toContain("/coverage/");
  });

  it("lets global installs reuse an existing dist build without invoking workspace builds", () => {
    const result = spawnSync(process.execPath, ["./scripts/prepare-package.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_global: "true",
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Skipping prepare build during global install");
  });

  it("prints slow-test reporter help when help is the leading argument", () => {
    const result = spawnSync(process.execPath, ["./scripts/report-slow-tests.mjs", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: node ./scripts/report-slow-tests.mjs");
    expect(result.stderr).toBe("");
  });

  it("does not keep removed plugin-only workspace dependencies in the root package", () => {
    const rootPackage = readJson("package.json");
    const dependencies = readStringRecord(rootPackage.dependencies);
    const devDependencies = readStringRecord(rootPackage.devDependencies);

    expect(dependencies["@opencode-ai/plugin"]).toBeUndefined();
    expect(devDependencies["@opencode-ai/plugin"]).toBeUndefined();
    expect(fs.existsSync(path.resolve(process.cwd(), "packages/codegraph-opencode-plugin"))).toBe(false);
  });

  it("keeps removed deprecated or redundant package edges out of manifests", () => {
    const rootPackage = readJson("package.json");
    const dependencies = readStringRecord(rootPackage.dependencies);
    const devDependencies = readStringRecord(rootPackage.devDependencies);

    expect(dependencies["better-sqlite3"]).toBeUndefined();
    expect(devDependencies["@types/better-sqlite3"]).toBeUndefined();
    expect(devDependencies["@types/jsdom"]).toBeUndefined();
    expect(devDependencies["@typescript-eslint/eslint-plugin"]).toBeUndefined();
    expect(devDependencies["@typescript-eslint/parser"]).toBeUndefined();
    expect(devDependencies["eslint-import-resolver-typescript"]).toBeUndefined();
    expect(devDependencies["eslint-plugin-import"]).toBeUndefined();
  });

  it("keeps all publishable workspaces under the packages directory", () => {
    const rootPackage = readJson("package.json");
    const workspaces =
      Array.isArray(rootPackage.workspaces) && rootPackage.workspaces.every((entry) => typeof entry === "string")
        ? rootPackage.workspaces
        : [];

    expect(workspaces).toEqual(["packages/*"]);
  });

  it("keeps fallback parser exports out of the native package", () => {
    const nativePackage = readJson("packages/codegraph-native/package.json");
    const dependencies = readStringRecord(nativePackage.dependencies);
    const optionalDependencies = readStringRecord(nativePackage.optionalDependencies);
    const exportsField =
      nativePackage.exports && typeof nativePackage.exports === "object" ? nativePackage.exports : {};

    expect(Object.keys(dependencies)).toEqual([]);
    expect(Object.keys(optionalDependencies)).toEqual([]);
    expect(exportsField).not.toHaveProperty("./js-fallback");
  });
  it("ships the native package runtime helper alongside the entrypoint", () => {
    const nativePackage = readJson("packages/codegraph-native/package.json");
    const files = Array.isArray(nativePackage.files) ? nativePackage.files : [];

    expect(files).toEqual(["index.js", "index.d.ts", "platform.js"]);
  });

  it("does not keep the removed JS fallback workspace package", () => {
    const rootPackage = readJson("package.json");
    const workspaces = Array.isArray(rootPackage.workspaces) ? rootPackage.workspaces : [];

    expect(workspaces).toEqual(["packages/*"]);
    expect(fs.existsSync(path.resolve(process.cwd(), "packages/codegraph-js-fallback"))).toBe(false);
    expect(fs.existsSync(path.resolve(process.cwd(), "packages/codegraph-js-fallback/package.json"))).toBe(false);
  });

  it("keeps the landing README linked to the canonical reference docs", () => {
    const readme = readText("README.md");

    expect(readme).toContain("./docs/installation.md");
    expect(readme).toContain("./docs/cli.md");
    expect(readme).toContain("./docs/library-api.md");
    expect(readme).toContain("./docs/agent-workflows.md");
    expect(readme).toContain("./docs/how-it-works.md");
    expect(readme).toContain("./PUBLISHING.md");
  });

  it("keeps copied README consumers oriented to the library API surface", () => {
    const readme = readText("README.md");

    expect(readme).toContain("## Using as a library");
    expect(readme).toContain("buildProjectIndex");
    expect(readme).toContain("buildReviewReport");
    expect(readme).toContain("analyzeImpactFromDiff");
    expect(readme).toContain("analyzeImpactStreaming");
    expect(readme).toContain("tool_impactJSON");
    expect(readme).toContain("structured fields");
    expect(readme).toContain("./docs/library-api.md");
  });

  it("keeps public API boundary JSDoc available for generated declarations", () => {
    const declarationChecks = [
      { file: "dist/indexer/build-index.d.ts", symbol: "buildProjectIndex" },
      { file: "dist/indexer/build-index.d.ts", symbol: "buildProjectIndexIncremental" },
      { file: "dist/review.d.ts", symbol: "buildReviewReport" },
      { file: "dist/impact/index.d.ts", symbol: "analyzeImpactFromDiff" },
      { file: "dist/impact/streaming.d.ts", symbol: "analyzeImpactStreaming" },
      { file: "dist/agent-tools.d.ts", symbol: "tool_impactJSON" },
      { file: "dist/agent-tools.d.ts", symbol: "tool_getFileOverview" },
    ];

    for (const check of declarationChecks) {
      const declarationText = readText(check.file);
      expect(declarationHasOwnJsDoc(declarationText, check.symbol), `${check.file}:${check.symbol}`).toBe(true);
    }
  });

  it("keeps the public API boundary documented around the root package export", () => {
    const rootPackage = readJson("package.json");
    const rootExports = rootPackage.exports;
    expect(rootExports).toBeDefined();
    const expectedExports = [".", "./agent", "./graphs", "./impact", "./indexer", "./languages"];
    expect(Object.keys(rootExports as Record<string, unknown>).sort()).toEqual(expectedExports);

    for (const packageExport of expectedExports) {
      const exportConfig = (rootExports as Record<string, unknown>)[packageExport];
      expect(exportConfig && typeof exportConfig === "object", packageExport).toBe(true);
      const entry = exportConfig as Record<string, unknown>;
      expect(typeof entry.types, `${packageExport}:types`).toBe("string");
      expect(typeof entry.import, `${packageExport}:import`).toBe("string");
      expect(typeof entry.default, `${packageExport}:default`).toBe("string");
      expect(entry.import, `${packageExport}:import`).toBe(entry.default);
      expect(readText((entry.types as string).replace(/^\.\//, ""))).not.toBe("");
      expect(readText((entry.import as string).replace(/^\.\//, ""))).not.toBe("");
    }

    const libraryApi = readText("docs/library-api.md");
    expect(libraryApi).toContain("## Public API Boundary");
    expect(libraryApi).toContain("@lzehrung/codegraph/agent");
    expect(libraryApi).toContain("@lzehrung/codegraph/graphs");
    expect(libraryApi).toContain("@lzehrung/codegraph/indexer");
    expect(libraryApi).toContain("@lzehrung/codegraph/impact");
    expect(libraryApi).toContain("@lzehrung/codegraph/languages");
    expect(libraryApi).toContain("Public-stable APIs");
    expect(libraryApi).toContain("Public-legacy APIs");
    expect(libraryApi).toContain("Internal-only modules");
    expect(libraryApi).toContain("@lzehrung/codegraph/dist/...");

    const readme = readText("README.md");
    expect(readme).toContain("./docs/library-api.md#public-api-boundary");
  });

  it("scopes streaming summary mode to the streaming API type", () => {
    const impactTypes = readText("src/impact/types.ts");
    const streamingSource = readText("src/impact/streaming.ts");
    const streamingDeclaration = extractExportedTypeDeclaration(streamingSource, "ImpactStreamingOptions");
    const impactOptionsDeclaration = extractExportedTypeDeclaration(impactTypes, "ImpactOptions");
    const rootDeclaration = readText("dist/index.d.ts");
    const impactDeclaration = readText("dist/impact/index.d.ts");
    const streamingDistDeclaration = readText("dist/impact/streaming.d.ts");
    const sessionDeclaration = readText("dist/session.d.ts");

    expect(impactOptionsDeclaration).not.toContain("streamSummary");
    expect(streamingDeclaration).toContain('streamSummary?: "full" | "light"');
    expect(streamingDeclaration).toContain("ImpactOptions");
    expect(rootDeclaration).toContain("type ImpactStreamingOptions");
    expect(impactDeclaration).toContain("type ImpactStreamingOptions");
    expect(typeDeclarationHasOwnJsDoc(streamingDistDeclaration, "ImpactStreamingOptions")).toBe(true);
    expect(streamingDistDeclaration).toContain("@deprecated Streaming ignores this");
    expect(sessionDeclaration).toContain("analyzeImpactStream(options: ImpactStreamingOptions)");
    expectTypeScriptSurfaceCheck(`
import type { ICodeReviewSession } from "../dist/index.js";
import type { ImpactStreamingOptions as RootImpactStreamingOptions } from "../dist/index.js";

const rootRaw: RootImpactStreamingOptions = { provider: "raw", diffText: "" };
const rootLight: RootImpactStreamingOptions = { provider: "raw", diffText: "", streamSummary: "light" };
const rootGit: RootImpactStreamingOptions = { provider: "git", base: "HEAD", head: "WORKTREE" };
const commonImpactOption: RootImpactStreamingOptions = { provider: "raw", diffText: "", severityWeights: { directRef: 10 } };
const compactStreaming: RootImpactStreamingOptions = { provider: "raw", diffText: "", compact: true };
const sessionStreaming: Parameters<ICodeReviewSession["analyzeImpactStream"]>[0] = {
  provider: "raw",
  diffText: "",
  streamSummary: "light",
};

// @ts-expect-error streamSummary only accepts the documented modes.
const misspelledSummary: RootImpactStreamingOptions = { provider: "raw", diffText: "", streamSummary: "lite" };
// @ts-expect-error diagnostics are internal analysis state, not caller options.
const diagnosticsStreaming: RootImpactStreamingOptions = { provider: "raw", diffText: "", diagnostics: undefined };
// @ts-expect-error fileLevelFallbackPaths are internal analysis state, not caller options.
const fallbackPathsStreaming: RootImpactStreamingOptions = { provider: "raw", diffText: "", fileLevelFallbackPaths: [] };
// @ts-expect-error onImpactItem is owned by analyzeImpactStreaming for progressive chunks.
const onImpactItemStreaming: RootImpactStreamingOptions = { provider: "raw", diffText: "", onImpactItem: () => {} };

void rootRaw;
void rootLight;
void rootGit;
void commonImpactOption;
void compactStreaming;
void sessionStreaming;
void misspelledSummary;
void diagnosticsStreaming;
void fallbackPathsStreaming;
void onImpactItemStreaming;
`);
  });

  it("keeps streaming and batch impact format discriminators distinct in docs", () => {
    const readme = readText("README.md");
    const libraryApi = readText("docs/library-api.md");
    const agentWorkflows = readText("docs/agent-workflows.md");
    const streamingSource = readText("src/impact/streaming.ts");

    expect(readme).toContain("ranked top impacts");
    expect(libraryApi).toContain('batch impact wrappers include `schemaVersion` and `format: "full" | "compact"`');
    expect(libraryApi).toContain("ranked top impacts");
    expect(libraryApi).toContain('streaming `complete.report` uses `format: "stream-summary"`');
    expect(agentWorkflows).toContain('Batch impact wrappers return `schemaVersion` and `format: "full" | "compact"`');
    expect(agentWorkflows).toContain("ranked top impacts");
    expect(agentWorkflows).toContain('streaming `complete.report` uses `format: "stream-summary"`');
    expect(streamingSource).toContain("top impacts");
  });

  it("keeps repeated impact ignore globs explicit in CLI docs", () => {
    const cliDoc = readText("docs/cli.md");

    expect(cliDoc).toContain(
      'codegraph impact --base main --head feature --ignore-glob "**/package-lock.json" --ignore-glob "**/dist/**"',
    );
    expect(cliDoc).not.toContain(
      'codegraph impact --base main --head feature --ignore-glob "**/package-lock.json" "**/dist/**"',
    );
  });

  it("keeps intentionally repeated CLI examples synchronized across docs", () => {
    const docs = new Map([
      ["README.md", readText("README.md")],
      ["docs/cli.md", readText("docs/cli.md")],
      ["docs/agent-workflows.md", readText("docs/agent-workflows.md")],
      ["codegraph-skill/codegraph/SKILL.md", readText("codegraph-skill/codegraph/SKILL.md")],
    ]);
    const sharedExamples = [
      {
        command: "codegraph orient --root . --budget small --pretty",
        files: ["README.md", "docs/cli.md", "docs/agent-workflows.md", "codegraph-skill/codegraph/SKILL.md"],
      },
      {
        command: "codegraph review --base HEAD --head WORKTREE --summary",
        files: ["README.md", "docs/cli.md", "docs/agent-workflows.md", "codegraph-skill/codegraph/SKILL.md"],
      },
      {
        command:
          "codegraph drift ./src --base origin/main --head HEAD --pretty --graph-edges summary --public-api removals",
        files: ["README.md", "docs/cli.md", "docs/agent-workflows.md", "codegraph-skill/codegraph/SKILL.md"],
      },
    ];

    for (const example of sharedExamples) {
      for (const filePath of example.files) {
        expect(docs.get(filePath), `${filePath} should include ${example.command}`).toContain(example.command);
      }
    }

    expect(docs.get("README.md")).not.toContain("codegraph impact --provider git --base HEAD --head WORKTREE");
    expect(docs.get("codegraph-skill/codegraph/SKILL.md")).not.toContain(
      "codegraph impact --provider git --base HEAD --head WORKTREE",
    );
  });

  it("keeps installation guidance aligned with native-first reduced-mode behavior", () => {
    const readme = readText("README.md");
    const installationDoc = readText("docs/installation.md");
    const skillDoc = readText("codegraph-skill/codegraph/SKILL.md");

    expect(readme).toContain("@lzehrung:registry");
    expect(readme).not.toContain("opt-in JS fallback path");
    expect(installationDoc).toContain("@lzehrung:registry");
    expect(installationDoc).toContain("reduced graph-only and regex recovery mode");
    expect(installationDoc).not.toContain("--legacy-peer-deps");
    expect(skillDoc).not.toContain("@lzehrung/codegraph-js-fallback");
    expect(skillDoc).not.toContain("compatibility shim");
  });

  it("keeps the release workflow publishing only the root and native packages", () => {
    const workflow = readText(".github/workflows/release.yml");
    const runCommands = workflowRunCommands(workflow);
    const buildCommand = runCommands.find((command) => command.includes("cli.js build --platform"));
    const artifactsCommand = runCommands.find((command) => command.includes("cli.js artifacts"));
    const installIndex = workflow.indexOf("npm ci --ignore-scripts");
    const publishInstallIndex = workflow.lastIndexOf("npm ci --ignore-scripts");
    const publishRebuildIndex = workflow.lastIndexOf("npm rebuild");
    const patchIndex = workflow.indexOf("patch-tree-sitter-node24");
    const rerunGuardIndex = workflow.indexOf("Refuse reruns on an already-tagged release commit");
    const versionIndex = workflow.indexOf("node ./scripts/set-native-package-version.mjs");
    const createDirsIndex = workflow.indexOf("npm run native:create-npm-dirs");
    const cleanupArtifactsIndex = workflow.indexOf("rm -rf native-artifacts");
    const publishIndex = workflow.indexOf(
      "npm run publish:${{ inputs.release_type }} -- --package root --package native",
    );
    const releaseIndex = workflow.indexOf("Create or update GitHub Release");
    const nativePackage = readJson("packages/codegraph-native/package.json");
    const targets =
      nativePackage.napi &&
      typeof nativePackage.napi === "object" &&
      "targets" in nativePackage.napi &&
      Array.isArray(nativePackage.napi.targets)
        ? nativePackage.napi.targets
        : [];

    for (const target of targets) {
      expect(workflow).toContain(String(target));
    }
    expect(buildCommand).toBeDefined();
    expect(artifactsCommand).toBeDefined();
    expect(workflow).toContain("macos-15-intel");
    expect(commandOptionValue(buildCommand ?? "", "--output-dir")).toBe("./artifacts");
    expect(commandOptionValue(artifactsCommand ?? "", "--output-dir")).toBe("./artifacts");
    expect(commandOptionValue(artifactsCommand ?? "", "--npm-dir")).toBe("./npm");
    expect(workflow).toContain("plan-release:");
    expect(workflow).toContain("Configure Linux musl linker search path");
    expect(workflow).toContain("musl-tools libgcc-s1");
    expect(workflow).toContain('test -e "/lib/${host_triplet}/libgcc_s.so.1"');
    expect(workflow).toContain("LIBRARY_PATH=/usr/lib/${host_triplet}:/lib/${host_triplet}:${LIBRARY_PATH:-}");
    expect(workflow).toContain("RUSTFLAGS=-C link-arg=-L/usr/lib/${host_triplet}");
    expect(workflow).toContain('bumpVersion(rootPackage.version, "${{ inputs.release_type }}")');
    expect(workflow).toContain('bumpVersion(nativePackage.version, "${{ inputs.release_type }}")');
    expect(workflow).toContain("needs.plan-release.outputs.native_version");
    expect(workflow).toContain('hasTagForPackageVersion("@lzehrung/codegraph", version, tagNames)');
    expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.PACKAGE_PUBLISH_TOKEN || secrets.GITHUB_TOKEN }}");
    expect(workflow).toContain('root_tag="v$root_version"');
    expect(workflow).toContain('root_package_tag="@lzehrung/codegraph@$root_version"');
    expect(workflow).toContain('native_tag="@lzehrung/codegraph-native@$native_version"');
    expect(workflow).toContain(
      'gh release create "$root_tag" "$tarball" --title "$root_tag" --notes-file "$release_notes"',
    );
    expect(workflow).toContain('gh release edit "$root_tag" --title "$root_tag" --notes-file "$release_notes"');
    expect(installIndex).toBeGreaterThan(-1);
    expect(rerunGuardIndex).toBeGreaterThan(versionIndex);
    expect(publishInstallIndex).toBeGreaterThan(rerunGuardIndex);
    expect(publishRebuildIndex).toBe(-1);
    expect(patchIndex).toBe(-1);
    expect(versionIndex).toBeGreaterThan(installIndex);
    expect(createDirsIndex).toBeGreaterThan(versionIndex);
    expect(cleanupArtifactsIndex).toBeGreaterThan(createDirsIndex);
    expect(workflow).not.toContain("native:stage-local");
    expect(publishIndex).toBeGreaterThan(cleanupArtifactsIndex);
    expect(releaseIndex).toBeGreaterThan(publishIndex);
    expect(workflow).toContain("npm run publish:${{ inputs.release_type }} -- --package root --package native");
    expect(workflow).not.toContain("js-fallback");
    expect(workflow).not.toContain("@lzehrung/codegraph-js-fallback");
  });

  it("keeps GitHub-owned actions off deprecated Node 20 action majors", () => {
    const workflowPaths = [".github/workflows/on-demand-ci.yml", ".github/workflows/release.yml"];

    for (const workflowPath of workflowPaths) {
      const workflow = readText(workflowPath);
      expect(workflow).not.toContain("actions/checkout@v4");
      expect(workflow).not.toContain("actions/setup-node@v4");
      expect(workflow).not.toContain("actions/upload-artifact@v4");
      expect(workflow).not.toContain("actions/download-artifact@v4");
    }
  });

  it("keeps public-facing docs ASCII-clean", () => {
    const docs = [
      "README.md",
      "AGENTS.md",
      "PUBLISHING.md",
      "docs/installation.md",
      "docs/cli.md",
      "docs/library-api.md",
      "docs/agent-workflows.md",
      "docs/how-it-works.md",
      "docs/search.md",
      "codegraph-skill/codegraph/SKILL.md",
    ];

    for (const relativePath of docs) {
      const hasNonAscii = [...readText(relativePath)].some((character) => character.charCodeAt(0) > 0x7f);
      expect(hasNonAscii).toBe(false);
    }
  });
});
