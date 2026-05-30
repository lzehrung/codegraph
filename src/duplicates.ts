import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { LANG_CONFIGS } from "./bootstrap/treeSitterLanguages.js";
import { chunkFile, type Chunk } from "./chunking/chunkFile.js";
import { chunkTextFile } from "./chunking/chunkTextFile.js";
import { supportForFile } from "./languages.js";
import { SymbolKind, type ProjectIndex, type SymbolDef } from "./indexer/types.js";
import { assertFilePathWithinRoot, normalizePath, toProjectDisplayPath } from "./util/paths.js";

export type DuplicateConfidence = "high" | "medium" | "low";
export type DuplicateCloneType = "exact" | "renamed" | "near" | "weak";
export type DuplicateUnitKind = "symbol" | "chunk";

export type DuplicateUnitRef = {
  file: string;
  startLine: number;
  endLine: number;
  languageId: string;
  kind: DuplicateUnitKind;
  tokenCount: number;
  handle: string;
  fileHandle: string;
  chunkHandle: string;
  symbolHandle?: string;
  name?: string;
  symbolKind?: SymbolKind;
  complexity?: number;
};

export type DuplicateMetrics = {
  tokenJaccard: number;
  shingleOverlap: number;
  lengthRatio: number;
  lineSpanRatio: number;
  complexityDelta?: number;
};

export type DuplicateSuggestion = {
  score: number;
  confidence: DuplicateConfidence;
  cloneType: DuplicateCloneType;
  left: DuplicateUnitRef;
  right: DuplicateUnitRef;
  metrics: DuplicateMetrics;
  reasons: string[];
};

export type DuplicateGroup = {
  id: string;
  score: number;
  confidence: DuplicateConfidence;
  cloneType: DuplicateCloneType;
  primaryLeft: DuplicateUnitRef;
  primaryRight: DuplicateUnitRef;
  variants: DuplicateSuggestion[];
  variantCount: number;
  rawPairCount: number;
  omittedVariantCount: number;
  metrics: DuplicateMetrics;
  reasons: string[];
};

export type DuplicateDetectionOptions = {
  projectRoot?: string;
  files?: readonly string[];
  minConfidence?: DuplicateConfidence;
  limit?: number;
  crossFileOnly?: boolean;
  includeSameFile?: boolean;
  includeSmall?: boolean;
  minTokens?: number;
  maxTokens?: number;
  maxBucketSize?: number;
  shingleSize?: number;
  windowSize?: number;
  includeRawPairs?: boolean;
};

export type DuplicateDetectionOmittedCounts = {
  groups: number;
  /** @deprecated Use `groups`; retained as a compatibility alias. */
  suggestions: number;
  rawSuggestions: number;
  oversizedBuckets: number;
  belowThresholdUnits: number;
  overlappingPairs: number;
};

export type DuplicateDetectionStats = {
  comparedPairs: number;
  candidatePairs: number;
};

export type DuplicateDetectionResult = {
  schemaVersion: 2;
  units: number;
  groups: DuplicateGroup[];
  suggestions?: DuplicateSuggestion[];
  omittedCounts: DuplicateDetectionOmittedCounts;
  stats: DuplicateDetectionStats;
};
export type DuplicateTarget = {
  file: string;
  startLine?: number;
  endLine?: number;
};

export type DuplicateContextResult = DuplicateDetectionResult & {
  target: DuplicateTarget;
};

type UnitCluster = {
  id: string;
  refs: DuplicateUnitRef[];
  primary: DuplicateUnitRef;
};

type DuplicateInternalUnit = DuplicateUnitRef & {
  id: string;
  absoluteFile: string;
  text: string;
  rawHash: string;
  normalizedHash: string;
  normalizedTokens: string[];
  tokenSet: Set<string>;
  signatures: Set<string>;
};

type DuplicateUnitDraft = Omit<DuplicateUnitRef, "tokenCount" | "handle" | "fileHandle" | "chunkHandle" | "symbolHandle">;

type PairEvidence = {
  left: DuplicateInternalUnit;
  right: DuplicateInternalUnit;
  rawHash: boolean;
  normalizedHash: boolean;
  signature: boolean;
  signatureMatches: number;
};

type LanguageForFileResult = {
  id: string;
  textOnly: boolean;
};

type ConsideredSignaturesByUnit = Map<string, Set<string>>;

const DEFAULT_MIN_TOKENS = 40;
const DEFAULT_MAX_TOKENS = 800;
const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_BUCKET_SIZE = 200;
const DEFAULT_GROUP_VARIANT_LIMIT = 5;
const DEFAULT_SHINGLE_SIZE = 5;
const DEFAULT_WINDOW_SIZE = 4;
const DEFAULT_MAX_FINGERPRINTS = 128;
const GROUP_PRIMARY_LENGTH_RATIO_FLOOR = 0.7;
const NEARBY_CHUNK_VARIANT_MAX_GAP = 2;

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

const confidenceRank: Record<DuplicateConfidence, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

const cloneTypeRank: Record<DuplicateCloneType, number> = {
  weak: 1,
  near: 2,
  renamed: 3,
  exact: 4,
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

const identifierKeywords = new Set([
  "abstract",
  "and",
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "def",
  "default",
  "defer",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "final",
  "finally",
  "fn",
  "for",
  "from",
  "func",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "interface",
  "is",
  "lambda",
  "let",
  "match",
  "module",
  "namespace",
  "new",
  "nil",
  "none",
  "not",
  "null",
  "or",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "self",
  "static",
  "struct",
  "switch",
  "this",
  "throw",
  "throws",
  "trait",
  "true",
  "try",
  "type",
  "use",
  "using",
  "var",
  "void",
  "when",
  "where",
  "while",
]);

function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function shortHashText(value: string): string {
  return hashText(value).slice(0, 16);
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Splits source into names, literals, operators, and punctuation. */
function tokenizeSource(text: string): string[] {
  return (
    text.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b[A-Za-z_$][\w$]*\b|\d+(?:\.\d+)?|[^\s]/g) ?? []
  );
}

function countDuplicateTokens(text: string): number {
  return tokenizeSource(text).length;
}

/** Replaces names and literals while preserving syntax and keywords. */
function normalizeToken(token: string): string {
  if (/^["'`]/.test(token)) return "<literal>";
  if (/^\d/.test(token)) return "<literal>";
  if (/^[A-Za-z_$][\w$]*$/.test(token)) {
    const lower = token.toLowerCase();
    if (identifierKeywords.has(lower)) return lower;
    return "<identifier>";
  }
  return token;
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

function lineSpan(unit: Pick<DuplicateUnitRef, "startLine" | "endLine">): number {
  return Math.max(1, unit.endLine - unit.startLine + 1);
}

function lineOverlap(
  left: Pick<DuplicateUnitRef, "startLine" | "endLine">,
  right: Pick<DuplicateUnitRef, "startLine" | "endLine">,
): number {
  const startLine = Math.max(left.startLine, right.startLine);
  const endLine = Math.min(left.endLine, right.endLine);
  return Math.max(0, endLine - startLine + 1);
}

function rangesSubstantiallyOverlap(left: DuplicateUnitRef, right: DuplicateUnitRef): boolean {
  if (left.file !== right.file || left.languageId !== right.languageId) return false;
  const overlap = lineOverlap(left, right);
  if (!overlap) return false;
  return overlap / Math.min(lineSpan(left), lineSpan(right)) >= 0.8;
}

function lineGap(left: DuplicateUnitRef, right: DuplicateUnitRef): number {
  if (left.endLine < right.startLine) return right.startLine - left.endLine - 1;
  if (right.endLine < left.startLine) return left.startLine - right.endLine - 1;
  return 0;
}

function rangesAreNearbyChunkVariants(left: DuplicateUnitRef, right: DuplicateUnitRef): boolean {
  if (left.file !== right.file || left.languageId !== right.languageId) return false;
  if (left.kind !== "chunk" || right.kind !== "chunk") return false;
  return lineGap(left, right) <= NEARBY_CHUNK_VARIANT_MAX_GAP;
}

function ratio(left: number, right: number): number {
  if (!left || !right) return 0;
  return Math.min(left, right) / Math.max(left, right);
}

/** Measures set similarity as intersection divided by union. */
function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size && !right.size) return 1;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection++;
  }
  const union = left.size + right.size - intersection;
  if (!union) return 0;
  return intersection / union;
}

function normalizeConfidence(value: DuplicateConfidence | undefined): DuplicateConfidence {
  return value ?? "medium";
}

function normalizeIntegerOption(
  value: number | undefined,
  optionName: string,
  fallback: number,
  minValue: number,
  expectedDescription: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minValue) {
    throw new Error(`Invalid ${optionName} value "${String(resolved)}". Expected ${expectedDescription}.`);
  }
  return resolved;
}

function normalizePositiveIntegerOption(value: number | undefined, optionName: string, fallback: number): number {
  return normalizeIntegerOption(value, optionName, fallback, 1, "a positive integer");
}

function normalizeNonNegativeIntegerOption(value: number | undefined, optionName: string, fallback: number): number {
  return normalizeIntegerOption(value, optionName, fallback, 0, "a non-negative integer");
}

function bestConfidence(left: DuplicateConfidence, right: DuplicateConfidence): DuplicateConfidence {
  if (confidenceRank[left] >= confidenceRank[right]) return left;
  return right;
}

function bestCloneType(left: DuplicateCloneType, right: DuplicateCloneType): DuplicateCloneType {
  if (cloneTypeRank[left] >= cloneTypeRank[right]) return left;
  return right;
}

function confidenceForScore(score: number): DuplicateConfidence {
  if (score >= 85) return "high";
  if (score >= 65) return "medium";
  return "low";
}

function cloneTypeForPair(evidence: PairEvidence, metrics: DuplicateMetrics): DuplicateCloneType {
  if (evidence.rawHash) return "exact";
  if (evidence.normalizedHash && metrics.tokenJaccard >= 0.75) return "renamed";
  if (metrics.shingleOverlap >= 0.55 || metrics.tokenJaccard >= 0.72) return "near";
  return "weak";
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

function formatDuplicateSymbolHandle(file: string, name: string, line: number, column: number): string {
  return ["symbol", encodeURIComponent(file), encodeURIComponent(name), String(line), String(column)].join(":");
}

function displayPath(projectRoot: string | undefined, filePath: string): string {
  if (!projectRoot) return normalizePath(filePath);
  return toProjectDisplayPath(projectRoot, filePath) || normalizePath(filePath);
}

function normalizeDetectionFile(filePath: string, projectRoot: string | undefined): string {
  if (!projectRoot) return normalizePath(filePath);
  return assertFilePathWithinRoot(projectRoot, filePath, "Duplicate input file");
}

function internalUnitId(unit: DuplicateUnitDraft, absoluteFile: string): string {
  return `${normalizePath(absoluteFile)}:${unit.startLine}:${unit.endLine}:${unit.kind}:${unit.name ?? ""}`;
}

/** Adds hashes, normalized tokens, and fingerprints to a reportable unit. */
function buildInternalUnit(
  unit: DuplicateUnitDraft,
  absoluteFile: string,
  text: string,
  shingleSize: number,
  windowSize: number,
  symbolHandle?: string,
): DuplicateInternalUnit {
  const rawHash = hashText(text);
  const sourceTokens = tokenizeSource(text);
  const normalizedTokens = sourceTokens.map(normalizeToken);
  const signatures = winnowShingles(makeShingles(normalizedTokens, shingleSize), windowSize, DEFAULT_MAX_FINGERPRINTS);
  const fileHandle = formatDuplicateFileHandle(unit.file);
  const chunkHandle = formatDuplicateChunkHandle(unit.file, unit.startLine);
  return {
    ...unit,
    id: internalUnitId(unit, absoluteFile),
    absoluteFile: normalizePath(absoluteFile),
    text,
    rawHash,
    normalizedHash: hashText(normalizedTokens.join(" ")),
    tokenCount: sourceTokens.length,
    handle: symbolHandle ?? chunkHandle,
    fileHandle,
    chunkHandle,
    ...(symbolHandle !== undefined ? { symbolHandle } : {}),
    normalizedTokens,
    tokenSet: new Set(normalizedTokens),
    signatures,
  };
}

function makeSymbolUnit(
  symbol: SymbolDef,
  chunk: Chunk,
  projectRoot: string | undefined,
  shingleSize: number,
  windowSize: number,
): DuplicateInternalUnit | undefined {
  if (!symbolUnitKinds.has(symbol.kind)) return undefined;
  const file = displayPath(projectRoot, symbol.file);
  const symbolHandle = formatDuplicateSymbolHandle(
    file,
    symbol.localName,
    symbol.range.start.line,
    symbol.range.start.column,
  );
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
  return buildInternalUnit(unit, symbol.file, chunk.text, shingleSize, windowSize, symbolHandle);
}

function makeDuplicateChunks(
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

function makeSymbolSourceChunks(
  filePath: string,
  languageId: string,
  textOnly: boolean,
  source: string,
  maxTokens: number,
): Chunk[] {
  if (textOnly) return [];
  return makeDuplicateChunks(filePath, languageId, false, source, 1, maxTokens);
}

function findChunkForSymbol(symbol: SymbolDef, chunks: readonly Chunk[]): Chunk | undefined {
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

/** Falls back to semantic chunks so body-level clones are still visible. */
function makeChunkUnits(
  filePath: string,
  chunks: readonly Chunk[],
  projectRoot: string | undefined,
  shingleSize: number,
  windowSize: number,
): DuplicateInternalUnit[] {
  return chunks.map((chunk) => {
    const file = displayPath(projectRoot, filePath);
    const unit: DuplicateUnitDraft = {
      file,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      languageId: chunk.languageId,
      kind: "chunk",
      ...(chunk.name !== undefined ? { name: chunk.name } : {}),
    };
    return buildInternalUnit(unit, filePath, chunk.text, shingleSize, windowSize);
  });
}

function shouldKeepUnit(unit: DuplicateInternalUnit, includeSmall: boolean, minTokens: number): boolean {
  if (includeSmall) return true;
  return unit.tokenCount >= minTokens;
}

function pairKey(left: DuplicateInternalUnit, right: DuplicateInternalUnit): string {
  if (left.id < right.id) return `${left.id}\u0000${right.id}`;
  return `${right.id}\u0000${left.id}`;
}

function orderedPair(
  left: DuplicateInternalUnit,
  right: DuplicateInternalUnit,
): [DuplicateInternalUnit, DuplicateInternalUnit] {
  if (left.absoluteFile < right.absoluteFile) return [left, right];
  if (left.absoluteFile > right.absoluteFile) return [right, left];
  if (left.startLine <= right.startLine) return [left, right];
  return [right, left];
}

function hasLineOverlap(left: DuplicateInternalUnit, right: DuplicateInternalUnit): boolean {
  if (left.absoluteFile !== right.absoluteFile) return false;
  return left.startLine <= right.endLine && right.startLine <= left.endLine;
}

/** Adds every unique pair from one shared-evidence bucket. */
function addBucketPairs(
  bucket: readonly DuplicateInternalUnit[],
  pairs: Map<string, PairEvidence>,
  evidenceKind: "rawHash" | "normalizedHash" | "signature",
): void {
  for (let i = 0; i < bucket.length; i++) {
    for (let j = i + 1; j < bucket.length; j++) {
      const [left, right] = orderedPair(bucket[i]!, bucket[j]!);
      const key = pairKey(left, right);
      const existing = pairs.get(key);
      if (existing) {
        if (evidenceKind === "signature") {
          existing.signatureMatches++;
        } else {
          existing[evidenceKind] = true;
        }
        continue;
      }
      pairs.set(key, {
        left,
        right,
        rawHash: evidenceKind === "rawHash",
        normalizedHash: evidenceKind === "normalizedHash",
        signature: false,
        signatureMatches: evidenceKind === "signature" ? 1 : 0,
      });
    }
  }
}

/** Adds bounded buckets and counts skipped high-fanout buckets. */
function addBucketsToPairs(
  buckets: Map<string, DuplicateInternalUnit[]>,
  pairs: Map<string, PairEvidence>,
  evidenceKind: "rawHash" | "normalizedHash" | "signature",
  maxBucketSize: number,
): number {
  let oversizedBuckets = 0;
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    if (bucket.length > maxBucketSize) {
      oversizedBuckets++;
      continue;
    }
    addBucketPairs(bucket, pairs, evidenceKind);
  }
  return oversizedBuckets;
}

function addConsideredSignature(
  consideredSignaturesByUnit: ConsideredSignaturesByUnit,
  unit: DuplicateInternalUnit,
  signature: string,
): void {
  const signatures = consideredSignaturesByUnit.get(unit.id);
  if (signatures) {
    signatures.add(signature);
    return;
  }
  consideredSignaturesByUnit.set(unit.id, new Set([signature]));
}

function addSignatureBucketsToPairs(
  buckets: Map<string, DuplicateInternalUnit[]>,
  pairs: Map<string, PairEvidence>,
  consideredSignaturesByUnit: ConsideredSignaturesByUnit,
  maxBucketSize: number,
): number {
  let oversizedBuckets = 0;
  for (const [signature, bucket] of buckets) {
    if (bucket.length < 2) continue;
    if (bucket.length > maxBucketSize) {
      oversizedBuckets++;
      continue;
    }
    for (const unit of bucket) {
      addConsideredSignature(consideredSignaturesByUnit, unit, signature);
    }
    addBucketPairs(bucket, pairs, "signature");
  }
  return oversizedBuckets;
}

/** Combines exact, normalized, fingerprint, size, and complexity signals. */
function scorePair(evidence: PairEvidence, metrics: DuplicateMetrics): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  if (evidence.rawHash) {
    score += 68;
    reasons.push("identical text");
  }
  if (evidence.normalizedHash) {
    score += 48;
    reasons.push("matching normalized token stream");
  }
  if (evidence.signature) {
    score += 14;
    reasons.push("shared fingerprint bucket");
  }

  score += metrics.tokenJaccard * 24;
  score += metrics.shingleOverlap * 26;
  score += metrics.lengthRatio * 8;
  score += metrics.lineSpanRatio * 5;

  if (evidence.left.symbolKind !== undefined && evidence.left.symbolKind === evidence.right.symbolKind) {
    score += 4;
    reasons.push(`matching ${evidence.left.symbolKind} units`);
  }
  if (metrics.complexityDelta !== undefined && metrics.complexityDelta <= 2) {
    score += 3;
    reasons.push("similar complexity");
  }
  if (metrics.lengthRatio < 0.45) score -= 18;
  if (evidence.left.absoluteFile === evidence.right.absoluteFile) score -= 8;

  return { score: clampScore(score), reasons };
}

function metricsForPair(evidence: PairEvidence): DuplicateMetrics {
  const left = evidence.left;
  const right = evidence.right;
  const metrics: DuplicateMetrics = {
    tokenJaccard: jaccard(left.tokenSet, right.tokenSet),
    shingleOverlap: jaccard(left.signatures, right.signatures),
    lengthRatio: ratio(left.tokenCount, right.tokenCount),
    lineSpanRatio: ratio(lineSpan(left), lineSpan(right)),
  };
  if (left.complexity !== undefined && right.complexity !== undefined) {
    metrics.complexityDelta = Math.abs(left.complexity - right.complexity);
  }
  return metrics;
}

/** Reads files and creates comparable symbol and chunk units. */
async function collectDuplicateUnits(
  index: ProjectIndex,
  options: Required<
    Pick<DuplicateDetectionOptions, "includeSmall" | "minTokens" | "maxTokens" | "shingleSize" | "windowSize">
  > & { projectRoot: string | undefined; files: readonly string[] | undefined },
): Promise<{ units: DuplicateInternalUnit[]; belowThresholdUnits: number }> {
  const files = options.files ?? Array.from(index.byFile.keys());
  const normalizedFiles = Array.from(
    new Set(files.map((file) => normalizeDetectionFile(file, options.projectRoot))),
  ).sort();
  const units: DuplicateInternalUnit[] = [];
  let belowThresholdUnits = 0;

  for (const file of normalizedFiles) {
    const moduleIndex = index.byFile.get(file);
    const language = languageForFile(file);
    if (!language) continue;

    let source: string;
    try {
      source = await fsp.readFile(file, "utf8");
    } catch {
      continue;
    }

    const chunks = makeDuplicateChunks(
      file,
      language.id,
      language.textOnly,
      source,
      options.minTokens,
      options.maxTokens,
    );
    const symbolChunks = makeSymbolSourceChunks(file, language.id, language.textOnly, source, options.maxTokens);
    const symbolUnits = (moduleIndex?.locals ?? [])
      .map((symbol) => {
        const chunk = findChunkForSymbol(symbol, symbolChunks);
        if (!chunk) return undefined;
        return makeSymbolUnit(symbol, chunk, options.projectRoot, options.shingleSize, options.windowSize);
      })
      .filter((unit): unit is DuplicateInternalUnit => unit !== undefined);
    const chunkUnits = makeChunkUnits(file, chunks, options.projectRoot, options.shingleSize, options.windowSize);
    const candidates = [...symbolUnits, ...chunkUnits];

    for (const unit of candidates) {
      if (!shouldKeepUnit(unit, options.includeSmall, options.minTokens)) {
        belowThresholdUnits++;
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
  return { units, belowThresholdUnits };
}

function addToBucket(buckets: Map<string, DuplicateInternalUnit[]>, key: string, unit: DuplicateInternalUnit): void {
  const bucket = buckets.get(key);
  if (bucket) {
    bucket.push(unit);
    return;
  }
  buckets.set(key, [unit]);
}

/** Groups units by cheap fingerprints before expensive pair scoring. */
function buildCandidatePairs(
  units: readonly DuplicateInternalUnit[],
  maxBucketSize: number,
): { pairs: Map<string, PairEvidence>; oversizedBuckets: number } {
  const rawHashBuckets = new Map<string, DuplicateInternalUnit[]>();
  const normalizedHashBuckets = new Map<string, DuplicateInternalUnit[]>();
  const signatureBuckets = new Map<string, DuplicateInternalUnit[]>();

  for (const unit of units) {
    const languagePrefix = `${unit.languageId}:`;
    addToBucket(rawHashBuckets, `${languagePrefix}${unit.rawHash}`, unit);
    addToBucket(normalizedHashBuckets, `${languagePrefix}${unit.normalizedHash}`, unit);
    for (const signature of unit.signatures) {
      addToBucket(signatureBuckets, `${languagePrefix}${signature}`, unit);
    }
  }

  const pairs = new Map<string, PairEvidence>();
  const consideredSignaturesByUnit: ConsideredSignaturesByUnit = new Map();
  let oversizedBuckets = 0;
  oversizedBuckets += addBucketsToPairs(rawHashBuckets, pairs, "rawHash", maxBucketSize);
  oversizedBuckets += addBucketsToPairs(normalizedHashBuckets, pairs, "normalizedHash", maxBucketSize);
  oversizedBuckets += addSignatureBucketsToPairs(signatureBuckets, pairs, consideredSignaturesByUnit, maxBucketSize);
  for (const [key, evidence] of pairs) {
    if (hasEnoughSharedFingerprints(evidence, consideredSignaturesByUnit)) {
      evidence.signature = true;
      continue;
    }
    if (!evidence.rawHash && !evidence.normalizedHash) {
      pairs.delete(key);
    }
  }
  return { pairs, oversizedBuckets };
}

/** Requires enough shared fingerprints to avoid incidental syntax matches. */
function hasEnoughSharedFingerprints(
  evidence: PairEvidence,
  consideredSignaturesByUnit: ConsideredSignaturesByUnit,
): boolean {
  if (!evidence.signatureMatches) return false;
  const leftConsideredSignatures = consideredSignaturesByUnit.get(evidence.left.id)?.size ?? 0;
  const rightConsideredSignatures = consideredSignaturesByUnit.get(evidence.right.id)?.size ?? 0;
  const smallerConsideredSignatureCount = Math.min(leftConsideredSignatures, rightConsideredSignatures);
  if (!smallerConsideredSignatureCount) return false;
  const minimumShared = Math.max(2, Math.ceil(smallerConsideredSignatureCount * 0.25));
  return evidence.signatureMatches >= minimumShared;
}

function suggestionForPair(evidence: PairEvidence): DuplicateSuggestion {
  const metrics = metricsForPair(evidence);
  const { score, reasons } = scorePair(evidence, metrics);
  return {
    score,
    confidence: confidenceForScore(score),
    cloneType: cloneTypeForPair(evidence, metrics),
    left: unitRef(evidence.left),
    right: unitRef(evidence.right),
    metrics,
    reasons,
  };
}

function unitRef(unit: DuplicateInternalUnit): DuplicateUnitRef {
  return {
    file: unit.file,
    startLine: unit.startLine,
    endLine: unit.endLine,
    languageId: unit.languageId,
    kind: unit.kind,
    tokenCount: unit.tokenCount,
    handle: unit.handle,
    fileHandle: unit.fileHandle,
    chunkHandle: unit.chunkHandle,
    ...(unit.symbolHandle !== undefined ? { symbolHandle: unit.symbolHandle } : {}),
    ...(unit.name !== undefined ? { name: unit.name } : {}),
    ...(unit.symbolKind !== undefined ? { symbolKind: unit.symbolKind } : {}),
    ...(unit.complexity !== undefined ? { complexity: unit.complexity } : {}),
  };
}

function unitRefIdentity(ref: DuplicateUnitRef): string {
  return [ref.file, ref.startLine, ref.endLine, ref.languageId, ref.kind, ref.name ?? "", ref.symbolKind ?? ""].join(
    "\u0000",
  );
}

function unitRefRangeIdentity(ref: DuplicateUnitRef): string {
  return [ref.file, ref.startLine, ref.endLine, ref.languageId].join("\u0000");
}

function compareUnitRefs(left: DuplicateUnitRef, right: DuplicateUnitRef): number {
  const fileCompare = left.file.localeCompare(right.file);
  if (fileCompare) return fileCompare;
  const startCompare = left.startLine - right.startLine;
  if (startCompare) return startCompare;
  const endCompare = left.endLine - right.endLine;
  if (endCompare) return endCompare;
  return (left.name ?? "").localeCompare(right.name ?? "");
}

function unitPrimaryRank(ref: DuplicateUnitRef): number {
  let rank = 0;
  if (ref.kind === "symbol") rank += 8;
  if (ref.name) rank += 4;
  if (ref.symbolKind !== undefined) rank += 2;
  return rank;
}

function comparePrimaryUnitRefs(left: DuplicateUnitRef, right: DuplicateUnitRef): number {
  const rankCompare = unitPrimaryRank(right) - unitPrimaryRank(left);
  if (rankCompare) return rankCompare;
  const spanCompare = lineSpan(left) - lineSpan(right);
  if (spanCompare) return spanCompare;
  return compareUnitRefs(left, right);
}

function suggestionPrimaryRank(suggestion: DuplicateSuggestion): number {
  let rank = 0;
  if (suggestion.left.kind === "symbol") rank += 8;
  if (suggestion.right.kind === "symbol") rank += 8;
  if (suggestion.left.name) rank += 2;
  if (suggestion.right.name) rank += 2;
  return rank;
}

function compareSuggestions(left: DuplicateSuggestion, right: DuplicateSuggestion): number {
  const scoreCompare = right.score - left.score;
  if (scoreCompare) return scoreCompare;
  const confidenceCompare = confidenceRank[right.confidence] - confidenceRank[left.confidence];
  if (confidenceCompare) return confidenceCompare;
  const cloneTypeCompare = cloneTypeRank[right.cloneType] - cloneTypeRank[left.cloneType];
  if (cloneTypeCompare) return cloneTypeCompare;
  const leftFileCompare = left.left.file.localeCompare(right.left.file);
  if (leftFileCompare) return leftFileCompare;
  const rightFileCompare = left.right.file.localeCompare(right.right.file);
  if (rightFileCompare) return rightFileCompare;
  return left.left.startLine - right.left.startLine;
}

function compareSuggestionsForPrimary(left: DuplicateSuggestion, right: DuplicateSuggestion): number {
  const rankCompare = suggestionPrimaryRank(right) - suggestionPrimaryRank(left);
  if (rankCompare) return rankCompare;
  return compareSuggestions(left, right);
}

function createUnitClusters(refs: readonly DuplicateUnitRef[]): Map<string, UnitCluster> {
  const uniqueRefs = new Map<string, DuplicateUnitRef>();
  for (const ref of refs) uniqueRefs.set(unitRefIdentity(ref), ref);
  const parent = new Map<string, string>();
  for (const key of uniqueRefs.keys()) parent.set(key, key);
  const find = (key: string): string => {
    const current = parent.get(key);
    if (current === undefined || current === key) return key;
    const root = find(current);
    parent.set(key, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    if (leftRoot < rightRoot) {
      parent.set(rightRoot, leftRoot);
      return;
    }
    parent.set(leftRoot, rightRoot);
  };
  const refsByFile = new Map<string, Array<{ key: string; ref: DuplicateUnitRef }>>();
  for (const [key, ref] of uniqueRefs) {
    const fileKey = `${ref.file}\u0000${ref.languageId}`;
    const existing = refsByFile.get(fileKey);
    if (existing) existing.push({ key, ref });
    else refsByFile.set(fileKey, [{ key, ref }]);
  }
  for (const fileRefs of refsByFile.values()) {
    fileRefs.sort((left, right) => compareUnitRefs(left.ref, right.ref));
    for (let i = 0; i < fileRefs.length; i++) {
      const left = fileRefs[i]!;
      for (let j = i + 1; j < fileRefs.length; j++) {
        const right = fileRefs[j]!;
        if (right.ref.startLine > left.ref.endLine + NEARBY_CHUNK_VARIANT_MAX_GAP + 1) break;
        if (rangesSubstantiallyOverlap(left.ref, right.ref) || rangesAreNearbyChunkVariants(left.ref, right.ref)) {
          union(left.key, right.key);
        }
      }
    }
  }
  const refsByRoot = new Map<string, DuplicateUnitRef[]>();
  for (const [key, ref] of uniqueRefs) {
    const root = find(key);
    const existing = refsByRoot.get(root);
    if (existing) existing.push(ref);
    else refsByRoot.set(root, [ref]);
  }
  const clustersByRef = new Map<string, UnitCluster>();
  for (const refsInCluster of refsByRoot.values()) {
    refsInCluster.sort(comparePrimaryUnitRefs);
    const primary = refsInCluster[0]!;
    const cluster = { id: shortHashText(unitRefIdentity(primary)), refs: refsInCluster, primary };
    for (const ref of refsInCluster) clustersByRef.set(unitRefIdentity(ref), cluster);
  }
  return clustersByRef;
}

function singletonUnitCluster(ref: DuplicateUnitRef): UnitCluster {
  return { id: shortHashText(unitRefIdentity(ref)), refs: [ref], primary: ref };
}

function orderedGroupKey(left: UnitCluster, right: UnitCluster): string {
  if (left.id < right.id) return `${left.id}\u0000${right.id}`;
  return `${right.id}\u0000${left.id}`;
}

function orderedUnitPairKey(left: DuplicateUnitRef, right: DuplicateUnitRef): string {
  const leftKey = unitRefIdentity(left);
  const rightKey = unitRefIdentity(right);
  if (leftKey < rightKey) return `${leftKey}\u0000${rightKey}`;
  return `${rightKey}\u0000${leftKey}`;
}

function orderedUnitRangePairKey(left: DuplicateUnitRef, right: DuplicateUnitRef): string {
  const leftKey = unitRefRangeIdentity(left);
  const rightKey = unitRefRangeIdentity(right);
  if (leftKey < rightKey) return `${leftKey}\u0000${rightKey}`;
  return `${rightKey}\u0000${leftKey}`;
}

function suggestionVariantKey(suggestion: DuplicateSuggestion): string {
  return [
    orderedUnitPairKey(suggestion.left, suggestion.right),
    suggestion.score,
    suggestion.confidence,
    suggestion.cloneType,
  ].join("\u0000");
}

function mergeReasonLists(reasonLists: Iterable<readonly string[]>): string[] {
  const reasons = new Set<string>();
  for (const reasonList of reasonLists) {
    for (const reason of reasonList) reasons.add(reason);
  }
  return Array.from(reasons).sort();
}

function mergeReasons(suggestions: readonly DuplicateSuggestion[]): string[] {
  return mergeReasonLists(suggestions.map((suggestion) => suggestion.reasons));
}

function mergeGroupReasons(groups: readonly DuplicateGroup[]): string[] {
  return mergeReasonLists(groups.map((group) => group.reasons));
}

function groupForSuggestions(
  key: string,
  suggestions: DuplicateSuggestion[],
  left: UnitCluster,
  right: UnitCluster,
  variantLimit: number,
): DuplicateGroup {
  suggestions.sort(compareSuggestionsForPrimary);
  const primary = suggestions[0]!;
  const variants = suggestions.slice(0, variantLimit);
  let score = primary.score;
  let confidence = primary.confidence;
  let cloneType = primary.cloneType;
  for (const suggestion of suggestions.slice(1)) {
    score = Math.max(score, suggestion.score);
    confidence = bestConfidence(confidence, suggestion.confidence);
    cloneType = bestCloneType(cloneType, suggestion.cloneType);
  }
  let reasons = mergeReasons(suggestions);
  const primaryLengthRatio = ratio(left.primary.tokenCount, right.primary.tokenCount);
  if (primaryLengthRatio < GROUP_PRIMARY_LENGTH_RATIO_FLOOR) {
    score = Math.min(score, 64);
    confidence = "low";
    reasons = Array.from(new Set([...reasons, "different-sized grouped units"])).sort();
  }
  return {
    id: shortHashText(key),
    score,
    confidence,
    cloneType,
    primaryLeft: left.primary,
    primaryRight: right.primary,
    variants,
    variantCount: variants.length,
    rawPairCount: suggestions.length,
    omittedVariantCount: Math.max(0, suggestions.length - variants.length),
    metrics: primary.metrics,
    reasons,
  };
}

function compareGroups(left: DuplicateGroup, right: DuplicateGroup): number {
  const scoreCompare = right.score - left.score;
  if (scoreCompare) return scoreCompare;
  const confidenceCompare = confidenceRank[right.confidence] - confidenceRank[left.confidence];
  if (confidenceCompare) return confidenceCompare;
  const cloneTypeCompare = cloneTypeRank[right.cloneType] - cloneTypeRank[left.cloneType];
  if (cloneTypeCompare) return cloneTypeCompare;
  const tokenCompare =
    right.primaryLeft.tokenCount +
    right.primaryRight.tokenCount -
    (left.primaryLeft.tokenCount + left.primaryRight.tokenCount);
  if (tokenCompare) return tokenCompare;
  const leftCompare = compareUnitRefs(left.primaryLeft, right.primaryLeft);
  if (leftCompare) return leftCompare;
  return compareUnitRefs(left.primaryRight, right.primaryRight);
}

function coalesceDuplicateGroups(groups: DuplicateGroup[], variantLimit: number): DuplicateGroup[] {
  const groupsByPrimaryPair = new Map<string, DuplicateGroup[]>();
  for (const group of groups) {
    const key = orderedUnitRangePairKey(group.primaryLeft, group.primaryRight);
    const existing = groupsByPrimaryPair.get(key);
    if (existing) existing.push(group);
    else groupsByPrimaryPair.set(key, [group]);
  }

  const coalesced: DuplicateGroup[] = [];
  for (const [key, grouped] of groupsByPrimaryPair) {
    if (grouped.length === 1) {
      coalesced.push(grouped[0]!);
      continue;
    }

    grouped.sort(compareGroups);
    const primary = grouped[0]!;
    const variantsByKey = new Map<string, DuplicateSuggestion>();
    for (const group of grouped) {
      for (const variant of group.variants) {
        variantsByKey.set(suggestionVariantKey(variant), variant);
      }
    }
    const dedupedVariants = Array.from(variantsByKey.values()).sort(compareSuggestionsForPrimary);
    const variants = dedupedVariants.slice(0, variantLimit);
    const rawPairCount = grouped.reduce((count, group) => count + group.rawPairCount, 0);
    let score = primary.score;
    let confidence = primary.confidence;
    let cloneType = primary.cloneType;
    for (const group of grouped.slice(1)) {
      score = Math.max(score, group.score);
      confidence = bestConfidence(confidence, group.confidence);
      cloneType = bestCloneType(cloneType, group.cloneType);
    }
    coalesced.push({
      ...primary,
      id: shortHashText(key),
      score,
      confidence,
      cloneType,
      variants,
      variantCount: variants.length,
      rawPairCount,
      omittedVariantCount: Math.max(0, dedupedVariants.length - variants.length),
      reasons: mergeGroupReasons(grouped),
    });
  }
  coalesced.sort(compareGroups);
  return coalesced;
}

function groupSuggestions(suggestions: readonly DuplicateSuggestion[], includeRawPairs: boolean): DuplicateGroup[] {
  const refs = suggestions.flatMap((suggestion) => [suggestion.left, suggestion.right]);
  const clusters = createUnitClusters(refs);
  const variantLimit = includeRawPairs ? Number.POSITIVE_INFINITY : DEFAULT_GROUP_VARIANT_LIMIT;
  const suggestionsByGroup = new Map<
    string,
    { left: UnitCluster; right: UnitCluster; suggestions: DuplicateSuggestion[] }
  >();
  for (const suggestion of suggestions) {
    let leftCluster = clusters.get(unitRefIdentity(suggestion.left));
    let rightCluster = clusters.get(unitRefIdentity(suggestion.right));
    if (!leftCluster || !rightCluster) continue;
    if (leftCluster.id === rightCluster.id) {
      if (rangesSubstantiallyOverlap(suggestion.left, suggestion.right)) continue;
      leftCluster = singletonUnitCluster(suggestion.left);
      rightCluster = singletonUnitCluster(suggestion.right);
    }
    const key = orderedGroupKey(leftCluster, rightCluster);
    const existing = suggestionsByGroup.get(key);
    if (existing) existing.suggestions.push(suggestion);
    else suggestionsByGroup.set(key, { left: leftCluster, right: rightCluster, suggestions: [suggestion] });
  }
  const groups = Array.from(suggestionsByGroup, ([key, value]) =>
    groupForSuggestions(key, value.suggestions, value.left, value.right, variantLimit),
  );
  return coalesceDuplicateGroups(groups, variantLimit);
}

/** Finds scored duplicate candidates from an already-built project index. */
export async function findDuplicates(
  index: ProjectIndex,
  options: DuplicateDetectionOptions = {},
): Promise<DuplicateDetectionResult> {
  const projectRoot = options.projectRoot ?? index.projectRoot;
  const minTokens = normalizePositiveIntegerOption(options.minTokens, "minTokens", DEFAULT_MIN_TOKENS);
  const maxTokens = normalizePositiveIntegerOption(options.maxTokens, "maxTokens", DEFAULT_MAX_TOKENS);
  const maxBucketSize = normalizePositiveIntegerOption(options.maxBucketSize, "maxBucketSize", DEFAULT_MAX_BUCKET_SIZE);
  const shingleSize = normalizePositiveIntegerOption(options.shingleSize, "shingleSize", DEFAULT_SHINGLE_SIZE);
  const windowSize = normalizePositiveIntegerOption(options.windowSize, "windowSize", DEFAULT_WINDOW_SIZE);
  const includeSmall = options.includeSmall ?? false;
  const crossFileOnly = options.crossFileOnly ?? !(options.includeSameFile ?? false);
  const minConfidence = normalizeConfidence(options.minConfidence);
  const limit = normalizeNonNegativeIntegerOption(options.limit, "limit", DEFAULT_LIMIT);

  if (maxTokens < minTokens) {
    throw new Error(`Invalid maxTokens value "${maxTokens}". Expected a value greater than or equal to minTokens.`);
  }

  const { units, belowThresholdUnits } = await collectDuplicateUnits(index, {
    projectRoot,
    files: options.files,
    includeSmall,
    minTokens,
    maxTokens,
    shingleSize,
    windowSize,
  });
  const { pairs, oversizedBuckets } = buildCandidatePairs(units, maxBucketSize);
  const suggestions: DuplicateSuggestion[] = [];
  let overlappingPairs = 0;
  let comparedPairs = 0;

  for (const evidence of pairs.values()) {
    if (crossFileOnly && evidence.left.absoluteFile === evidence.right.absoluteFile) continue;
    if (hasLineOverlap(evidence.left, evidence.right)) {
      overlappingPairs++;
      continue;
    }

    comparedPairs++;
    const suggestion = suggestionForPair(evidence);

    if (confidenceRank[suggestion.confidence] < confidenceRank[minConfidence]) continue;
    suggestions.push(suggestion);
  }

  suggestions.sort(compareSuggestions);

  const includeRawPairs = options.includeRawPairs ?? false;
  const groups = groupSuggestions(suggestions, includeRawPairs).filter(
    (group) => confidenceRank[group.confidence] >= confidenceRank[minConfidence],
  );
  const limitedGroups = groups.slice(0, limit);
  const omittedGroups = Math.max(0, groups.length - limitedGroups.length);
  const limitedRawSuggestions = includeRawPairs ? suggestions.slice(0, limit) : [];
  const result: DuplicateDetectionResult = {
    schemaVersion: 2,
    units: units.length,
    groups: limitedGroups,
    omittedCounts: {
      groups: omittedGroups,
      suggestions: omittedGroups,
      rawSuggestions: Math.max(0, suggestions.length - limitedRawSuggestions.length),
      oversizedBuckets,
      belowThresholdUnits,
      overlappingPairs,
    },
    stats: {
      comparedPairs,
      candidatePairs: pairs.size,
    },
  };
  if (includeRawPairs) {
    result.suggestions = limitedRawSuggestions;
  }
  return result;
}

function normalizeDuplicateTarget(target: DuplicateTarget, projectRoot: string | undefined): DuplicateTarget {
  const file = normalizePath(target.file);
  const normalizedFile = projectRoot && path.isAbsolute(file) ? displayPath(projectRoot, file) : file;
  return {
    file: normalizedFile,
    ...(target.startLine !== undefined ? { startLine: target.startLine } : {}),
    ...(target.endLine !== undefined ? { endLine: target.endLine } : {}),
  };
}

function unitTouchesDuplicateTarget(unit: DuplicateUnitRef, target: DuplicateTarget): boolean {
  if (unit.file !== target.file) return false;
  if (target.startLine === undefined) return true;
  const targetEndLine = target.endLine ?? target.startLine;
  return lineOverlap(unit, { startLine: target.startLine, endLine: targetEndLine }) > 0;
}

function suggestionTouchesDuplicateTarget(suggestion: DuplicateSuggestion, target: DuplicateTarget): boolean {
  return unitTouchesDuplicateTarget(suggestion.left, target) || unitTouchesDuplicateTarget(suggestion.right, target);
}

function groupTouchesDuplicateTarget(group: DuplicateGroup, target: DuplicateTarget): boolean {
  if (unitTouchesDuplicateTarget(group.primaryLeft, target) || unitTouchesDuplicateTarget(group.primaryRight, target)) {
    return true;
  }
  return group.variants.some((variant) => suggestionTouchesDuplicateTarget(variant, target));
}

function boundDuplicateGroupVariants(group: DuplicateGroup, includeRawPairs: boolean): DuplicateGroup {
  if (includeRawPairs) return group;
  const variants = group.variants.slice(0, DEFAULT_GROUP_VARIANT_LIMIT);
  return {
    ...group,
    variants,
    variantCount: variants.length,
    omittedVariantCount: Math.max(0, group.variants.length - variants.length),
  };
}

function duplicateContextFromResult(
  result: DuplicateDetectionResult,
  target: DuplicateTarget,
  options: { projectRoot: string | undefined; limit: number; includeRawPairs: boolean },
): DuplicateContextResult {
  const normalizedTarget = normalizeDuplicateTarget(target, options.projectRoot);
  const groups = result.groups.filter((group) => groupTouchesDuplicateTarget(group, normalizedTarget));
  const limitedGroups = groups
    .slice(0, options.limit)
    .map((group) => boundDuplicateGroupVariants(group, options.includeRawPairs));
  const omittedGroups = Math.max(0, groups.length - limitedGroups.length);
  const rawSuggestions = options.includeRawPairs
    ? (result.suggestions ?? []).filter((suggestion) => suggestionTouchesDuplicateTarget(suggestion, normalizedTarget))
    : [];
  const limitedRawSuggestions = rawSuggestions.slice(0, options.limit);
  const context: DuplicateContextResult = {
    ...result,
    target: normalizedTarget,
    groups: limitedGroups,
    omittedCounts: {
      ...result.omittedCounts,
      groups: omittedGroups,
      suggestions: omittedGroups,
      rawSuggestions: Math.max(0, rawSuggestions.length - limitedRawSuggestions.length),
    },
  };
  if (options.includeRawPairs) {
    context.suggestions = limitedRawSuggestions;
  } else {
    delete context.suggestions;
  }
  return context;
}

export async function findDuplicateContexts(
  index: ProjectIndex,
  targets: readonly DuplicateTarget[],
  options: DuplicateDetectionOptions = {},
): Promise<DuplicateContextResult[]> {
  if (!targets.length) return [];
  const limit = normalizeNonNegativeIntegerOption(options.limit, "limit", DEFAULT_LIMIT);
  const includeRawPairs = options.includeRawPairs ?? false;
  const result = await findDuplicates(index, {
    ...options,
    limit: Number.MAX_SAFE_INTEGER,
    minConfidence: options.minConfidence ?? "medium",
    includeRawPairs: true,
  });
  const projectRoot = options.projectRoot ?? index.projectRoot;
  return targets.map((target) => duplicateContextFromResult(result, target, { projectRoot, limit, includeRawPairs }));
}

export async function findDuplicateContext(
  index: ProjectIndex,
  target: DuplicateTarget,
  options: DuplicateDetectionOptions = {},
): Promise<DuplicateContextResult> {
  const contexts = await findDuplicateContexts(index, [target], options);
  return contexts[0]!;
}
