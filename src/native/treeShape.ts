import type { NativeSyntaxTree } from "./contracts.js";

/**
 * Minimum native package version that returns the columnar projected syntax tree.
 *
 * Older binaries still export `extractLanguage` and `parseSyntaxTree`, so capability
 * detection cannot distinguish them. They return the pre-columnar shape
 * (`{ rootId, nodes: NativeSyntaxNode[] }`), which this build would otherwise read as
 * a tree with no columns instead of failing.
 */
export const REQUIRED_NATIVE_EXTRACTION_VERSION = "1.10.0";

/** Cheap structural probe: only the columnar shape carries typed-array columns. */
export function isColumnarSyntaxTree(tree: unknown): tree is NativeSyntaxTree {
  return typeof tree === "object" && tree !== null && ArrayBuffer.isView((tree as NativeSyntaxTree).kindIds);
}

export function nativeShapeMismatchMessage(): string {
  return (
    `@lzehrung/codegraph-native >= ${REQUIRED_NATIVE_EXTRACTION_VERSION} is required; ` +
    "the installed native binary returns the legacy syntax-tree shape. Reinstall the native package."
  );
}
