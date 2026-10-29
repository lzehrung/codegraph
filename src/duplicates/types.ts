import type { SyntaxTreeLike } from "../languages/types.js";
import type { ProjectIndex, SymbolKind } from "../indexer/types.js";
import type { ProgressUpdate } from "../types.js";
import type { SqliteDatabase, SqliteStatement } from "../sqlite-driver.js";

export type DuplicateConfidence = "high" | "medium" | "low";
export type DuplicateCloneType = "exact" | "renamed" | "near" | "weak";
export type DuplicateCleanupLabel =
  | "test-helper-extraction"
  | "production-helper-extraction"
  | "fixture-boilerplate"
  | "barrel-export-noise"
  | "type-shape-noise"
  | "import-list-noise";

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
  sqlHandle?: string;
  chunkHandle: string;
  symbolHandle?: string;
  name?: string;
  symbolKind?: SymbolKind;
  complexity?: number;
  looksLikeImportList?: boolean;
  looksLikeBarrel?: boolean;
};

export type DuplicateMetrics = {
  tokenJaccard: number;
  shingleOverlap: number;
  lengthRatio: number;
  lineSpanRatio: number;
  astShapeEqual?: boolean;
  gitSimilarity?: number;
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

export type DuplicateClusterSummary = {
  id: string;
  label?: string;
  locationCount: number;
  locations: DuplicateUnitRef[];
  files: string[];
  estimatedLinesSaved: number;
  groupIds: string[];
};

export type DuplicateGroup = {
  id: string;
  score: number;
  confidence: DuplicateConfidence;
  cloneType: DuplicateCloneType;
  primaryLeft: DuplicateUnitRef;
  primaryRight: DuplicateUnitRef;
  locations: DuplicateUnitRef[];
  reducedLines: number;
  estimatedLinesSaved: number;
  cleanupLabels: DuplicateCleanupLabel[];
  cluster?: DuplicateClusterSummary;
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
  similarityHints?: readonly DuplicateSimilarityHint[];
  minConfidence?: DuplicateConfidence;
  limit?: number;
  crossFileOnly?: boolean;
  includeSameFile?: boolean;
  includeSmall?: boolean;
  minTokens?: number;
  maxTokens?: number;
  maxBucketSize?: number;
  maxPairs?: number;
  /**
   * Upper bound on candidate pairs kept for scoring. Evidence kinds are admitted in order of strength
   * (exact text, normalized tokens, AST shape, Git similarity, shared fingerprints); pairs past the bound are
   * skipped and counted in `omittedCounts.candidatePairs`, and `stats.candidatePairBudget` reports the bound.
   * Pairs that can never be scored (two units of one file in a cross-file run, or two that overlap) take no slot and
   * are never counted as skipped. Duplicate contexts for several targets share one bound, and each reports the whole
   * call's skips.
   */
  maxCandidatePairs?: number;
  /** Count candidate duplicate groups without scoring every pair. */
  countOnly?: boolean;
  shingleSize?: number;
  windowSize?: number;
  includeRawPairs?: boolean;
  /** Receives stage progress while units are collected, paired, scored, and grouped. */
  onProgress?: ((update: ProgressUpdate) => void) | undefined;
  /** `performance.now()` origin for the completion `elapsedMs`, so a caller can count work that preceded detection. */
  progressStartedAt?: number;
};

export type DuplicateSimilarityHint = {
  leftFile: string;
  rightFile: string;
  similarityIndex: number;
};

export type DuplicateDetectionOmittedCounts = {
  groups: number;
  rawSuggestions: number;
  oversizedBuckets: number;
  belowThresholdUnits: number;
  /**
   * Candidate pairs left out because their units overlap, counted up to `maxCandidatePairs`. A cross-file run reports
   * none.
   */
  overlappingPairs: number;
  /** Candidate pairs left out of scoring: those past `maxPairs` plus those `maxCandidatePairs` never admitted. */
  candidatePairs: number;
};

export type DuplicateDetectionStats = {
  comparedPairs: number;
  /**
   * Candidate pairs found, never more than `maxCandidatePairs`: those kept for scoring plus those that can never be
   * scored (two units of one file in a cross-file run, or two that overlap).
   */
  candidatePairs: number;
  /** Present only when the candidate pair bound dropped pairs: the bound and the pair occurrences it skipped. */
  candidatePairBudget?: { limit: number; skipped: number };
};

export type DuplicateDetectionFilteredCounts = {
  cleanupProfileGroups: number;
};

export type DuplicateDetectionResult = {
  schemaVersion: 3;
  units: number;
  groups: DuplicateGroup[];
  suggestions?: DuplicateSuggestion[];
  omittedCounts: DuplicateDetectionOmittedCounts;
  filteredCounts?: DuplicateDetectionFilteredCounts;
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

export type UnitCluster = {
  id: string;
  refs: DuplicateUnitRef[];
  primary: DuplicateUnitRef;
};

export type DuplicateInternalUnit = DuplicateUnitRef & {
  id: string;
  absoluteFile: string;
  rawHash: string;
  normalizedHash: string;
  astShapeHash?: string;
  tokenSet: Set<string>;
  signatures: Set<string>;
};

export type DuplicateUnitDraft = Omit<
  DuplicateUnitRef,
  "tokenCount" | "handle" | "fileHandle" | "chunkHandle" | "symbolHandle" | "sqlHandle"
>;

export type PairFilter = (left: DuplicateInternalUnit, right: DuplicateInternalUnit) => boolean;
export type UnitFilter = (unit: DuplicateInternalUnit) => boolean;

export type PairEvidence = {
  left: DuplicateInternalUnit;
  right: DuplicateInternalUnit;
  rawHash: boolean;
  normalizedHash: boolean;
  astShape: boolean;
  gitSimilarity?: number;
  /** The units share enough eligible fingerprint buckets to count as fingerprint evidence. */
  signature: boolean;
  /** How many eligible fingerprint buckets the units share; recorded only when `signature` is set. */
  signatureMatches: number;
};

export type LanguageForFileResult = {
  id: string;
  textOnly: boolean;
};

export type DuplicateAstContext = {
  source: string;
  tree: SyntaxTreeLike;
  lineStartOffsets: number[];
};

export type PreparedDuplicateBuckets = {
  units: readonly DuplicateInternalUnit[];
  rawHashBuckets: Map<string, DuplicateInternalUnit[]>;
  normalizedHashBuckets: Map<string, DuplicateInternalUnit[]>;
  astShapeBuckets: Map<string, DuplicateInternalUnit[]>;
  signatureBuckets: Map<string, DuplicateInternalUnit[]>;
};

export type DuplicateAstContextCache = Map<string, DuplicateAstContext | null>;

export type DuplicateUnitCollectionOptions = Required<
  Pick<DuplicateDetectionOptions, "includeSmall" | "minTokens" | "maxTokens" | "shingleSize" | "windowSize">
> & {
  projectRoot: string | undefined;
  files: readonly string[] | undefined;
};

export type CollectedDuplicateUnits = {
  units: DuplicateInternalUnit[];
  belowThresholdUnits: number;
  belowThresholdUnitsByFile: Map<string, number>;
};

export type DuplicatePreparedAnalysisData = {
  index: ProjectIndex;
  collectionOptions: Omit<DuplicateUnitCollectionOptions, "files">;
  collectedUnits: CollectedDuplicateUnits;
  preparedBuckets: PreparedDuplicateBuckets;
};

export type DuplicatePreparedAnalysis = {
  readonly preparedAnalysisId: symbol;
};

export type DuplicatePreparationOptions = Pick<
  DuplicateDetectionOptions,
  "projectRoot" | "includeSmall" | "minTokens" | "maxTokens" | "shingleSize" | "windowSize"
>;
export type DuplicateSerializedUnit = Omit<DuplicateInternalUnit, "tokenSet" | "signatures"> & {
  tokenSet: string[];
  signatures: string[];
};

export type DuplicateUnitCacheEntry = {
  sig: string;
  units: DuplicateInternalUnit[];
};

export type DuplicateUnitDiskStatements = {
  load: SqliteStatement;
  write: SqliteStatement;
  pruneExpired: SqliteStatement;
  pruneOverflow: SqliteStatement;
};

export type DuplicateUnitDiskDatabaseEntry = {
  db?: SqliteDatabase;
  statements?: DuplicateUnitDiskStatements;
  leases: number;
  closeRequested: boolean;
};

export type DuplicateTargetedResult = DuplicateDetectionResult & {
  perTargetCandidateCounts?: Map<string, number>;
  perTargetComparedCounts?: Map<string, number>;
  perTargetSkippedCandidateCounts?: Map<string, number>;
  perTargetSuggestionKeys?: Map<string, Set<string>>;
};
