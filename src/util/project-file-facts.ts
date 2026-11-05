import type { SyntaxTreeLike } from "../languages/types.js";
import { collectCsharpNamespaceFacts, type CsharpNamespaceFacts } from "./csharp-tree.js";
import { collectJvmFileFacts, jvmPackageName, type JvmFileFacts } from "./jvm-tree.js";
import { isJvmLanguage, type JvmLanguageId } from "./syntax-tree.js";

/** Per-file declarations only; project scans combine these after extraction finishes. Null means unavailable. */
export type ProjectFileFacts = {
  csharpNamespaceFacts?: CsharpNamespaceFacts | null;
  jvmFacts?: JvmFileFacts | null;
};

export const JVM_PACKAGE_HEAD_CHARS = 64 * 1024;

/** A bounded, whole-line prefix for the package-only fallback of a file without a usable whole-file tree. */
export function jvmPackageHead(source: string): string {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  if (text.length <= JVM_PACKAGE_HEAD_CHARS) return text;
  const head = text.slice(0, JVM_PACKAGE_HEAD_CHARS);
  return head.slice(0, head.lastIndexOf("\n") + 1);
}

/** Reuses the extraction's tree. Only an unavailable JVM tree needs a bounded package-only parse. */
export function collectProjectFileFacts(
  source: string,
  languageId: string,
  tree: SyntaxTreeLike | null,
  parsePackageHead: (head: string, languageId: JvmLanguageId) => SyntaxTreeLike | null,
): ProjectFileFacts | undefined {
  if (languageId === "csharp") return { csharpNamespaceFacts: tree ? collectCsharpNamespaceFacts(tree) : null };
  if (!isJvmLanguage(languageId)) return undefined;
  if (tree) return { jvmFacts: collectJvmFileFacts(tree, languageId) };
  let head: SyntaxTreeLike | null = null;
  try {
    head = parsePackageHead(jvmPackageHead(source), languageId);
  } catch {
    // A failed bounded parse cannot place the file in a package.
  }
  return {
    jvmFacts: head ? { packageName: jvmPackageName(head, languageId), symbols: [], incomplete: true } : null,
  };
}
