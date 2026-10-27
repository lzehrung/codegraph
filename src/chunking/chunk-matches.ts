import type { LanguageConfig } from "./language-config.js";
import { supportById } from "../languages.js";
import { buildByteMap, stringIndexForByte, type ByteToStringIndexMap } from "../native/byte-index.js";
import { getNativeSingleQueryExecution, type NativeMatch } from "../native/tree-sitter-native.js";
import type { ChunkMatch } from "./types.js";

export function getChunkMatches(
  language: LanguageConfig,
  source: string,
  _filePath?: string | undefined,
): ChunkMatch[] {
  const support = supportById(language.supportId);
  if (support) {
    const nativeExecution = getNativeSingleQueryExecution(source, support, language.queryText);
    if (nativeExecution.matches) {
      // Native Tree-sitter indexes are UTF-8 bytes; JS String.slice uses UTF-16 units.
      const byteMap = buildByteMap(source);
      return nativeExecution.matches.map((match) => toChunkMatchFromNative(match, byteMap));
    }
  }

  return [];
}

function toChunkMatchFromNative(match: NativeMatch, byteMap: ByteToStringIndexMap): ChunkMatch {
  return {
    captures: match.captures.map((capture) => ({
      name: capture.name,
      text: capture.text,
      startByte: stringIndexForByte(byteMap, capture.start.index),
      endByte: stringIndexForByte(byteMap, capture.end.index),
      startLine: capture.start.row + 1,
      endLine: capture.end.row + 1,
      nodeType: capture.nodeType,
    })),
  };
}
