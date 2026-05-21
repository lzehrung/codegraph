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
};

export type DuplicateDetectionOmittedCounts = {
  suggestions: number;
  oversizedBuckets: number;
  belowThresholdUnits: number;
  overlappingPairs: number;
  comparedPairs: number;
  candidatePairs: number;
};

export type DuplicateDetectionResult = {
  schemaVersion: 1;
  units: number;
  suggestions: DuplicateSuggestion[];
  omittedCounts: DuplicateDetectionOmittedCounts;
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

type DuplicateUnitDraft = Omit<DuplicateUnitRef, "tokenCount">;

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
const DEFAULT_SHINGLE_SIZE = 5;
const DEFAULT_WINDOW_SIZE = 4;
const DEFAULT_MAX_FINGERPRINTS = 128;

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
    text.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b[A-Za-z_$][\w$]*\b|\d+(?:\.\d+)?|[^\s]/g) ??
    []
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

function normalizePositiveIntegerOption(value: number | undefined, optionName: string, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`Invalid ${optionName} value "${String(resolved)}". Expected a positive integer.`);
  }
  return resolved;
}

function normalizeNonNegativeIntegerOption(value: number | undefined, optionName: string, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new Error(`Invalid ${optionName} value "${String(resolved)}". Expected a non-negative integer.`);
  }
  return resolved;
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
): DuplicateInternalUnit {
  const rawHash = hashText(text);
  const sourceTokens = tokenizeSource(text);
  const normalizedTokens = sourceTokens.map(normalizeToken);
  const signatures = winnowShingles(
    makeShingles(normalizedTokens, shingleSize),
    windowSize,
    DEFAULT_MAX_FINGERPRINTS,
  );
  return {
    ...unit,
    id: internalUnitId(unit, absoluteFile),
    absoluteFile: normalizePath(absoluteFile),
    text,
    rawHash,
    normalizedHash: hashText(normalizedTokens.join(" ")),
    tokenCount: sourceTokens.length,
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
  const unit: DuplicateUnitDraft = {
    file: displayPath(projectRoot, symbol.file),
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    languageId: chunk.languageId,
    kind: "symbol",
    name: symbol.localName,
    symbolKind: symbol.kind,
    ...(symbol.complexity !== undefined ? { complexity: symbol.complexity } : {}),
  };
  return buildInternalUnit(unit, symbol.file, chunk.text, shingleSize, windowSize);
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
    const unit: DuplicateUnitDraft = {
      file: displayPath(projectRoot, filePath),
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

function orderedPair(left: DuplicateInternalUnit, right: DuplicateInternalUnit): [DuplicateInternalUnit, DuplicateInternalUnit] {
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
          existing.signature = existing.signatureMatches >= 2;
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
  const normalizedFiles = Array.from(new Set(files.map((file) => normalizeDetectionFile(file, options.projectRoot)))).sort();
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
    const chunkUnits = makeChunkUnits(
      file,
      chunks,
      options.projectRoot,
      options.shingleSize,
      options.windowSize,
    );
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
    ...(unit.name !== undefined ? { name: unit.name } : {}),
    ...(unit.symbolKind !== undefined ? { symbolKind: unit.symbolKind } : {}),
    ...(unit.complexity !== undefined ? { complexity: unit.complexity } : {}),
  };
}

/** Finds scored duplicate candidates from an already-built project index. */
export async function findDuplicates(
  index: ProjectIndex,
  options: DuplicateDetectionOptions = {},
): Promise<DuplicateDetectionResult> {
  const projectRoot = options.projectRoot ?? index.projectRoot;
  const minTokens = normalizePositiveIntegerOption(options.minTokens, "minTokens", DEFAULT_MIN_TOKENS);
  const maxTokens = normalizePositiveIntegerOption(options.maxTokens, "maxTokens", DEFAULT_MAX_TOKENS);
  const maxBucketSize = normalizePositiveIntegerOption(
    options.maxBucketSize,
    "maxBucketSize",
    DEFAULT_MAX_BUCKET_SIZE,
  );
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

  suggestions.sort((left, right) => {
    const scoreCompare = right.score - left.score;
    if (scoreCompare) return scoreCompare;
    const leftFileCompare = left.left.file.localeCompare(right.left.file);
    if (leftFileCompare) return leftFileCompare;
    const rightFileCompare = left.right.file.localeCompare(right.right.file);
    if (rightFileCompare) return rightFileCompare;
    return left.left.startLine - right.left.startLine;
  });

  const limitedSuggestions = suggestions.slice(0, limit);
  return {
    schemaVersion: 1,
    units: units.length,
    suggestions: limitedSuggestions,
    omittedCounts: {
      suggestions: Math.max(0, suggestions.length - limitedSuggestions.length),
      oversizedBuckets,
      belowThresholdUnits,
      overlappingPairs,
      comparedPairs,
      candidatePairs: pairs.size,
    },
  };
}
