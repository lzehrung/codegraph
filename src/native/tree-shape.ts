import type { NativeSyntaxTree } from "./contracts.js";

/**
 * Minimum native package version that returns the columnar projected syntax tree.
 *
 * Older binaries still export `extractLanguage` and `parseSyntaxTree`, so capability
 * detection cannot distinguish them. They return the pre-columnar shape (an object
 * with a `nodes` array of one plain object per AST node, not the current typed-array
 * columns), which this build would otherwise read as a tree with no columns instead
 * of failing.
 */
export const REQUIRED_NATIVE_EXTRACTION_VERSION = "1.10.0";

/**
 * Cheap structural probe: only the columnar shape carries typed-array columns.
 * Checks `kindIds` is specifically a `Uint32Array` rather than any ArrayBuffer view --
 * `ArrayBuffer.isView` also accepts a `DataView`, which does not support indexed
 * access the way the columns do -- and that `nodeCount` is present, since the legacy
 * shape has no such field.
 */
export function isColumnarSyntaxTree(tree: unknown): tree is NativeSyntaxTree {
  if (typeof tree !== "object" || tree === null) return false;
  const candidate = tree as NativeSyntaxTree;
  return typeof candidate.nodeCount === "number" && candidate.kindIds instanceof Uint32Array;
}

export function nativeShapeMismatchMessage(): string {
  return (
    `@lzehrung/codegraph-native >= ${REQUIRED_NATIVE_EXTRACTION_VERSION} is required; ` +
    "the installed native binary returns the legacy syntax-tree shape. Reinstall the native package."
  );
}
