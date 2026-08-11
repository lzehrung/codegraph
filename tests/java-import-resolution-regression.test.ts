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

describe("Java import resolution regression", () => {
  it("ignores target trees when resolving imports from a repo root", async () => {
    const root = await mkTmpDir("cg-java-root-");
    const sourceDir = path.join(root, "src", "pkg");
    const targetDir = path.join(root, "target", "generated-sources", "pkg");
    const mainFile = path.join(root, "src", "Main.java");
    const sourcePackageFile = path.join(sourceDir, "PackageTypes.java");
    const ignoredPackageFile = path.join(targetDir, "PackageTypes.java");

    await fsp.mkdir(sourceDir, { recursive: true });
    await fsp.mkdir(targetDir, { recursive: true });
    await fsp.writeFile(
      sourcePackageFile,
      ["package pkg;", "public class PackageTypes {", "  public static final int VALUE = 1;", "}"].join("\n"),
      "utf8",
    );
    await fsp.writeFile(
      ignoredPackageFile,
      ["package pkg;", "public class PackageTypes {", "  public static final int VALUE = 999;", "}"].join("\n"),
      "utf8",
    );

    for (let index = 0; index < 250; index += 1) {
      await fsp.writeFile(
        path.join(targetDir, `Generated${index}.java`),
        [
          "package pkg;",
          `public class Generated${index} {`,
          `  public static final int VALUE_${index} = ${index};`,
          "}",
        ].join("\n"),
        "utf8",
      );
    }

    await fsp.writeFile(
      mainFile,
      [
        "import pkg.PackageTypes;",
        "import pkg.*;",
        "import static pkg.PackageTypes.VALUE;",
        "public class Main {",
        "  public int run() {",
        "    return PackageTypes.VALUE + VALUE;",
        "  }",
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
    const normalizedSourcePackage = sourcePackageFile.replace(/\\/g, "/");
    const normalizedIgnoredPackage = ignoredPackageFile.replace(/\\/g, "/");

    expect(resolvedFiles).toContain(normalizedSourcePackage);
    expect(resolvedFiles).not.toContain(normalizedIgnoredPackage);

    const startedAt = performance.now();
    const index = await buildProjectIndex(root, {
      cache: "none",
      logLevel: "silent",
    });
    const elapsedMs = performance.now() - startedAt;

    expect(index.byFile.has(fileIdentityKey(mainFile))).toBe(true);
    expect(index.byFile.has(fileIdentityKey(normalizedSourcePackage))).toBe(true);
    expect(index.byFile.has(fileIdentityKey(normalizedIgnoredPackage))).toBe(false);
    expect(elapsedMs).toBeLessThan(10000);
  });

  it("expands Java wildcard package imports to all source package files", async () => {
    const root = await mkTmpDir("cg-java-wildcard-");
    const sourceDir = path.join(root, "src", "pkg");
    const targetDir = path.join(root, "target", "generated-sources", "pkg");
    const mainFile = path.join(root, "src", "Main.java");
    const alphaFile = path.join(sourceDir, "Alpha.java");
    const betaFile = path.join(sourceDir, "Beta.java");
    const ignoredFile = path.join(targetDir, "Generated.java");

    await fsp.mkdir(sourceDir, { recursive: true });
    await fsp.mkdir(targetDir, { recursive: true });
    await fsp.writeFile(
      alphaFile,
      ["package pkg;", "public class Alpha {}", "interface InternalContract {}"].join("\n"),
      "utf8",
    );
    await fsp.writeFile(
      betaFile,
      ["package pkg;", "public interface Beta {", "  void serve();", "}"].join("\n"),
      "utf8",
    );
    await fsp.writeFile(ignoredFile, ["package pkg;", "public class Generated {}"].join("\n"), "utf8");
    await fsp.writeFile(
      mainFile,
      ["import pkg.*;", "public class Main {", "  Alpha alpha = new Alpha();", "  Beta beta = () -> {};", "}"].join(
        "\n",
      ),
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
