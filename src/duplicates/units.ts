import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { LANG_CONFIGS } from "../bootstrap/treeSitterLanguages.js";
import { chunkFile, type Chunk } from "../chunking/chunkFile.js";
import { chunkTextFile } from "../chunking/chunkTextFile.js";
import {
  countDuplicateTokens,
  hasUnterminatedQuotedLiteral,
  normalizeDuplicateSourceTokens,
} from "../duplicate-token-normalization.js";
import { supportForFile } from "../languages.js";
import type { ParsedFileContext } from "../indexer/parse-context.js";
import { attemptParsePreparedFileContext } from "../indexer/parse-context.js";
import { SymbolKind, type ProjectIndex, type SymbolDef } from "../indexer/types.js";
import { prepareSourceInput } from "../languages/filePrep.js";
import {
  getNativeDuplicateTokens,
  getNativeTreeSitterSupportedLanguageIds,
  isNativeDuplicateTokenizationAvailable,
  isNativeTreeSitterDisabledByEnv,
} from "../native/treeSitterNative.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { maskJsLikeCommentsStringsAndRegex } from "../util/comments.js";
import { collectLineStartOffsets } from "../util/lines.js";
import { assertFilePathWithinRoot, fileIdentityKey, normalizePath, toProjectDisplayPath } from "../util/paths.js";
import { logWithLevel } from "../logging.js";
import { duplicateUnitCacheVariant, tryLoadDuplicateUnitsFromCache, writeDuplicateUnitsToCache } from "./unitCache.js";
import type {
  CollectedDuplicateUnits,
  DuplicateAstContext,
  DuplicateAstContextCache,
  DuplicateInternalUnit,
  DuplicateUnitCollectionOptions,
  DuplicateUnitDraft,
  DuplicateUnitRef,
  LanguageForFileResult,
} from "./types.js";

export const DEFAULT_MAX_FINGERPRINTS = 128;
export function lineSpan(unit: Pick<DuplicateUnitRef, "startLine" | "endLine">): number {
  return Math.max(1, unit.endLine - unit.startLine + 1);
}

const textLanguageByExtension: Record<string, string> = {
  ".json": "json",
  ".jsonc": "jsonc",
  ".lock": "text",
  ".toml": "toml",
  ".txt": "text",
  ".yaml": "yaml",
  ".yml": "yaml",
};

const chunkLanguageAliases: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
};

const symbolUnitKinds = new Set<SymbolKind>([
  SymbolKind.Function,
  SymbolKind.Class,
  SymbolKind.Interface,
  SymbolKind.TypeAlias,
  SymbolKind.Routine,
  SymbolKind.Table,
  SymbolKind.View,
]);
function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function shortHashText(value: string): string {
  return hashText(value).slice(0, 16);
}

/** Builds hashed token windows used as local structural fingerprints. */
function makeShingles(tokens: readonly string[], size: number): string[] {
  if (tokens.length < size) return [];
  const shingles: string[] = [];
  for (let i = 0; i <= tokens.length - size; i++) {
    shingles.push(shortHashText(tokens.slice(i, i + size).join("\u0000")));
  }
  return shingles;
}

/** Keeps stable representative fingerprints from nearby shingle windows. */
function winnowShingles(shingles: readonly string[], windowSize: number, maxFingerprints: number): Set<string> {
  if (!shingles.length) return new Set();
  if (shingles.length <= windowSize) return new Set(shingles.slice(0, maxFingerprints));

  const fingerprints = new Set<string>();
  for (let i = 0; i <= shingles.length - windowSize; i++) {
    let minimum = shingles[i]!;
    for (let j = i + 1; j < i + windowSize; j++) {
      const candidate = shingles[j]!;
      if (candidate < minimum) minimum = candidate;
    }
    fingerprints.add(minimum);
    if (fingerprints.size >= maxFingerprints) break;
  }
  return fingerprints;
}

function languageForFile(filePath: string): LanguageForFileResult | undefined {
  const support = supportForFile(filePath);
  if (support) {
    return { id: support.id, textOnly: false };
  }
  const languageId = textLanguageByExtension[path.extname(filePath).toLowerCase()];
  if (languageId) {
    return { id: languageId, textOnly: true };
  }
  return undefined;
}

function formatDuplicateFileHandle(file: string): string {
  return ["file", encodeURIComponent(file)].join(":");
}

function formatDuplicateChunkHandle(file: string, line: number): string {
  return ["chunk", encodeURIComponent(file), String(line)].join(":");
}

function formatDuplicateSqlHandle(file: string, name: string, line: number): string {
  return ["sql", encodeURIComponent(name), encodeURIComponent(file), String(line)].join(":");
}

function sqlHandleForDuplicateSymbol(symbol: SymbolDef, file: string): string | undefined {
  if (symbol.kind !== SymbolKind.Routine && symbol.kind !== SymbolKind.Table && symbol.kind !== SymbolKind.View) {
    return undefined;
  }
  if (!file.toLowerCase().endsWith(".sql")) return undefined;
  return formatDuplicateSqlHandle(file, symbol.localName, symbol.range.start.line);
}

function formatDuplicateSymbolHandle(file: string, name: string, line: number, column: number): string {
  return ["symbol", encodeURIComponent(file), encodeURIComponent(name), String(line), String(column)].join(":");
}

export function normalizeDetectionFile(filePath: string, projectRoot: string | undefined): string {
  if (!projectRoot) return normalizePath(filePath);
  return assertFilePathWithinRoot(projectRoot, filePath, "Duplicate input file");
}

function internalUnitId(unit: DuplicateUnitDraft, absoluteFile: string): string {
  return `${normalizePath(absoluteFile)}:${unit.startLine}:${unit.endLine}:${unit.kind}:${unit.name ?? ""}`;
}

export function normalizedDuplicateTokens(text: string, nativeMode: ProjectIndex["nativeMode"] | undefined): string[] {
  if (hasUnterminatedQuotedLiteral(text)) {
    return normalizeDuplicateSourceTokens(text);
  }
  return getNativeDuplicateTokens(text, nativeMode)?.normalizedTokens ?? normalizeDuplicateSourceTokens(text);
}

export function duplicateTextLines(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function maskedDuplicateStatements(text: string): string[] {
  return duplicateTextLines(maskJsLikeCommentsStringsAndRegex(text))
    .join(" ")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export function looksLikeImportStatement(statement: string): boolean {
  if (!/^import\b/u.test(statement)) return false;
  const remainder = statement.slice(6).trimStart();
  if (!remainder.length || remainder.startsWith(".") || remainder.startsWith("(") || remainder.startsWith("=")) {
    return false;
  }
  if (/[=()]/u.test(statement)) return false;
  return !/\b(?:const|let|var|function|class|return|if|for|while|switch|export|new)\b/u.test(statement.slice(6));
}

export function looksLikeBarrelStatement(statement: string): boolean {
  if (!/^export\b/u.test(statement)) return false;
  if (/[=()]/u.test(statement)) return false;
  if (!/\bfrom\b/u.test(statement) && !/^export\s+\*/u.test(statement)) return false;
  return !/\b(?:const|let|var|function|class|return|if|for|while|switch|import|new)\b/u.test(statement.slice(6));
}

export function duplicateTextHeuristics(text: string): { looksLikeImportList: boolean; looksLikeBarrel: boolean } {
  const statements = maskedDuplicateStatements(text);
  if (!statements.length || statements.length > 12) {
    return { looksLikeImportList: false, looksLikeBarrel: false };
  }
  const looksLikeImportList = statements.every(looksLikeImportStatement);
  const looksLikeBarrel = statements.every(looksLikeBarrelStatement);
  return { looksLikeImportList, looksLikeBarrel };
}

/** Adds hashes, normalized tokens, and fingerprints to a reportable unit. */
export function buildInternalUnit(
  unit: DuplicateUnitDraft,
  absoluteFile: string,
  text: string,
  shingleSize: number,
  windowSize: number,
  nativeMode: ProjectIndex["nativeMode"] | undefined,
  handles: { symbolHandle?: string; sqlHandle?: string } = {},
  astShapeHash?: string,
): DuplicateInternalUnit {
  const rawHash = hashText(text);
  const normalizedTokens = normalizedDuplicateTokens(text, nativeMode);
  const signatures = winnowShingles(makeShingles(normalizedTokens, shingleSize), windowSize, DEFAULT_MAX_FINGERPRINTS);
  const fileHandle = formatDuplicateFileHandle(unit.file);
  const chunkHandle = formatDuplicateChunkHandle(unit.file, unit.startLine);
  const handle = handles.sqlHandle ?? handles.symbolHandle ?? chunkHandle;
  const heuristics = duplicateTextHeuristics(text);
  return {
    ...unit,
    id: internalUnitId(unit, absoluteFile),
    absoluteFile: normalizePath(absoluteFile),
    rawHash,
    normalizedHash: hashText(normalizedTokens.join(" ")),
    ...(astShapeHash !== undefined ? { astShapeHash } : {}),
    tokenCount: normalizedTokens.length,
    handle,
    fileHandle,
    chunkHandle,
    ...(handles.sqlHandle !== undefined ? { sqlHandle: handles.sqlHandle } : {}),
    ...(handles.symbolHandle !== undefined ? { symbolHandle: handles.symbolHandle } : {}),
    ...(heuristics.looksLikeImportList ? { looksLikeImportList: true } : {}),
    ...(heuristics.looksLikeBarrel ? { looksLikeBarrel: true } : {}),
    tokenSet: new Set(normalizedTokens),
    signatures,
  };
}

export function makeSymbolUnit(
  symbol: SymbolDef,
  chunk: Chunk,
  projectRoot: string | undefined,
  nativeMode: ProjectIndex["nativeMode"] | undefined,
  shingleSize: number,
  windowSize: number,
  astContext: DuplicateAstContext | undefined,
): DuplicateInternalUnit | undefined {
  if (!symbolUnitKinds.has(symbol.kind)) return undefined;
  const file = toProjectDisplayPath(projectRoot, symbol.file);
  const sqlHandle = sqlHandleForDuplicateSymbol(symbol, file);
  const symbolHandle =
    sqlHandle === undefined
      ? formatDuplicateSymbolHandle(file, symbol.localName, symbol.range.start.line, symbol.range.start.column)
      : undefined;
  const unit: DuplicateUnitDraft = {
    file,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    languageId: chunk.languageId,
    kind: "symbol",
    name: symbol.localName,
    symbolKind: symbol.kind,
    ...(symbol.complexity !== undefined ? { complexity: symbol.complexity } : {}),
  };
  return buildInternalUnit(
    unit,
    symbol.file,
    chunk.text,
    shingleSize,
    windowSize,
    nativeMode,
    {
      ...(sqlHandle !== undefined ? { sqlHandle } : {}),
      ...(symbolHandle !== undefined ? { symbolHandle } : {}),
    },
    astShapeHashForRange(astContext, chunk.startLine, chunk.endLine),
  );
}

export function makeDuplicateChunks(
  filePath: string,
  languageId: string,
  textOnly: boolean,
  source: string,
  minTokens: number,
  maxTokens: number,
): Chunk[] {
  const langConfig = LANG_CONFIGS[chunkLanguageAliases[languageId] ?? languageId];
  if (langConfig && !textOnly) {
    return chunkFile({ language: langConfig, source, filePath, minTokens, maxTokens, tokenizer: countDuplicateTokens });
  }
  return chunkTextFile({ source, filePath, languageId, minTokens, maxTokens, tokenizer: countDuplicateTokens });
}

export function makeSymbolSourceChunks(
  filePath: string,
  languageId: string,
  textOnly: boolean,
  source: string,
  maxTokens: number,
): Chunk[] {
  if (textOnly) return [];
  return makeDuplicateChunks(filePath, languageId, false, source, 1, maxTokens);
}

export function findChunkForSymbol(symbol: SymbolDef, chunks: readonly Chunk[]): Chunk | undefined {
  const symbolLine = Math.max(1, symbol.range.start.line);
  const candidates = chunks.filter(
    (chunk) =>
      chunk.name === symbol.localName &&
      chunk.startLine <= symbolLine &&
      symbolLine <= chunk.endLine &&
      chunk.endLine > chunk.startLine,
  );
  candidates.sort((left, right) => lineSpan(left) - lineSpan(right));
  return candidates[0];
}

export async function getDuplicateAstContext(
  index: ProjectIndex,
  file: string,
  source: string,
  cache: DuplicateAstContextCache,
): Promise<DuplicateAstContext | undefined> {
  const fileKey = fileIdentityKey(file);
  if (cache.has(fileKey)) return cache.get(fileKey) ?? undefined;

  const retained = index.parsed?.get(fileKey);
  if (retained?.source === source) {
    const context = astContextFromParsed(retained);
    cache.set(fileKey, context);
    return context;
  }

  try {
    const prepared = await prepareSourceInput(file, { source });
    const attempt = attemptParsePreparedFileContext({
      file,
      source: prepared.source,
      sup: prepared.sup,
      ...(index.nativeMode !== undefined ? { nativeMode: index.nativeMode } : {}),
      nativeQueries: null,
    });
    if (!attempt.parsed) {
      cache.set(fileKey, null);
      return undefined;
    }
    const context = astContextFromParsed(attempt.parsed);
    cache.set(fileKey, context);
    return context;
  } catch {
    cache.set(fileKey, null);
    return undefined;
  }
}

export function astContextFromParsed(parsed: ParsedFileContext): DuplicateAstContext {
  return {
    source: parsed.source,
    tree: parsed.tree,
    lineStartOffsets: collectLineStartOffsets(parsed.source),
  };
}

export function astShapeHashForRange(
  context: DuplicateAstContext | undefined,
  startLine: number,
  endLine: number,
): string | undefined {
  if (!context) return undefined;
  const range = lineRangeToByteRange(context, startLine, endLine);
  if (!range) return undefined;
  const node = findSmallestCoveringNode(context.tree.rootNode, range.start, range.end);
  if (!node) return undefined;
  const shape = normalizedAstShape(node);
  if (!shape) return undefined;
  return hashText(shape);
}

export function lineRangeToByteRange(
  context: DuplicateAstContext,
  startLine: number,
  endLine: number,
): { start: number; end: number } | undefined {
  const startOffset = context.lineStartOffsets[Math.max(0, startLine - 1)];
  if (startOffset === undefined) return undefined;
  const nextLineOffset = context.lineStartOffsets[Math.max(startLine, endLine)];
  const rawEndOffset = nextLineOffset === undefined ? context.source.length : Math.max(startOffset, nextLineOffset);
  let trimmedStartOffset = startOffset;
  let endOffset = Math.max(startOffset, rawEndOffset);
  while (trimmedStartOffset < endOffset && /\s/.test(context.source[trimmedStartOffset]!)) {
    trimmedStartOffset++;
  }
  while (endOffset > trimmedStartOffset && /\s/.test(context.source[endOffset - 1]!)) {
    endOffset--;
  }
  const startIndex = trimmedStartOffset;
  if (endOffset <= startIndex) return undefined;
  return { start: startIndex, end: endOffset };
}

export function findSmallestCoveringNode(
  node: SyntaxNodeLike,
  startIndex: number,
  endIndex: number,
): SyntaxNodeLike | null {
  if (node.endIndex < startIndex || node.startIndex > endIndex) return null;
  if (node.startIndex > startIndex || node.endIndex < endIndex) return null;
  for (const child of node.namedChildren) {
    const candidate = findSmallestCoveringNode(child, startIndex, endIndex);
    if (candidate) return candidate;
  }
  return node;
}

export function normalizedAstShape(root: SyntaxNodeLike): string {
  let visited = 0;
  const maxNodes = 512;
  const walk = (node: SyntaxNodeLike): string => {
    visited++;
    if (visited > maxNodes) return "...";
    const nodeType = normalizeAstNodeType(node.type);
    const childShapes = node.namedChildren
      .filter((child) => !isAstShapeIgnoredNode(child))
      .map(walk)
      .filter(Boolean);
    if (!childShapes.length) return nodeType;
    return `${nodeType}(${childShapes.join(",")})`;
  };
  return walk(root);
}

export function isAstShapeIgnoredNode(node: SyntaxNodeLike): boolean {
  const type = node.type.toLowerCase();
  return type.includes("comment") || type === "error";
}

export function normalizeAstNodeType(type: string): string {
  const lower = type.toLowerCase();
  if (lower.includes("identifier") || lower === "name" || lower.endsWith("_name")) return "identifier";
  if (lower.includes("string") || lower.includes("char") || lower.includes("template")) return "literal";
  if (lower.includes("number") || lower.includes("integer") || lower.includes("float")) return "literal";
  if (lower.includes("boolean") || lower === "true" || lower === "false" || lower === "null" || lower === "nil") {
    return "literal";
  }
  return type;
}

/** Falls back to semantic chunks so body-level clones are still visible. */
export function makeChunkUnits(
  filePath: string,
  chunks: readonly Chunk[],
  projectRoot: string | undefined,
  nativeMode: ProjectIndex["nativeMode"] | undefined,
  shingleSize: number,
  windowSize: number,
  astContext: DuplicateAstContext | undefined,
): DuplicateInternalUnit[] {
  return chunks.map((chunk) => {
    const file = toProjectDisplayPath(projectRoot, filePath);
    const unit: DuplicateUnitDraft = {
      file,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      languageId: chunk.languageId,
      kind: "chunk",
      ...(chunk.name !== undefined ? { name: chunk.name } : {}),
    };
    return buildInternalUnit(
      unit,
      filePath,
      chunk.text,
      shingleSize,
      windowSize,
      nativeMode,
      {},
      astShapeHashForRange(astContext, chunk.startLine, chunk.endLine),
    );
  });
}

export function shouldKeepUnit(unit: DuplicateInternalUnit, includeSmall: boolean, minTokens: number): boolean {
  if (includeSmall) return true;
  return unit.tokenCount >= minTokens;
}

/** Reads files and creates comparable symbol and chunk units. */
export async function collectDuplicateUnits(
  index: ProjectIndex,
  options: DuplicateUnitCollectionOptions,
): Promise<CollectedDuplicateUnits> {
  const files = options.files ?? Array.from(index.byFile.values(), (module) => module.file);
  const filesByIdentity = new Map<string, string>();
  for (const file of files) {
    const normalized = normalizeDetectionFile(file, options.projectRoot);
    filesByIdentity.set(fileIdentityKey(normalized), normalized);
  }
  const normalizedFiles = [...filesByIdentity.values()].sort();
  const units: DuplicateInternalUnit[] = [];
  const astContextCache: DuplicateAstContextCache = new Map();
  const variant = duplicateUnitCacheVariant(
    index,
    options.minTokens,
    options.maxTokens,
    options.shingleSize,
    options.windowSize,
  );
  let belowThresholdUnits = 0;
  const belowThresholdUnitsByFile = new Map<string, number>();

  for (const file of normalizedFiles) {
    const cachedUnits = tryLoadDuplicateUnitsFromCache(index, file, variant);
    const fileUnits =
      cachedUnits ??
      (await buildDuplicateUnitsForFile(
        index,
        file,
        options.projectRoot,
        options.minTokens,
        options.maxTokens,
        options.shingleSize,
        options.windowSize,
        astContextCache,
      ));
    if (!cachedUnits) {
      writeDuplicateUnitsToCache(index, file, variant, fileUnits);
    }
    for (const unit of fileUnits) {
      if (!shouldKeepUnit(unit, options.includeSmall, options.minTokens)) {
        belowThresholdUnits++;
        belowThresholdUnitsByFile.set(file, (belowThresholdUnitsByFile.get(file) ?? 0) + 1);
        continue;
      }
      units.push(unit);
    }
  }

  units.sort((left, right) => {
    const fileCompare = left.absoluteFile.localeCompare(right.absoluteFile);
    if (fileCompare) return fileCompare;
    const lineCompare = left.startLine - right.startLine;
    if (lineCompare) return lineCompare;
    return (left.name ?? "").localeCompare(right.name ?? "");
  });
  return { units, belowThresholdUnits, belowThresholdUnitsByFile };
}

export async function buildDuplicateUnitsForFile(
  index: ProjectIndex,
  file: string,
  projectRoot: string | undefined,
  minTokens: number,
  maxTokens: number,
  shingleSize: number,
  windowSize: number,
  astContextCache: DuplicateAstContextCache,
): Promise<DuplicateInternalUnit[]> {
  const moduleIndex = index.byFile.get(fileIdentityKey(file));
  const language = languageForFile(file);
  if (!language) return [];

  let source = index.parsed?.get(fileIdentityKey(file))?.source;
  if (source === undefined) {
    try {
      source = await fsp.readFile(file, "utf8");
    } catch {
      return [];
    }
  }

  const astContext = language.textOnly ? undefined : await getDuplicateAstContext(index, file, source, astContextCache);
  const chunks = makeDuplicateChunks(file, language.id, language.textOnly, source, minTokens, maxTokens);
  const symbolChunks = makeSymbolSourceChunks(file, language.id, language.textOnly, source, maxTokens);
  const symbolUnits = (moduleIndex?.locals ?? [])
    .map((symbol) => {
      const chunk = findChunkForSymbol(symbol, symbolChunks);
      if (!chunk) return undefined;
      return makeSymbolUnit(symbol, chunk, projectRoot, index.nativeMode, shingleSize, windowSize, astContext);
    })
    .filter((unit): unit is DuplicateInternalUnit => unit !== undefined);
  const chunkUnits = makeChunkUnits(file, chunks, projectRoot, index.nativeMode, shingleSize, windowSize, astContext);
  return [...symbolUnits, ...chunkUnits];
}
