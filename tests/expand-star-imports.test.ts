import { describe, expect, it } from "vitest";
import { expandStarImports, unexpandedModule } from "../src/indexer/expand-star-imports.js";
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

function moduleMap(...modules: ModuleIndex[]): Map<string, ModuleIndex> {
  return new Map(modules.map((mod) => [fileIdentityKey(mod.file), mod]));
}

/** The consumer `expandStarImports` leaves in the map, which replaces a star importer with an expanded copy. */
function expandedConsumer(lib: ModuleIndex, consumer: ModuleIndex): ModuleIndex | undefined {
  const modules = moduleMap(lib, consumer);
  expandStarImports(modules);
  return modules.get(fileIdentityKey(consumer.file));
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

    expect(namedLocals(expandedConsumer(lib, consumer))).toEqual(["bar", "foo"]);
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

    expect(namedLocals(expandedConsumer(lib, consumer))).toEqual(["visible"]);
  });

  it("uses exportedAs when a local export is renamed", () => {
    const libFile = normalizePath("/tmp/cg-star-renamed.ts");
    const consumerFile = normalizePath("/tmp/cg-star-renamed-consumer.ts");
    const lib: ModuleIndex = {
      file: libFile,
      exports: [{ type: "local", exportedAs: "bar", target: symbol(libFile, "foo") }],
      imports: [],
      locals: [symbol(libFile, "foo")],
    };
    const consumer: ModuleIndex = {
      file: consumerFile,
      exports: [],
      imports: [{ kind: "star", from: "./lib", resolved: libFile }],
      locals: [],
    };

    const named = (expandedConsumer(lib, consumer)?.imports ?? []).filter(
      (binding): binding is typeof binding & { kind: "named"; local: string; imported: string } =>
        binding.kind === "named",
    );
    expect(named).toEqual([expect.objectContaining({ kind: "named", local: "bar", imported: "bar" })]);
  });

  it("expands only names present as local exports when the target lists any", () => {
    const libFile = normalizePath("/tmp/cg-star-visibility.ts");
    const consumerFile = normalizePath("/tmp/cg-star-visibility-consumer.ts");
    const visible = symbol(libFile, "visible");
    const hidden = symbol(libFile, "hidden");
    const lib: ModuleIndex = {
      file: libFile,
      exports: [{ type: "local", exportedAs: "visible", target: visible }],
      imports: [],
      locals: [visible, hidden],
    };
    const consumer: ModuleIndex = {
      file: consumerFile,
      exports: [],
      imports: [{ kind: "star", from: "./lib", resolved: libFile }],
      locals: [],
    };

    const expanded = expandedConsumer(lib, consumer);
    expect(namedLocals(expanded)).toEqual(["visible"]);
    expect(namedLocals(expanded)).not.toContain("hidden");
  });

  it("expands an earlier copy again from its source, without names the target no longer exports", () => {
    const libFile = normalizePath("/tmp/cg-star-again.ts");
    const consumerFile = normalizePath("/tmp/cg-star-again-consumer.ts");
    const lib: ModuleIndex = {
      file: libFile,
      exports: [
        { type: "local", exportedAs: "foo", target: symbol(libFile, "foo") },
        { type: "local", exportedAs: "bar", target: symbol(libFile, "bar") },
      ],
      imports: [],
      locals: [symbol(libFile, "foo"), symbol(libFile, "bar")],
    };
    const consumer: ModuleIndex = {
      file: consumerFile,
      exports: [],
      imports: [{ kind: "star", from: "./lib", resolved: libFile }],
      locals: [],
    };
    const modules = moduleMap(lib, consumer);
    expandStarImports(modules);
    const first = modules.get(fileIdentityKey(consumerFile));
    expect(namedLocals(first)).toEqual(["bar", "foo"]);
    expect(consumer.imports).toHaveLength(1);
    expect(first && unexpandedModule(first)).toBe(consumer);

    const editedLib: ModuleIndex = {
      ...lib,
      exports: [
        { type: "local", exportedAs: "baz", target: symbol(libFile, "baz") },
        { type: "local", exportedAs: "bar", target: symbol(libFile, "bar") },
      ],
      locals: [symbol(libFile, "baz"), symbol(libFile, "bar")],
    };
    modules.set(fileIdentityKey(libFile), editedLib);
    expandStarImports(modules);
    const second = modules.get(fileIdentityKey(consumerFile));
    expect(second?.imports).toEqual(
      expandedConsumer(editedLib, { ...consumer, imports: [...consumer.imports] })?.imports,
    );
    expect(second?.imports.map((binding) => (binding.kind === "named" ? binding.local : binding.kind))).toEqual([
      "star",
      "baz",
      "bar",
    ]);

    // Names that stay the same keep the copy, so a cache keyed by the indexed module keeps its entry.
    expandStarImports(modules);
    expect(modules.get(fileIdentityKey(consumerFile))).toBe(second);
  });

  it("leaves a star importer as extracted once its target exports nothing", () => {
    const libFile = normalizePath("/tmp/cg-star-emptied.ts");
    const consumerFile = normalizePath("/tmp/cg-star-emptied-consumer.ts");
    const lib: ModuleIndex = {
      file: libFile,
      exports: [{ type: "local", exportedAs: "foo", target: symbol(libFile, "foo") }],
      imports: [],
      locals: [symbol(libFile, "foo")],
    };
    const consumer: ModuleIndex = {
      file: consumerFile,
      exports: [],
      imports: [{ kind: "star", from: "./lib", resolved: libFile }],
      locals: [],
    };
    const modules = moduleMap(lib, consumer);
    expandStarImports(modules);
    expect(modules.get(fileIdentityKey(consumerFile))).not.toBe(consumer);

    modules.set(fileIdentityKey(libFile), { ...lib, exports: [], locals: [] });
    expandStarImports(modules);
    expect(modules.get(fileIdentityKey(consumerFile))).toBe(consumer);
  });
});
