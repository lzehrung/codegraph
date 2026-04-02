import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readJson(relativePath: string): Record<string, unknown> {
  const absolutePath = path.resolve(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf8")) as Record<
    string,
    unknown
  >;
}

function readStringRecord(
  value: unknown,
): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

describe("package metadata", () => {
  it("keeps the native package optional at the root package boundary", () => {
    const rootPackage = readJson("package.json");
    const dependencies = readStringRecord(rootPackage.dependencies);
    const optionalDependencies = readStringRecord(
      rootPackage.optionalDependencies,
    );

    expect(dependencies["@lzehrung/codegraph-native"]).toBeUndefined();
    expect(optionalDependencies["@lzehrung/codegraph-native"]).toBeDefined();
  });

  it("ships both the packaged skill archive and the raw skill directory", () => {
    const rootPackage = readJson("package.json");
    const files =
      Array.isArray(rootPackage.files) &&
      rootPackage.files.every((entry) => typeof entry === "string")
        ? rootPackage.files
        : [];

    expect(files).toContain("codegraph.skill");
    expect(files).toContain("codegraph-skill");
  });

  it("keeps JS fallback grammars out of the native package", () => {
    const nativePackage = readJson("packages/codegraph-native/package.json");
    const dependencies = readStringRecord(nativePackage.dependencies);
    const optionalDependencies = readStringRecord(
      nativePackage.optionalDependencies,
    );
    const exportsField =
      nativePackage.exports && typeof nativePackage.exports === "object"
        ? nativePackage.exports
        : {};

    expect(Object.keys(dependencies)).toEqual([]);
    expect(Object.keys(optionalDependencies)).toEqual([]);
    expect(exportsField).not.toHaveProperty("./js-fallback");
  });

  it("keeps JS fallback grammars in the separate opt-in package", () => {
    const fallbackPackage = readJson(
      "optional-packages/codegraph-js-fallback/package.json",
    );
    const dependencies = readStringRecord(fallbackPackage.dependencies);

    expect(dependencies["tree-sitter"]).toBeDefined();
    expect(dependencies["tree-sitter-typescript"]).toBeDefined();
    expect(dependencies["tree-sitter-vue"]).toBeDefined();
  });
});
