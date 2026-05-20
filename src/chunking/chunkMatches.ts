import type { LanguageConfig } from "./languageConfig.js";
import { supportById } from "../languages.js";
import {
  executeJsQueryAsNativeMatches,
  getNativeSingleQueryExecution,
  isNativeBindingLoadedForLanguage,
  type NativeMatch,
} from "../native/treeSitterNative.js";
import type { ChunkMatch } from "./types.js";

export function getChunkMatches(language: LanguageConfig, source: string, filePath?: string | undefined): ChunkMatch[] {
  const support = supportById(language.supportId);
  if (support) {
    const nativeExecution = getNativeSingleQueryExecution(source, support, language.queryText);
    if (nativeExecution.matches) {
      return nativeExecution.matches.map(toChunkMatchFromNative);
    }
    if (isNativeBindingLoadedForLanguage(support.id)) {
      return [];
    }

    try {
      const matches = executeJsQueryAsNativeMatches(
        source,
        support,
        language.definition.grammar(filePath),
        language.queryText,
      );
      return matches.map(toChunkMatchFromNative);
    } catch {
      return [];
    }
  }

  return [];
}

function toChunkMatchFromNative(match: NativeMatch): ChunkMatch {
  return {
    captures: match.captures.map((capture) => ({
      name: capture.name,
      text: capture.text,
      startByte: capture.start.index,
      endByte: capture.end.index,
      startLine: capture.start.row + 1,
      endLine: capture.end.row + 1,
      nodeType: capture.nodeType,
    })),
  };
}
