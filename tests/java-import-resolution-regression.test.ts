import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildProjectIndex,
  clearResolutionCaches,
  collectImportsForFile,
  parseFile,
} from "../src/index.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

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
      [
        "package pkg;",
        "public class PackageTypes {",
        "  public static final int VALUE = 1;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await fsp.writeFile(
      ignoredPackageFile,
      [
        "package pkg;",
        "public class PackageTypes {",
        "  public static final int VALUE = 999;",
        "}",
      ].join("\n"),
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

    expect(index.byFile.has(mainFile.replace(/\\/g, "/"))).toBe(true);
    expect(index.byFile.has(normalizedSourcePackage)).toBe(true);
    expect(index.byFile.has(normalizedIgnoredPackage)).toBe(false);
    expect(elapsedMs).toBeLessThan(10000);
  });
});
