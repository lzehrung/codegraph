import type { SyntaxTreeLike } from "../languages/types.js";
import { indexLanguagePolicyFor } from "../indexer/index-language-policies/index.js";
import type { JvmLanguageId } from "./syntax-tree.js";
import type { ProjectFileFacts } from "./project-file-facts-types.js";

export const JVM_PACKAGE_HEAD_CHARS = 64 * 1024;

/** A bounded, whole-line prefix for the package-only fallback of a file without a usable whole-file tree. */
export function jvmPackageHead(source: string): string {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  if (text.length <= JVM_PACKAGE_HEAD_CHARS) return text;
  const head = text.slice(0, JVM_PACKAGE_HEAD_CHARS);
  return head.slice(0, head.lastIndexOf("\n") + 1);
}

/**
 * The fact slot `collectProjectFileFacts` fills for this language.
 * Callers prime that slot instead of branching on the language id themselves.
 */
export function projectFactsSlot(languageId: string | undefined): "csharp" | "jvm" | undefined {
  return languageId ? indexLanguagePolicyFor(languageId).module?.projectFacts?.slot : undefined;
}

/** Reuses the extraction's tree. Only an unavailable JVM tree needs a bounded package-only parse. */
export function collectProjectFileFacts(
  source: string,
  languageId: string,
  tree: SyntaxTreeLike | null,
  parsePackageHead: (head: string, languageId: JvmLanguageId) => SyntaxTreeLike | null,
): ProjectFileFacts | undefined {
  const collect = indexLanguagePolicyFor(languageId).module?.projectFacts?.collect;
  return collect?.(source, tree, parsePackageHead, jvmPackageHead);
}
