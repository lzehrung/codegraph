import { expect, vi } from "vitest";

import type { ModuleIndex } from "../../src/index.js";
import { __resetNativeTreeSitterBindingForTests } from "../../src/native/treeSitterNative.js";
import { normalizeTestPath } from "./filesystem.js";

export type NativeRuntimeMode = "native" | "reduced";

export type NativeOwnershipFallbackSpies = {
  parseSpy: ReturnType<typeof vi.fn>;
  querySpy?: ReturnType<typeof vi.fn>;
};

export function createUnavailableJsFallbackSpies(grammarDescription: string): Required<NativeOwnershipFallbackSpies> {
  const parseSpy = vi.fn(() => {
    throw new Error(
      `JS Tree-sitter fallback is unavailable for ${grammarDescription} loading. Install @lzehrung/codegraph-js-fallback to enable it`,
    );
  });
  const querySpy = vi.fn(() => {
    throw new Error(
      "JS Tree-sitter fallback is unavailable for JS query execution. Install @lzehrung/codegraph-js-fallback to enable it",
    );
  });
  return { parseSpy, querySpy };
}

export function expectJsFallbackUnusedForNativeOwnership(spies: NativeOwnershipFallbackSpies): void {
  expect(spies.parseSpy).not.toHaveBeenCalled();
  if (spies.querySpy) {
    expect(spies.querySpy).not.toHaveBeenCalled();
  }
}

function applyNativeRuntimeMode(mode: NativeRuntimeMode): void {
  if (mode === "reduced") {
    process.env.CODEGRAPH_DISABLE_NATIVE = "1";
  } else {
    delete process.env.CODEGRAPH_DISABLE_NATIVE;
  }
  __resetNativeTreeSitterBindingForTests();
}

function restoreNativeRuntimeMode(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env.CODEGRAPH_DISABLE_NATIVE;
  } else {
    process.env.CODEGRAPH_DISABLE_NATIVE = previous;
  }
  __resetNativeTreeSitterBindingForTests();
}

export function withNativeRuntimeMode<T>(mode: NativeRuntimeMode, run: () => T): T {
  const previous = process.env.CODEGRAPH_DISABLE_NATIVE;
  applyNativeRuntimeMode(mode);
  try {
    return run();
  } finally {
    restoreNativeRuntimeMode(previous);
  }
}

export async function withNativeRuntimeModeAsync<T>(mode: NativeRuntimeMode, run: () => Promise<T>): Promise<T> {
  const previous = process.env.CODEGRAPH_DISABLE_NATIVE;
  applyNativeRuntimeMode(mode);
  try {
    return await run();
  } finally {
    restoreNativeRuntimeMode(previous);
  }
}

export function resetNativeRuntimeModeForTests(): void {
  delete process.env.CODEGRAPH_DISABLE_NATIVE;
  __resetNativeTreeSitterBindingForTests();
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
