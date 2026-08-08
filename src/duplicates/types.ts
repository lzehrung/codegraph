import type { SyntaxTreeLike } from "../languages/types.js";
import type { ProjectIndex, SymbolKind } from "../indexer/types.js";
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
  shingleSize?: number;
  windowSize?: number;
  includeRawPairs?: boolean;
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
  overlappingPairs: number;
  candidatePairs: number;
};

export type DuplicateDetectionStats = {
  comparedPairs: number;
  candidatePairs: number;
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
  signature: boolean;
  signatureMatches: number;
};

export type LanguageForFileResult = {
  id: string;
  textOnly: boolean;
};

export type ConsideredSignaturesByUnit = Map<string, Set<string>>;

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

