import { describe, expect, it } from "vitest";
import { expandStarImports } from "../src/indexer/expand-star-imports.js";
import { SymbolKind, type ModuleIndex } from "../src/indexer/types.js";
import { fileIdentityKey, normalizePath } from "../src/util/paths.js";

const range = { start: { line: 1, column: 0 }, end: { line: 1, column: 3 } };

function symbol(file: string, localName: string) {
  return { file, localName, kind: SymbolKind.Function, range };
}

function namedLocals(mod: ModuleIndex | undefined): string[] {
  return (mod?.imports ?? [])
    .filter((binding): binding is typeof binding & { kind: "named"; local: string } => binding.kind === "named")
    .map((binding) => binding.local)
    .sort();
}

describe("expandStarImports", () => {
  it("expands local export targets without a second pass over exports", () => {
    const libFile = normalizePath("/tmp/cg-star-exports.ts");
    const consumerFile = normalizePath("/tmp/cg-star-exports-consumer.ts");
    const lib: ModuleIndex = {
      file: libFile,
      exports: [
        { type: "exportStar", fromModule: "/tmp/other.ts", sourceSpecifier: "./other" },
        { type: "local", exportedAs: "foo", target: symbol(libFile, "foo") },
        { type: "local", exportedAs: "bar", target: symbol(libFile, "bar") },
      ],
      imports: [],
      locals: [symbol(libFile, "foo"), symbol(libFile, "bar"), symbol(libFile, "hidden")],
    };
    const consumer: ModuleIndex = {
      file: consumerFile,
      exports: [],
      imports: [{ kind: "star", from: "./lib", resolved: libFile }],
      locals: [],
    };

    expandStarImports(
      new Map([
        [fileIdentityKey(libFile), lib],
        [fileIdentityKey(consumerFile), consumer],
      ]),
    );

    expect(namedLocals(consumer)).toEqual(["bar", "foo"]);
  });

  it("falls back to non-private locals when the target has no local exports", () => {
    const libFile = normalizePath("/tmp/cg-star-locals.ts");
    const consumerFile = normalizePath("/tmp/cg-star-locals-consumer.ts");
    const lib: ModuleIndex = {
      file: libFile,
      exports: [{ type: "exportStar", fromModule: "/tmp/other.ts", sourceSpecifier: "./other" }],
      imports: [],
      locals: [symbol(libFile, "visible"), symbol(libFile, "_private")],
    };
    const consumer: ModuleIndex = {
      file: consumerFile,
      exports: [],
      imports: [{ kind: "star", from: "./lib", resolved: libFile }],
      locals: [],
    };

    expandStarImports(
      new Map([
        [fileIdentityKey(libFile), lib],
        [fileIdentityKey(consumerFile), consumer],
      ]),
    );

    expect(namedLocals(consumer)).toEqual(["visible"]);
  });
});
