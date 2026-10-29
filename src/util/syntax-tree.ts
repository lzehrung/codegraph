import type { LanguageSupport } from "../languages.js";
import type { SyntaxTreeLike } from "../languages/types.js";
import { ProjectedSyntaxTree } from "../native/projected-tree.js";
import {
  getNativeSyntaxTreeExecution,
  type NativeFallbackReason,
  type NativeSyntaxTreeExecution,
} from "../native/tree-sitter-native.js";
import { errorMessage } from "./errors.js";

export type JvmLanguageId = "java" | "kotlin";

export function isJvmLanguage(languageId: string | undefined): languageId is JvmLanguageId {
  return languageId === "java" || languageId === "kotlin";
}

/** C# and the JVM languages read their imports and declarations from one syntax tree, so none has an import query. */
export function readsSyntaxTree(languageId: string | undefined): boolean {
  return languageId === "csharp" || isJvmLanguage(languageId);
}

export type SyntaxTreeResult = {
  tree: SyntaxTreeLike | null;
  fallbackReason?: NativeFallbackReason;
  error?: string;
};

export function syntaxTreeFromNativeExecution(
  source: string,
  execution: Pick<NativeSyntaxTreeExecution, "tree" | "fallbackReason" | "error">,
): SyntaxTreeResult {
  if (!execution.tree) {
    return {
      tree: null,
      ...(execution.fallbackReason ? { fallbackReason: execution.fallbackReason } : {}),
      ...(execution.error ? { error: execution.error } : {}),
    };
  }
  try {
    return { tree: new ProjectedSyntaxTree(source, execution.tree) };
  } catch (error) {
    return {
      tree: null,
      fallbackReason: execution.fallbackReason ?? "queryFailure",
      error: errorMessage(error),
    };
  }
}

/** Parses `source` into the syntax tree its imports and declarations are read from. */
export function parseSyntaxTree(source: string, support: LanguageSupport): SyntaxTreeResult {
  return syntaxTreeFromNativeExecution(source, getNativeSyntaxTreeExecution(source, support));
}
