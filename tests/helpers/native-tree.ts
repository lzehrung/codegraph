import { loadBinding } from "../../src/native/runtime.js";
import { __setNativeTreeSitterBindingForTests } from "../../src/native/tree-sitter-native.js";

/**
 * Native queries still succeed for sources containing `marker`, but their extraction carries no syntax tree and the
 * standalone parse that would rebuild it fails, so those files index from query results alone, without a tree.
 * Pair it with `__resetNativeTreeSitterBindingForTests()` in `afterEach`.
 */
export function failNativeTreeReconstructionFor(marker: string): void {
  const state = loadBinding();
  if (!state.loaded) throw new Error("Native addon required for the tree reconstruction failure");
  const { extractLanguage, parseSyntaxTree } = state.binding;
  if (!parseSyntaxTree) throw new Error("Native addon does not expose parseSyntaxTree");
  __setNativeTreeSitterBindingForTests({
    ...state,
    binding: {
      ...state.binding,
      extractLanguage: (source, languageId, importsQuery, exportsQuery, localsQuery, importBindingsQuery) => {
        const extraction = {
          ...extractLanguage(source, languageId, importsQuery, exportsQuery, localsQuery, importBindingsQuery),
        };
        if (source.includes(marker)) Reflect.deleteProperty(extraction, "syntaxTree");
        return extraction;
      },
      parseSyntaxTree: (source, languageId) => {
        if (source.includes(marker)) throw new Error("forced tree reconstruction failure");
        return parseSyntaxTree(source, languageId);
      },
    },
  });
}

/**
 * Native extraction and the standalone parse both fail for sources containing `marker`, so those files index with
 * neither query results nor a syntax tree. Pair it with `__resetNativeTreeSitterBindingForTests()` in `afterEach`.
 */
export function failNativeExtractionFor(marker: string): void {
  const state = loadBinding();
  if (!state.loaded) throw new Error("Native addon required for the extraction failure");
  const { extractLanguage, parseSyntaxTree } = state.binding;
  if (!parseSyntaxTree) throw new Error("Native addon does not expose parseSyntaxTree");
  __setNativeTreeSitterBindingForTests({
    ...state,
    binding: {
      ...state.binding,
      extractLanguage: (source, languageId, importsQuery, exportsQuery, localsQuery, importBindingsQuery) => {
        if (source.includes(marker)) throw new Error("forced extraction failure");
        return extractLanguage(source, languageId, importsQuery, exportsQuery, localsQuery, importBindingsQuery);
      },
      parseSyntaxTree: (source, languageId) => {
        if (source.includes(marker)) throw new Error("forced tree parse failure");
        return parseSyntaxTree(source, languageId);
      },
    },
  });
}

/**
 * Native queries fail for sources containing `marker`, while the whole-file extraction a file's script goes through
 * (`extractLanguage`) and the syntax tree it carries keep working. A single-file component's style or template block is
 * read by a separate query over a source masked down to that block, so a marker inside one block fails that block's
 * imports and leaves the script extracted. Pair it with `__resetNativeTreeSitterBindingForTests()` in `afterEach`.
 */
export function failNativeBlockQueriesFor(marker: string): void {
  const state = loadBinding();
  if (!state.loaded) throw new Error("Native addon required for the block query failure");
  const { runLanguageQueries } = state.binding;
  __setNativeTreeSitterBindingForTests({
    ...state,
    binding: {
      ...state.binding,
      runLanguageQueries: (source, languageId, importsQuery, exportsQuery, localsQuery, importBindingsQuery) => {
        if (source.includes(marker)) throw new Error("forced block query failure");
        return runLanguageQueries(source, languageId, importsQuery, exportsQuery, localsQuery, importBindingsQuery);
      },
    },
  });
}
