import { buildByteMap, type ByteToStringIndexMap } from "../native/byte-index.js";
import { XID_IDENTIFIER_SOURCE } from "./identifiers.js";
import { lruMapGet } from "./lru-map.js";
import { rustLeadingAttributesIncludeCfgTest } from "./resolution/rust.js";

const RUST_TEST_MODULE_PATTERN = new RegExp(
  String.raw`#\s*\[cfg\s*\(\s*test\s*\)\]\s*mod\s+${XID_IDENTIFIER_SOURCE}\s*\{`,
  "gu",
);
export function isRustCfgTestStatement(source: string, statementText: string, statementStartIndex?: number): boolean {
  const normalizedStatement = statementText.trim();
  if (!normalizedStatement) return false;

  const statementIndex = resolveStatementIndex(source, statementText, normalizedStatement, statementStartIndex);
  if (statementIndex === -1) return false;
  if (rustLeadingAttributesIncludeCfgTest(source, statementIndex)) return true;
  return isInsideRustCfgTestModule(source, statementIndex);
}

// Import extraction converts every capture of a file from a UTF-8 byte offset, and the files of a build interleave
// at each await. Scanning from the start of the source for every capture is quadratic in the file, so each source
// keeps one conversion table in a least-recently-used cache. A build keeps at most 64 files in flight (8 by
// default), so 96 sources never thrash; the byte budget stops a project of very large files from pinning its tables.
const BYTE_MAP_CACHE_MAX_SOURCES = 96;
const BYTE_MAP_CACHE_MAX_BYTES = 64 * 1024 * 1024;

type CachedByteMap = { readonly map: ByteToStringIndexMap; readonly retainedBytes: number };

const byteMapCache = new Map<string, CachedByteMap>();
let byteMapCacheBytes = 0;

function cachedByteMap(source: string): ByteToStringIndexMap {
  const cached = lruMapGet(byteMapCache, source);
  if (cached) return cached.map;
  // A pure ASCII source builds no table: the map only records that byte offsets and string indexes coincide.
  const map = buildByteMap(source);
  // The key retains the UTF-16 source; the map retains a typed byte table and numeric line starts.
  const retainedBytes = source.length * 2 + map.byteToStringIndex.byteLength + map.lineStartBytes.length * 8;
  byteMapCache.set(source, { map, retainedBytes });
  byteMapCacheBytes += retainedBytes;
  // The entry just added stays, however large: evicting it would rebuild its table on every call.
  while (
    byteMapCache.size > BYTE_MAP_CACHE_MAX_SOURCES ||
    (byteMapCacheBytes > BYTE_MAP_CACHE_MAX_BYTES && byteMapCache.size > 1)
  ) {
    const oldest = byteMapCache.entries().next();
    if (oldest.done) break;
    byteMapCache.delete(oldest.value[0]);
    byteMapCacheBytes -= oldest.value[1].retainedBytes;
  }
  return map;
}

/**
 * The UTF-16 index of the first code point boundary at or after the UTF-8 `byteOffset` of `source`: an offset inside a
 * code point resolves to the end of that code point, and an offset at or past the end resolves to `source.length`.
 */
export function utf8ByteOffsetToStringIndex(source: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  const map = cachedByteMap(source);
  // A NaN offset fails every comparison below and so resolves to the end, as the scan this replaces resolved it.
  if (map.isAscii) return byteOffset < source.length ? Math.ceil(byteOffset) : source.length;
  const table = map.byteToStringIndex;
  if (!(byteOffset < table.length - 1)) return source.length;
  const byte = Math.ceil(byteOffset);
  const index = table[byte] ?? source.length;
  // Every byte of a multi-byte code point maps to its start, while a boundary maps past the previous byte's index.
  if (table[byte - 1] !== index) return index;
  const codePoint = source.codePointAt(index) ?? 0;
  return index + (codePoint > 0xffff ? 2 : 1);
}

function resolveStatementIndex(
  source: string,
  statementText: string,
  normalizedStatement: string,
  statementStartIndex?: number,
): number {
  if (statementStartIndex !== undefined) {
    const leadingWhitespace = statementText.search(/\S/);
    return statementStartIndex + Math.max(0, leadingWhitespace);
  }
  return source.indexOf(normalizedStatement);
}

function isInsideRustCfgTestModule(source: string, statementIndex: number): boolean {
  RUST_TEST_MODULE_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(RUST_TEST_MODULE_PATTERN)) {
    const moduleStart = match.index;
    const openBraceIndex = source.indexOf("{", moduleStart);
    if (openBraceIndex === -1 || statementIndex <= openBraceIndex) continue;
    const closeBraceIndex = findClosingBrace(source, openBraceIndex);
    if (closeBraceIndex === undefined) continue;
    if (statementIndex < closeBraceIndex) return true;
  }
  return false;
}

function findClosingBrace(source: string, openBraceIndex: number): number | undefined {
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      depth += 1;
      continue;
    }
    if (character !== "}") continue;
    depth -= 1;
    if (!depth) return index;
  }
  return undefined;
}
