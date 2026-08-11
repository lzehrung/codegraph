import path from "node:path";
import fsp from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildProjectIndex,
  clearResolutionCaches,
  collectGraph,
  collectImportsForFile,
  parseFile,
} from "../src/index.js";
import { mkTmpDir } from "./helpers/filesystem.js";
import { fileIdentityKey } from "../src/util/paths.js";

describe("Kotlin import resolution regression", () => {
  it("ignores generated trees when resolving package imports from a repo root", async () => {
    const root = await mkTmpDir("cg-kotlin-root-");
    const sourceDir = path.join(root, "src", "demo", "pkg");
    const generatedDir = path.join(root, "build", "generated", "source", "kapt", "main", "demo", "pkg");
    const mainFile = path.join(root, "src", "Main.kt");
    const sourceHelperFile = path.join(sourceDir, "Helper.kt");
    const sourceServiceFile = path.join(sourceDir, "Service.kt");
    const ignoredHelperFile = path.join(generatedDir, "Helper.kt");

    await fsp.mkdir(sourceDir, { recursive: true });
    await fsp.mkdir(generatedDir, { recursive: true });
    await fsp.writeFile(
      sourceHelperFile,
      ["package demo.pkg", "class Helper", "fun helperFunction(): Int = 1"].join("\n"),
      "utf8",
    );
    await fsp.writeFile(
      sourceServiceFile,
      ["package demo.pkg", "class Service", "fun serviceFunction(): Int = helperFunction()"].join("\n"),
      "utf8",
    );
    await fsp.writeFile(
      ignoredHelperFile,
      ["package demo.pkg", "class Helper", "fun helperFunction(): Int = 999"].join("\n"),
      "utf8",
    );

    for (let index = 0; index < 250; index += 1) {
      await fsp.writeFile(
        path.join(generatedDir, `Generated${index}.kt`),
        ["package demo.pkg", `class Generated${index}`, `fun generated${index}(): Int = ${index}`].join("\n"),
        "utf8",
      );
    }

    await fsp.writeFile(
      mainFile,
      [
        "import demo.pkg.Helper",
        "import demo.pkg.helperFunction",
        "import demo.pkg.serviceFunction",
        "",
        "fun main() {",
        "  Helper()",
        "  helperFunction()",
        "  serviceFunction()",
        "}",
      ].join("\n"),
      "utf8",
    );

    clearResolutionCaches();
    const parsed = await parseFile(mainFile);
    const imports = await collectImportsForFile(mainFile, root, {
      source: parsed.source,
      sup: parsed.sup,
      lang: parsed.lang,
      nativeQueries: parsed.nativeQueries,
    });

    const resolvedFiles = imports
      .map((entry) => entry.resolved)
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.replace(/\\/g, "/"));
    const normalizedSourceHelper = sourceHelperFile.replace(/\\/g, "/");
    const normalizedSourceService = sourceServiceFile.replace(/\\/g, "/");
    const normalizedIgnoredHelper = ignoredHelperFile.replace(/\\/g, "/");

    expect(resolvedFiles).toContain(normalizedSourceHelper);
    expect(resolvedFiles).toContain(normalizedSourceService);
    expect(resolvedFiles).not.toContain(normalizedIgnoredHelper);

    const startedAt = performance.now();
    const index = await buildProjectIndex(root, {
      cache: "none",
      logLevel: "silent",
    });
    const elapsedMs = performance.now() - startedAt;

    expect(index.byFile.has(fileIdentityKey(mainFile))).toBe(true);
    expect(index.byFile.has(fileIdentityKey(normalizedSourceHelper))).toBe(true);
    expect(index.byFile.has(fileIdentityKey(normalizedSourceService))).toBe(true);
    expect(index.byFile.has(fileIdentityKey(normalizedIgnoredHelper))).toBe(false);
    expect(elapsedMs).toBeLessThan(10000);
  });

  it("expands Kotlin wildcard package imports to all source package files", async () => {
    const root = await mkTmpDir("cg-kotlin-wildcard-");
    const pkgDir = path.join(root, "src", "demo", "pkg");
    const generatedDir = path.join(root, "build", "generated", "source", "kapt", "main", "demo", "pkg");
    const mainFile = path.join(root, "src", "Main.kt");
    const alphaFile = path.join(pkgDir, "Alpha.kt");
    const betaFile = path.join(pkgDir, "Beta.kt");
    const ignoredFile = path.join(generatedDir, "Generated.kt");

    await fsp.mkdir(pkgDir, { recursive: true });
    await fsp.mkdir(generatedDir, { recursive: true });
    await fsp.writeFile(
      alphaFile,
      ["package demo.pkg", "class Alpha", "fun helperFunction(): Int = 1"].join("\n"),
      "utf8",
    );
    await fsp.writeFile(betaFile, ["package demo.pkg", "typealias Alias = Alpha"].join("\n"), "utf8");
    await fsp.writeFile(ignoredFile, ["package demo.pkg", "class Generated"].join("\n"), "utf8");
    await fsp.writeFile(
      mainFile,
      ["import demo.pkg.*", "", "fun run(): Alias {", "  helperFunction()", "  return Alpha()", "}"].join("\n"),
      "utf8",
    );

    clearResolutionCaches();
    const graph = await collectGraph(root, [
      mainFile.replace(/\\/g, "/"),
      alphaFile.replace(/\\/g, "/"),
      betaFile.replace(/\\/g, "/"),
    ]);

    const fileEdges = graph.edges
      .filter((edge) => edge.from === mainFile.replace(/\\/g, "/"))
      .filter((edge) => edge.to.type === "file")
      .map((edge) => edge.to.path);

    expect(fileEdges).toContain(alphaFile.replace(/\\/g, "/"));
    expect(fileEdges).toContain(betaFile.replace(/\\/g, "/"));
    expect(fileEdges).not.toContain(ignoredFile.replace(/\\/g, "/"));
  });
});
