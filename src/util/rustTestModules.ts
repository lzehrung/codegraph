import { XID_IDENTIFIER_SOURCE } from "./identifiers.js";

const RUST_TEST_MODULE_PATTERN = new RegExp(
  String.raw`#\s*\[cfg\s*\(\s*test\s*\)\]\s*mod\s+${XID_IDENTIFIER_SOURCE}\s*\{`,
  "gu",
);
export function isRustCfgTestStatement(source: string, statementText: string, statementStartIndex?: number): boolean {
  const normalizedStatement = statementText.trim();
  if (!normalizedStatement) return false;

  const statementIndex = resolveStatementIndex(source, statementText, normalizedStatement, statementStartIndex);
  if (statementIndex === -1) return false;
  if (hasImmediateRustCfgTestAttribute(source, statementIndex)) return true;
  return isInsideRustCfgTestModule(source, statementIndex);
}

export function utf8ByteOffsetToStringIndex(source: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytesSeen = 0;
  for (let index = 0; index < source.length; ) {
    if (bytesSeen >= byteOffset) return index;
    const codePoint = source.codePointAt(index);
    if (codePoint === undefined) return source.length;
    bytesSeen += Buffer.byteLength(String.fromCodePoint(codePoint), "utf8");
    index += codePoint > 0xffff ? 2 : 1;
  }
  return source.length;
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

function hasImmediateRustCfgTestAttribute(source: string, statementIndex: number): boolean {
  const prefix = source.slice(0, statementIndex).trimEnd();
  return /#\s*\[cfg\s*\(\s*test\s*\)\]\s*$/.test(prefix);
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
