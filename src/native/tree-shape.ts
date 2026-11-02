import type { NativeSyntaxTree } from "./contracts.js";

/**
 * Version cited when the installed binary does not export `extractLanguage`.
 *
 * Not a floor for the projected syntax tree. The `isMissing` column is newer than
 * this, so a shape mismatch must not advertise it as sufficient.
 */
export const REQUIRED_NATIVE_EXTRACTION_VERSION = "1.10.0";

/**
 * Cheap structural probe: only the columnar shape carries typed-array columns.
 * Checks `kindIds` is specifically a `Uint32Array` rather than any ArrayBuffer view --
 * `ArrayBuffer.isView` also accepts a `DataView`, which does not support indexed
 * access the way the columns do -- and that `nodeCount` is present, since the legacy
 * shape has no such field. `isMissing` must be a `Uint8Array` of that length; columnar
 * binaries from before that column are the same mismatch.
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
    "The @lzehrung/codegraph-native version that ships with your Codegraph release is required; " +
    "the installed native binary returns the legacy syntax-tree shape without required projected syntax-tree columns. Reinstall the native package."
  );
}

/**
 * A binary from before query sets takes the query text on every extraction call. This build registers the queries once
 * and passes an id, so it cannot call such a binary.
 */
export function nativeQuerySetsUnavailableMessage(): string {
  return (
    "The @lzehrung/codegraph-native version that ships with your Codegraph release is required; " +
    "the installed native binary does not provide registerQuerySet and takes query text on every call. Reinstall the native package."
  );
}
