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

function readText(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function readStringRecord(value: unknown): Record<string, string> {
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
  it("keeps the declared ISC license text and package metadata aligned", () => {
    const licensePath = path.resolve(process.cwd(), "LICENSE");
    const rootPackage = readJson("package.json");
    const nativePackage = readJson("packages/codegraph-native/package.json");
    const fallbackPackage = readJson("packages/codegraph-js-fallback/package.json");
    const opencodePluginPackage = readJson(
      "packages/codegraph-opencode-plugin/package.json",
    );

    expect(fs.existsSync(licensePath)).toBe(true);
    expect(fs.readFileSync(licensePath, "utf8")).toContain("ISC License");
    expect(rootPackage.license).toBe("ISC");
    expect(nativePackage.license).toBeUndefined();
    expect(fallbackPackage.license).toBeUndefined();
    expect(opencodePluginPackage.license).toBeUndefined();
  });

  it("keeps the native package optional at the root package boundary", () => {
    const rootPackage = readJson("package.json");
    const nativePackage = readJson("packages/codegraph-native/package.json");
    const dependencies = readStringRecord(rootPackage.dependencies);
    const optionalDependencies = readStringRecord(
      rootPackage.optionalDependencies,
    );

    expect(dependencies["@lzehrung/codegraph-native"]).toBeUndefined();
    expect(optionalDependencies["@lzehrung/codegraph-native"]).toBe(
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      `^${nativePackage.version}`,
    );
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

  it("keeps the published CLI bin path normalized for npm", () => {
    const rootPackage = readJson("package.json");
    const bin = readStringRecord(rootPackage.bin);

    expect(bin.codegraph).toBe("dist/cli.js");
  });

  it("requires Node 20 or newer in package metadata", () => {
    const rootPackage = readJson("package.json");
    const engines = readStringRecord(rootPackage.engines);

    expect(engines.node).toBe(">=20");
  });

  it("keeps the root package description aligned with the multi-language surface", () => {
    const rootPackage = readJson("package.json");
    const description =
      typeof rootPackage.description === "string" ? rootPackage.description : "";
    const normalizedDescription = description.toLowerCase();

    expect(normalizedDescription).toContain("multi-language");
    expect(normalizedDescription).not.toContain("js/ts/python monorepos");
  });

  it("keeps lint as a non-mutating verification gate and exposes lint:fix separately", () => {
    const rootPackage = readJson("package.json");
    const scripts = readStringRecord(rootPackage.scripts);

    expect(scripts.lint).toBe("npx eslint ./src");
    expect(scripts["lint:fix"]).toBe("npx eslint ./src --fix");
  });

  it("keeps all publishable workspaces under the packages directory", () => {
    const rootPackage = readJson("package.json");
    const workspaces =
      Array.isArray(rootPackage.workspaces) &&
      rootPackage.workspaces.every((entry) => typeof entry === "string")
        ? rootPackage.workspaces
        : [];

    expect(workspaces).toEqual(["packages/*"]);
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
    const fallbackPackage = readJson("packages/codegraph-js-fallback/package.json");
    const dependencies = readStringRecord(fallbackPackage.dependencies);

    expect(dependencies["tree-sitter"]).toBeDefined();
    expect(dependencies["tree-sitter-php"]).toBeDefined();
    expect(dependencies["tree-sitter-typescript"]).toBeDefined();
    expect(dependencies["tree-sitter-vue"]).toBeDefined();
  });

  it("does not publish local file dependencies in the JS fallback package", () => {
    const fallbackPackage = readJson("packages/codegraph-js-fallback/package.json");
    const dependencies = readStringRecord(fallbackPackage.dependencies);

    expect(dependencies["@lzehrung/codegraph"]).toBeUndefined();
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
      "codegraph-skill/codegraph/SKILL.md",
    ];

    for (const relativePath of docs) {
      const hasNonAscii = [...readText(relativePath)].some(
        (character) => character.charCodeAt(0) > 0x7f,
      );
      expect(hasNonAscii).toBe(false);
    }
  });
});
