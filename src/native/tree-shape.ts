import type { NativeSyntaxTree } from "./contracts.js";

/**
 * Minimum native package version that returns the projected syntax tree shape used here.
 *
 * Older binaries may still export the same functions while returning either a legacy
 * node list or columnar trees without the missing-node flags needed for parse coverage.
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
  return (
    typeof candidate.nodeCount === "number" &&
    candidate.kindIds instanceof Uint32Array &&
    candidate.isMissing instanceof Uint8Array &&
    candidate.isMissing.length === candidate.nodeCount
  );
}

export function nativeShapeMismatchMessage(): string {
  return (
    `@lzehrung/codegraph-native >= ${REQUIRED_NATIVE_EXTRACTION_VERSION} is required; ` +
    "the installed native binary returns the legacy syntax-tree shape without required projected syntax-tree columns. Reinstall the native package."
  );
}
