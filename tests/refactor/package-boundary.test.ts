import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const packageRoot = path.join(repoRoot, "packages/codegraph-refactor");

describe("refactor package boundary", () => {
  test("publishes refactor operations as an opt-in workspace package", () => {
    const workspacePackage = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as {
      name?: string;
      type?: string;
      main?: string;
      types?: string;
      exports?: { "."?: { import?: string; types?: string } };
      files?: string[];
      peerDependencies?: Record<string, string>;
    };
    const entrypoint = fs.readFileSync(path.join(packageRoot, "src/index.ts"), "utf8");

    expect(workspacePackage.name).toBe("@lzehrung/codegraph-refactor");
    expect(workspacePackage.type).toBe("module");
    expect(workspacePackage.main).toBe("./dist/index.js");
    expect(workspacePackage.types).toBe("./dist/index.d.ts");
    expect(workspacePackage.exports?.["."]?.import).toBe("./dist/index.js");
    expect(workspacePackage.exports?.["."]?.types).toBe("./dist/index.d.ts");
    expect(workspacePackage.files).toEqual(["dist"]);
    expect(workspacePackage.peerDependencies?.["@lzehrung/codegraph"]).toBeDefined();

    expect(entrypoint).toContain("applyEdits");
    expect(entrypoint).toContain("renameSymbol");
    expect(entrypoint).toContain("moveSymbol");
    expect(entrypoint).toContain("extractFunction");
    expect(entrypoint).toContain("getSymbolRange");
  });

  test("keeps edit operation implementations in the refactor workspace", () => {
    const workspaceSources = [
      "applyEdits.ts",
      "extract.ts",
      "identifier.ts",
      "move.ts",
      "rename.ts",
      "types.ts",
    ];
    for (const sourceFile of workspaceSources) {
      expect(fs.existsSync(path.join(packageRoot, "src", sourceFile))).toBe(true);
    }

    const coreImplementationFiles = [
      "applyEdits.ts",
      "extract.ts",
      "identifier.ts",
      "move.ts",
      "rename.ts",
    ];
    for (const sourceFile of coreImplementationFiles) {
      expect(fs.existsSync(path.join(repoRoot, "src/refactor", sourceFile))).toBe(false);
    }

    const entrypoint = fs.readFileSync(path.join(packageRoot, "src/index.ts"), "utf8");
    expect(entrypoint).toContain('from "./applyEdits.js"');
    expect(entrypoint).toContain('from "./rename.js"');
    expect(entrypoint).not.toContain('applyEdits,\n  extractFunction,\n  getSymbolRange,\n  moveSymbol,\n  renameSymbol,\n} from "@lzehrung/codegraph"');
  });
});
