import type { ModuleIndex } from "../../src/index.js";
import type { NativeSyntaxTree } from "../../src/native/contracts.js";
import { normalizeTestPath } from "./filesystem.js";

/**
 * Minimal columnar projected tree: a single root node with no children. Fakes that
 * only need "a tree the reader accepts" should use this rather than hand-rolling the
 * column set, so a shape change updates one place.
 */
export function createStubNativeSyntaxTree(kind: string = "program"): NativeSyntaxTree {
  return {
    rootId: 0,
    nodeCount: 1,
    kinds: [kind],
    fieldNames: [""],
    kindIds: Uint32Array.of(0),
    parentIds: Int32Array.of(-1),
    named: Uint8Array.of(1),
    startRow: Uint32Array.of(0),
    startColumn: Uint32Array.of(0),
    startIndex: Uint32Array.of(0),
    endRow: Uint32Array.of(0),
    endColumn: Uint32Array.of(0),
    endIndex: Uint32Array.of(0),
    childOffsets: Uint32Array.of(0, 0),
    childIds: new Uint32Array(0),
    childFieldNameIds: new Uint32Array(0),
    namedChildOffsets: Uint32Array.of(0, 0),
    namedChildIds: new Uint32Array(0),
  };
}

export function simplifyNativeTestImports(imports: ModuleIndex["imports"]): unknown[] {
  return imports.map((entry) => ({
    ...entry,
    resolved: typeof entry.resolved === "string" ? normalizeTestPath(entry.resolved) : entry.resolved,
  }));
}

export function simplifyNativeTestModuleIndex(index: ModuleIndex): unknown {
  return {
    imports: simplifyNativeTestImports(index.imports),
    locals: index.locals.map((local) => ({
      localName: local.localName,
      kind: local.kind,
    })),
    exports: index.exports.map((entry) => {
      if (entry.type === "local") {
        return {
          type: entry.type,
          exportedAs: entry.exportedAs,
          localName: entry.target.localName,
          kind: entry.target.kind,
        };
      }
      if (entry.type === "reexport") {
        return {
          type: entry.type,
          exportedAs: entry.exportedAs,
          fromModule: normalizeTestPath(entry.fromModule),
          sourceSpecifier: entry.sourceSpecifier,
          typeOnly: entry.typeOnly ?? false,
        };
      }
      if (entry.type === "namespaceReexport") {
        return {
          type: entry.type,
          exportedAs: entry.exportedAs,
          fromModule: normalizeTestPath(entry.fromModule),
          typeOnly: entry.typeOnly ?? false,
        };
      }
      return {
        type: entry.type,
        fromModule: normalizeTestPath(entry.fromModule),
        sourceSpecifier: entry.sourceSpecifier,
        typeOnly: entry.typeOnly ?? false,
      };
    }),
  };
}
