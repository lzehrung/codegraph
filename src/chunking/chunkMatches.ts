import { Buffer } from "node:buffer";
import type { LanguageConfig } from "./languageConfig.js";
import { supportById } from "../languages.js";
import { getNativeSingleQueryExecution, type NativeMatch } from "../native/treeSitterNative.js";
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
      const toStringIndex = createUtf8ByteToStringIndex(source);
      return nativeExecution.matches.map((match) => toChunkMatchFromNative(match, toStringIndex));
    }
  }

  return [];
}

function toChunkMatchFromNative(match: NativeMatch, toStringIndex: (byteOffset: number) => number): ChunkMatch {
  return {
    captures: match.captures.map((capture) => ({
      name: capture.name,
      text: capture.text,
      startByte: toStringIndex(capture.start.index),
      endByte: toStringIndex(capture.end.index),
      startLine: capture.start.row + 1,
      endLine: capture.end.row + 1,
      nodeType: capture.nodeType,
    })),
  };
}

function createUtf8ByteToStringIndex(source: string): (byteOffset: number) => number {
  const utf8Length = Buffer.byteLength(source, "utf8");
  if (utf8Length === source.length) {
    return (byteOffset) => Math.max(0, Math.min(byteOffset, source.length));
  }

  const byteToStringIndex = new Uint32Array(utf8Length + 1);
  let byteOffset = 0;
  let stringIndex = 0;

  while (stringIndex < source.length) {
    const codePoint = source.codePointAt(stringIndex);
    if (codePoint === undefined) break;

    const charStringLength = codePoint > 0xffff ? 2 : 1;
    const charByteLength = utf8ByteLengthForCodePoint(codePoint);

    for (let offset = 1; offset < charByteLength; offset += 1) {
      byteToStringIndex[byteOffset + offset] = stringIndex;
    }

    byteOffset += charByteLength;
    stringIndex += charStringLength;
    byteToStringIndex[byteOffset] = stringIndex;
  }

  byteToStringIndex[byteOffset] = source.length;

  return (index) => {
    const bounded = Math.max(0, Math.min(index, byteToStringIndex.length - 1));
    return byteToStringIndex[bounded] ?? source.length;
  };
}

function utf8ByteLengthForCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}
