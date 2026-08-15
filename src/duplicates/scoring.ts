import { appendToArrayMap } from "../util/collections.js";
import { lineSpan, normalizeDetectionFile, shortHashText } from "./units.js";
import type {
  ConsideredSignaturesByUnit,
  DuplicateCleanupLabel,
  DuplicateCloneType,
  DuplicateClusterSummary,
  DuplicateConfidence,
  DuplicateDetectionOptions,
  DuplicateGroup,
  DuplicateInternalUnit,
  DuplicateMetrics,
  DuplicateSimilarityHint,
  DuplicateSuggestion,
  DuplicateUnitRef,
  PairEvidence,
  PairFilter,
  PreparedDuplicateBuckets,
  UnitCluster,
  UnitFilter,
} from "./types.js";

export const DEFAULT_MIN_TOKENS = 40;
export const DEFAULT_MAX_TOKENS = 800;
export const DEFAULT_LIMIT = 50;
export const DEFAULT_MAX_BUCKET_SIZE = 200;
export const DEFAULT_GROUP_VARIANT_LIMIT = 5;
export const DEFAULT_SHINGLE_SIZE = 5;
export const DEFAULT_WINDOW_SIZE = 4;

export const GROUP_PRIMARY_LENGTH_RATIO_FLOOR = 0.7;
export const NEARBY_CHUNK_VARIANT_MAX_GAP = 2;
export const MIN_SIMILARITY_HINT_INDEX = 80;

export const confidenceRank: Record<DuplicateConfidence, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

export const cloneTypeRank: Record<DuplicateCloneType, number> = {
  weak: 1,
  near: 2,
  renamed: 3,
  exact: 4,
};

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function lineOverlap(
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

function normalizeSimilarityIndex(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const bounded = Math.max(0, Math.min(100, Math.round(value)));
  if (bounded < MIN_SIMILARITY_HINT_INDEX) return undefined;
  return bounded;
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

export function normalizeConfidence(value: DuplicateConfidence | undefined): DuplicateConfidence {
  return value ?? "medium";
}

export function normalizeIntegerOption(
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

export function normalizePositiveIntegerOption(
  value: number | undefined,
  optionName: string,
  fallback: number,
): number {
  return normalizeIntegerOption(value, optionName, fallback, 1, "a positive integer");
}

export function normalizeNonNegativeIntegerOption(
  value: number | undefined,
  optionName: string,
  fallback: number,
): number {
  return normalizeIntegerOption(value, optionName, fallback, 0, "a non-negative integer");
}

export function bestConfidence(left: DuplicateConfidence, right: DuplicateConfidence): DuplicateConfidence {
  if (confidenceRank[left] >= confidenceRank[right]) return left;
  return right;
}

export function bestCloneType(left: DuplicateCloneType, right: DuplicateCloneType): DuplicateCloneType {
  if (cloneTypeRank[left] >= cloneTypeRank[right]) return left;
  return right;
}

export function confidenceForScore(score: number): DuplicateConfidence {
  if (score >= 85) return "high";
  if (score >= 65) return "medium";
  return "low";
}

export function cloneTypeForPair(evidence: PairEvidence, metrics: DuplicateMetrics): DuplicateCloneType {
  if (evidence.rawHash) return "exact";
  if ((evidence.astShape || evidence.normalizedHash) && metrics.tokenJaccard >= 0.75) return "renamed";
  if ((evidence.gitSimilarity ?? 0) >= 80) return "near";
  if (metrics.shingleOverlap >= 0.55 || metrics.tokenJaccard >= 0.72) return "near";
  return "weak";
}

export function shouldScoreSignatureEvidence(evidence: PairEvidence, metrics: DuplicateMetrics): boolean {
  if (!evidence.signature) return false;
  if (evidence.rawHash || evidence.normalizedHash || evidence.astShape || evidence.gitSimilarity !== undefined) {
    return true;
  }
  return metrics.shingleOverlap >= 0.55;
}

export function pairKey(left: DuplicateInternalUnit, right: DuplicateInternalUnit): string {
  if (left.id < right.id) return `${left.id}\u0000${right.id}`;
  return `${right.id}\u0000${left.id}`;
}

export function orderedPair(
  left: DuplicateInternalUnit,
  right: DuplicateInternalUnit,
): [DuplicateInternalUnit, DuplicateInternalUnit] {
  if (left.absoluteFile < right.absoluteFile) return [left, right];
  if (left.absoluteFile > right.absoluteFile) return [right, left];
  if (left.startLine <= right.startLine) return [left, right];
  return [right, left];
}

export function hasLineOverlap(left: DuplicateInternalUnit, right: DuplicateInternalUnit): boolean {
  if (left.absoluteFile !== right.absoluteFile) return false;
  return left.startLine <= right.endLine && right.startLine <= left.endLine;
}
export function addPairEvidence(
  pairs: Map<string, PairEvidence>,
  evidenceKind: "rawHash" | "normalizedHash" | "astShape" | "signature",
  left: DuplicateInternalUnit,
  right: DuplicateInternalUnit,
): void {
  const key = pairKey(left, right);
  const existing = pairs.get(key);
  if (existing) {
    if (evidenceKind === "signature") {
      existing.signatureMatches++;
    } else {
      existing[evidenceKind] = true;
    }
    return;
  }
  pairs.set(key, {
    left,
    right,
    rawHash: evidenceKind === "rawHash",
    normalizedHash: evidenceKind === "normalizedHash",
    astShape: evidenceKind === "astShape",
    signature: false,
    signatureMatches: evidenceKind === "signature" ? 1 : 0,
  });
}

/** Visits every unique pair from one shared-evidence bucket. */
export function forEachBucketPair(
  bucket: readonly DuplicateInternalUnit[],
  pairFilter: PairFilter | undefined,
  unitFilter: UnitFilter | undefined,
  visit: (left: DuplicateInternalUnit, right: DuplicateInternalUnit) => void,
): void {
  if (unitFilter) {
    const targetUnits = bucket.filter(unitFilter);
    const seenPairs = new Set<string>();
    for (const targetUnit of targetUnits) {
      for (const otherUnit of bucket) {
        if (targetUnit.id === otherUnit.id) continue;
        const [left, right] = orderedPair(targetUnit, otherUnit);
        const key = pairKey(left, right);
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        if (pairFilter && !pairFilter(left, right)) continue;
        visit(left, right);
      }
    }
    return;
  }
  for (let i = 0; i < bucket.length; i++) {
    for (let j = i + 1; j < bucket.length; j++) {
      const [left, right] = orderedPair(bucket[i]!, bucket[j]!);
      if (pairFilter && !pairFilter(left, right)) continue;
      visit(left, right);
    }
  }
}

/** Adds every unique pair from one shared-evidence bucket. */
export function addBucketPairs(
  bucket: readonly DuplicateInternalUnit[],
  pairs: Map<string, PairEvidence>,
  evidenceKind: "rawHash" | "normalizedHash" | "astShape" | "signature",
  pairFilter?: PairFilter,
  unitFilter?: UnitFilter,
): void {
  forEachBucketPair(bucket, pairFilter, unitFilter, (left, right) => {
    addPairEvidence(pairs, evidenceKind, left, right);
  });
}

export function bucketPairCountExceeds(
  bucket: readonly DuplicateInternalUnit[],
  limit: number,
  pairFilter: PairFilter,
  unitFilter?: UnitFilter,
): boolean {
  let count = 0;
  const leftUnits = unitFilter ? bucket.filter(unitFilter) : bucket;
  if (!leftUnits.length) return false;
  const seenPairs = new Set<string>();
  for (const leftUnit of leftUnits) {
    for (const rightUnit of bucket) {
      if (leftUnit.id === rightUnit.id) continue;
      const [left, right] = orderedPair(leftUnit, rightUnit);
      const key = pairKey(left, right);
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      if (!pairFilter(left, right)) continue;
      count++;
      if (count > limit) return true;
    }
  }
  return false;
}

/** Adds bounded buckets and counts skipped high-fanout buckets. */
export function addBucketsToPairs(
  buckets: Map<string, DuplicateInternalUnit[]>,
  pairs: Map<string, PairEvidence>,
  evidenceKind: "rawHash" | "normalizedHash" | "astShape" | "signature",
  maxBucketSize: number,
  pairFilter?: PairFilter,
  unitFilter?: UnitFilter,
): number {
  let oversizedBuckets = 0;
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    if (unitFilter && !bucket.some(unitFilter)) continue;
    if (bucket.length > maxBucketSize) {
      if (!pairFilter || bucketPairCountExceeds(bucket, maxBucketSize, pairFilter, unitFilter)) {
        oversizedBuckets++;
        continue;
      }
    }
    addBucketPairs(bucket, pairs, evidenceKind, pairFilter, unitFilter);
  }
  return oversizedBuckets;
}

export function addConsideredSignature(
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

/**
 * Two-pass signature prefilter: count shared fingerprints first, then allocate
 * PairEvidence only for pairs that already have stronger evidence or meet the
 * shared-fingerprint threshold (at least 2).
 */
export function addSignatureBucketsToPairs(
  buckets: Map<string, DuplicateInternalUnit[]>,
  pairs: Map<string, PairEvidence>,
  consideredSignaturesByUnit: ConsideredSignaturesByUnit,
  maxBucketSize: number,
  pairFilter?: PairFilter,
  unitFilter?: UnitFilter,
): number {
  const signatureMatchCounts = new Map<string, number>();
  const signatureMatchUnits = new Map<string, [DuplicateInternalUnit, DuplicateInternalUnit]>();
  let oversizedBuckets = 0;

  for (const [signature, bucket] of buckets) {
    if (bucket.length < 2) continue;
    if (unitFilter && !bucket.some(unitFilter)) continue;
    if (bucket.length > maxBucketSize) {
      if (!pairFilter || bucketPairCountExceeds(bucket, maxBucketSize, pairFilter, unitFilter)) {
        oversizedBuckets++;
        continue;
      }
    }
    for (const unit of bucket) {
      addConsideredSignature(consideredSignaturesByUnit, unit, signature);
    }
    forEachBucketPair(bucket, pairFilter, unitFilter, (left, right) => {
      const key = pairKey(left, right);
      const next = (signatureMatchCounts.get(key) ?? 0) + 1;
      signatureMatchCounts.set(key, next);
      // Threshold floor is >= 2; keep unit refs only once a pair can qualify.
      if (next === 2 && !pairs.has(key) && !signatureMatchUnits.has(key)) {
        signatureMatchUnits.set(key, [left, right]);
      }
    });
  }

  for (const [key, count] of signatureMatchCounts) {
    const existing = pairs.get(key);
    if (existing) {
      existing.signatureMatches = count;
      continue;
    }
    if (count < 2) continue;
    const units = signatureMatchUnits.get(key);
    if (!units) continue;
    const [left, right] = units;
    if (!hasEnoughSharedFingerprintsFor(count, left.id, right.id, consideredSignaturesByUnit)) {
      continue;
    }
    pairs.set(key, {
      left,
      right,
      rawHash: false,
      normalizedHash: false,
      astShape: false,
      signature: false,
      signatureMatches: count,
    });
  }

  return oversizedBuckets;
}

/** Combines exact, normalized, fingerprint, size, and complexity signals. */
export function scorePair(evidence: PairEvidence, metrics: DuplicateMetrics): { score: number; reasons: string[] } {
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
  if (evidence.astShape) {
    score += 40;
    reasons.push("matching AST shape");
  }
  if (evidence.gitSimilarity !== undefined && evidence.gitSimilarity >= 80) {
    score += 20;
    reasons.push(`git similarity ${evidence.gitSimilarity}%`);
  }
  if (shouldScoreSignatureEvidence(evidence, metrics)) {
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

export function metricsForPair(evidence: PairEvidence): DuplicateMetrics {
  const left = evidence.left;
  const right = evidence.right;
  const metrics: DuplicateMetrics = {
    tokenJaccard: jaccard(left.tokenSet, right.tokenSet),
    shingleOverlap: jaccard(left.signatures, right.signatures),
    lengthRatio: ratio(left.tokenCount, right.tokenCount),
    lineSpanRatio: ratio(lineSpan(left), lineSpan(right)),
    ...(evidence.astShape ? { astShapeEqual: true } : {}),
    ...(evidence.gitSimilarity !== undefined ? { gitSimilarity: evidence.gitSimilarity } : {}),
  };
  if (left.complexity !== undefined && right.complexity !== undefined) {
    metrics.complexityDelta = Math.abs(left.complexity - right.complexity);
  }
  return metrics;
}

export function addToBucket(
  buckets: Map<string, DuplicateInternalUnit[]>,
  key: string,
  unit: DuplicateInternalUnit,
): void {
  appendToArrayMap(buckets, key, unit);
}

export function prepareDuplicateCandidateBuckets(units: readonly DuplicateInternalUnit[]): PreparedDuplicateBuckets {
  const rawHashBuckets = new Map<string, DuplicateInternalUnit[]>();
  const normalizedHashBuckets = new Map<string, DuplicateInternalUnit[]>();
  const astShapeBuckets = new Map<string, DuplicateInternalUnit[]>();
  const signatureBuckets = new Map<string, DuplicateInternalUnit[]>();

  for (const unit of units) {
    const languagePrefix = `${unit.languageId}:`;
    addToBucket(rawHashBuckets, `${languagePrefix}${unit.rawHash}`, unit);
    addToBucket(normalizedHashBuckets, `${languagePrefix}${unit.normalizedHash}`, unit);
    if (unit.astShapeHash !== undefined) {
      addToBucket(astShapeBuckets, `${languagePrefix}${unit.astShapeHash}`, unit);
    }
    for (const signature of unit.signatures) {
      addToBucket(signatureBuckets, `${languagePrefix}${signature}`, unit);
    }
  }

  return {
    units,
    rawHashBuckets,
    normalizedHashBuckets,
    astShapeBuckets,
    signatureBuckets,
  };
}

export function filterPreparedDuplicateBucketMap(
  buckets: ReadonlyMap<string, DuplicateInternalUnit[]>,
  unitFilter: UnitFilter,
): Map<string, DuplicateInternalUnit[]> {
  const filteredBuckets = new Map<string, DuplicateInternalUnit[]>();
  for (const [key, bucket] of buckets) {
    const filteredBucket = bucket.filter(unitFilter);
    if (filteredBucket.length) filteredBuckets.set(key, filteredBucket);
  }
  return filteredBuckets;
}

export function filterPreparedDuplicateBuckets(
  preparedBuckets: PreparedDuplicateBuckets,
  unitFilter: UnitFilter,
): PreparedDuplicateBuckets {
  return {
    units: preparedBuckets.units.filter(unitFilter),
    rawHashBuckets: filterPreparedDuplicateBucketMap(preparedBuckets.rawHashBuckets, unitFilter),
    normalizedHashBuckets: filterPreparedDuplicateBucketMap(preparedBuckets.normalizedHashBuckets, unitFilter),
    astShapeBuckets: filterPreparedDuplicateBucketMap(preparedBuckets.astShapeBuckets, unitFilter),
    signatureBuckets: filterPreparedDuplicateBucketMap(preparedBuckets.signatureBuckets, unitFilter),
  };
}

/** Groups units by cheap fingerprints before expensive pair scoring. */
export function buildCandidatePairsFromPreparedBuckets(
  preparedBuckets: PreparedDuplicateBuckets,
  maxBucketSize: number,
  similarityHints: readonly DuplicateSimilarityHint[] | undefined,
  projectRoot: string | undefined,
  pairFilter?: PairFilter,
  unitFilter?: UnitFilter,
): { pairs: Map<string, PairEvidence>; oversizedBuckets: number } {
  const pairs = new Map<string, PairEvidence>();
  const consideredSignaturesByUnit: ConsideredSignaturesByUnit = new Map();
  let oversizedBuckets = 0;
  oversizedBuckets += addBucketsToPairs(
    preparedBuckets.rawHashBuckets,
    pairs,
    "rawHash",
    maxBucketSize,
    pairFilter,
    unitFilter,
  );
  oversizedBuckets += addBucketsToPairs(
    preparedBuckets.normalizedHashBuckets,
    pairs,
    "normalizedHash",
    maxBucketSize,
    pairFilter,
    unitFilter,
  );
  oversizedBuckets += addBucketsToPairs(
    preparedBuckets.astShapeBuckets,
    pairs,
    "astShape",
    maxBucketSize,
    pairFilter,
    unitFilter,
  );
  oversizedBuckets += addSimilarityHintPairs(
    preparedBuckets.units,
    pairs,
    similarityHints,
    projectRoot,
    maxBucketSize,
    pairFilter,
  );
  oversizedBuckets += addSignatureBucketsToPairs(
    preparedBuckets.signatureBuckets,
    pairs,
    consideredSignaturesByUnit,
    maxBucketSize,
    pairFilter,
    unitFilter,
  );
  for (const [key, evidence] of pairs) {
    if (hasEnoughSharedFingerprints(evidence, consideredSignaturesByUnit)) {
      evidence.signature = true;
      continue;
    }
    if (!evidence.rawHash && !evidence.normalizedHash && !evidence.astShape && evidence.gitSimilarity === undefined) {
      pairs.delete(key);
    }
  }
  return { pairs, oversizedBuckets };
}

export function buildCandidatePairs(
  units: readonly DuplicateInternalUnit[],
  maxBucketSize: number,
  similarityHints: readonly DuplicateSimilarityHint[] | undefined,
  projectRoot: string | undefined,
  pairFilter?: PairFilter,
  unitFilter?: UnitFilter,
): { pairs: Map<string, PairEvidence>; oversizedBuckets: number } {
  return buildCandidatePairsFromPreparedBuckets(
    prepareDuplicateCandidateBuckets(units),
    maxBucketSize,
    similarityHints,
    projectRoot,
    pairFilter,
    unitFilter,
  );
}

export function addSimilarityHintPairs(
  units: readonly DuplicateInternalUnit[],
  pairs: Map<string, PairEvidence>,
  similarityHints: readonly DuplicateSimilarityHint[] | undefined,
  projectRoot: string | undefined,
  maxBucketSize: number,
  pairFilter?: PairFilter,
): number {
  if (!similarityHints?.length) return 0;
  const unitsByFile = new Map<string, DuplicateInternalUnit[]>();
  for (const unit of units) {
    const bucket = unitsByFile.get(unit.absoluteFile);
    if (bucket) {
      bucket.push(unit);
    } else {
      unitsByFile.set(unit.absoluteFile, [unit]);
    }
  }

  let oversizedHints = 0;
  for (const hint of similarityHints) {
    const similarityIndex = normalizeSimilarityIndex(hint.similarityIndex);
    if (similarityIndex === undefined) continue;
    const leftFile = normalizeSimilarityHintFile(hint.leftFile, projectRoot);
    const rightFile = normalizeSimilarityHintFile(hint.rightFile, projectRoot);
    if (!leftFile || !rightFile || leftFile === rightFile) continue;
    const leftUnits = unitsByFile.get(leftFile);
    const rightUnits = unitsByFile.get(rightFile);
    if (!leftUnits?.length || !rightUnits?.length) continue;

    if (similarityHintPairCountExceeds(leftUnits, rightUnits, maxBucketSize, pairFilter)) {
      oversizedHints++;
      addAlignedSimilarityHintPairs(pairs, leftUnits, rightUnits, similarityIndex, maxBucketSize, pairFilter);
      continue;
    }
    for (const leftUnit of leftUnits) {
      for (const rightUnit of rightUnits) {
        if (leftUnit.languageId !== rightUnit.languageId) continue;
        const [left, right] = orderedPair(leftUnit, rightUnit);
        if (pairFilter && !pairFilter(left, right)) continue;
        addSimilarityHintPair(pairs, left, right, similarityIndex);
      }
    }
  }
  return oversizedHints;
}

export function similarityHintPairCountExceeds(
  leftUnits: readonly DuplicateInternalUnit[],
  rightUnits: readonly DuplicateInternalUnit[],
  limit: number,
  pairFilter?: PairFilter,
): boolean {
  let count = 0;
  for (const leftUnit of leftUnits) {
    for (const rightUnit of rightUnits) {
      if (leftUnit.languageId !== rightUnit.languageId) continue;
      const [left, right] = orderedPair(leftUnit, rightUnit);
      if (pairFilter && !pairFilter(left, right)) continue;
      count++;
      if (count > limit) return true;
    }
  }
  return false;
}

export function similarityAlignmentKey(unit: DuplicateInternalUnit): string {
  return [unit.languageId, unit.kind, unit.symbolKind ?? ""].join(":");
}

export function addAlignedSimilarityHintPairs(
  pairs: Map<string, PairEvidence>,
  leftUnits: readonly DuplicateInternalUnit[],
  rightUnits: readonly DuplicateInternalUnit[],
  similarityIndex: number,
  maxPairs: number,
  pairFilter?: PairFilter,
): void {
  const rightByKey = new Map<string, DuplicateInternalUnit[]>();
  for (const unit of rightUnits) {
    const key = similarityAlignmentKey(unit);
    const bucket = rightByKey.get(key);
    if (bucket) bucket.push(unit);
    else rightByKey.set(key, [unit]);
  }
  for (const bucket of rightByKey.values()) {
    bucket.sort(compareUnitRefs);
  }

  const leftByKey = new Map<string, DuplicateInternalUnit[]>();
  for (const unit of leftUnits) {
    const key = similarityAlignmentKey(unit);
    const bucket = leftByKey.get(key);
    if (bucket) bucket.push(unit);
    else leftByKey.set(key, [unit]);
  }
  for (const bucket of leftByKey.values()) {
    bucket.sort(compareUnitRefs);
  }

  const seenPairs = new Set<string>();
  let addedPairs = 0;
  for (const [key, sortedLeftUnits] of Array.from(leftByKey.entries()).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const sortedRightUnits = rightByKey.get(key);
    if (!sortedRightUnits?.length) continue;
    const limit = Math.min(sortedLeftUnits.length, sortedRightUnits.length);
    for (let index = 0; index < limit; index++) {
      if (addedPairs >= maxPairs) return;
      const [left, right] = orderedPair(sortedLeftUnits[index]!, sortedRightUnits[index]!);
      const pairId = pairKey(left, right);
      if (seenPairs.has(pairId)) continue;
      seenPairs.add(pairId);
      if (pairFilter && !pairFilter(left, right)) continue;
      addSimilarityHintPair(pairs, left, right, similarityIndex);
      addedPairs++;
    }
  }
}

export function normalizeSimilarityHintFile(file: string, projectRoot: string | undefined): string | undefined {
  try {
    return normalizeDetectionFile(file, projectRoot);
  } catch {
    return undefined;
  }
}

export function addSimilarityHintPair(
  pairs: Map<string, PairEvidence>,
  left: DuplicateInternalUnit,
  right: DuplicateInternalUnit,
  similarityIndex: number,
): void {
  const key = pairKey(left, right);
  const existing = pairs.get(key);
  if (existing) {
    existing.gitSimilarity = Math.max(existing.gitSimilarity ?? 0, similarityIndex);
    return;
  }
  pairs.set(key, {
    left,
    right,
    rawHash: false,
    normalizedHash: false,
    astShape: false,
    gitSimilarity: similarityIndex,
    signature: false,
    signatureMatches: 0,
  });
}

/** Requires enough shared fingerprints to avoid incidental syntax matches. */
export function hasEnoughSharedFingerprintsFor(
  signatureMatches: number,
  leftUnitId: string,
  rightUnitId: string,
  consideredSignaturesByUnit: ConsideredSignaturesByUnit,
): boolean {
  if (!signatureMatches) return false;
  const leftConsideredSignatures = consideredSignaturesByUnit.get(leftUnitId)?.size ?? 0;
  const rightConsideredSignatures = consideredSignaturesByUnit.get(rightUnitId)?.size ?? 0;
  const smallerConsideredSignatureCount = Math.min(leftConsideredSignatures, rightConsideredSignatures);
  if (!smallerConsideredSignatureCount) return false;
  const minimumShared = Math.max(2, Math.ceil(smallerConsideredSignatureCount * 0.25));
  return signatureMatches >= minimumShared;
}

export function hasEnoughSharedFingerprints(
  evidence: PairEvidence,
  consideredSignaturesByUnit: ConsideredSignaturesByUnit,
): boolean {
  return hasEnoughSharedFingerprintsFor(
    evidence.signatureMatches,
    evidence.left.id,
    evidence.right.id,
    consideredSignaturesByUnit,
  );
}

export function suggestionForPair(evidence: PairEvidence): DuplicateSuggestion {
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

export function unitRef(unit: DuplicateInternalUnit): DuplicateUnitRef {
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
    ...(unit.sqlHandle !== undefined ? { sqlHandle: unit.sqlHandle } : {}),
    ...(unit.symbolHandle !== undefined ? { symbolHandle: unit.symbolHandle } : {}),
    ...(unit.name !== undefined ? { name: unit.name } : {}),
    ...(unit.symbolKind !== undefined ? { symbolKind: unit.symbolKind } : {}),
    ...(unit.complexity !== undefined ? { complexity: unit.complexity } : {}),
    ...(unit.looksLikeImportList ? { looksLikeImportList: true } : {}),
    ...(unit.looksLikeBarrel ? { looksLikeBarrel: true } : {}),
  };
}

export function unitRefIdentity(ref: DuplicateUnitRef): string {
  return [ref.file, ref.startLine, ref.endLine, ref.languageId, ref.kind, ref.name ?? "", ref.symbolKind ?? ""].join(
    "\u0000",
  );
}

export function unitRefRangeIdentity(ref: DuplicateUnitRef): string {
  return [ref.file, ref.startLine, ref.endLine, ref.languageId].join("\u0000");
}

export function compareUnitRefs(left: DuplicateUnitRef, right: DuplicateUnitRef): number {
  const fileCompare = left.file.localeCompare(right.file);
  if (fileCompare) return fileCompare;
  const startCompare = left.startLine - right.startLine;
  if (startCompare) return startCompare;
  const endCompare = left.endLine - right.endLine;
  if (endCompare) return endCompare;
  return (left.name ?? "").localeCompare(right.name ?? "");
}

export function unitPrimaryRank(ref: DuplicateUnitRef): number {
  let rank = 0;
  if (ref.kind === "symbol") rank += 8;
  if (ref.name) rank += 4;
  if (ref.symbolKind !== undefined) rank += 2;
  return rank;
}

export function comparePrimaryUnitRefs(left: DuplicateUnitRef, right: DuplicateUnitRef): number {
  const rankCompare = unitPrimaryRank(right) - unitPrimaryRank(left);
  if (rankCompare) return rankCompare;
  const spanCompare = lineSpan(left) - lineSpan(right);
  if (spanCompare) return spanCompare;
  return compareUnitRefs(left, right);
}

export function suggestionPrimaryRank(suggestion: DuplicateSuggestion): number {
  let rank = 0;
  if (suggestion.left.kind === "symbol") rank += 8;
  if (suggestion.right.kind === "symbol") rank += 8;
  if (suggestion.left.name) rank += 2;
  if (suggestion.right.name) rank += 2;
  return rank;
}

export function compareSuggestions(left: DuplicateSuggestion, right: DuplicateSuggestion): number {
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

export function compareSuggestionsForPrimary(left: DuplicateSuggestion, right: DuplicateSuggestion): number {
  const rankCompare = suggestionPrimaryRank(right) - suggestionPrimaryRank(left);
  if (rankCompare) return rankCompare;
  return compareSuggestions(left, right);
}

export function createUnitClusters(refs: readonly DuplicateUnitRef[]): Map<string, UnitCluster> {
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

export function singletonUnitCluster(ref: DuplicateUnitRef): UnitCluster {
  return { id: shortHashText(unitRefIdentity(ref)), refs: [ref], primary: ref };
}

export function orderedGroupKey(left: UnitCluster, right: UnitCluster): string {
  if (left.id < right.id) return `${left.id}\u0000${right.id}`;
  return `${right.id}\u0000${left.id}`;
}

export function orderedUnitPairKey(left: DuplicateUnitRef, right: DuplicateUnitRef): string {
  const leftKey = unitRefIdentity(left);
  const rightKey = unitRefIdentity(right);
  if (leftKey < rightKey) return `${leftKey}\u0000${rightKey}`;
  return `${rightKey}\u0000${leftKey}`;
}

export function orderedUnitRangePairKey(left: DuplicateUnitRef, right: DuplicateUnitRef): string {
  const leftKey = unitRefRangeIdentity(left);
  const rightKey = unitRefRangeIdentity(right);
  if (leftKey < rightKey) return `${leftKey}\u0000${rightKey}`;
  return `${rightKey}\u0000${leftKey}`;
}

export function suggestionVariantKey(suggestion: DuplicateSuggestion): string {
  return [
    orderedUnitPairKey(suggestion.left, suggestion.right),
    suggestion.score,
    suggestion.confidence,
    suggestion.cloneType,
  ].join("\u0000");
}

export function duplicateUnitLineSpan(unit: DuplicateUnitRef): number {
  return Math.max(0, unit.endLine - unit.startLine + 1);
}

export function reducedLinesForPair(left: DuplicateUnitRef, right: DuplicateUnitRef): number {
  return Math.min(duplicateUnitLineSpan(left), duplicateUnitLineSpan(right));
}

export function estimatedLinesSavedForLocations(locations: readonly DuplicateUnitRef[]): number {
  if (locations.length < 2) return 0;
  const spansByFile = new Map<string, Array<{ startLine: number; endLine: number }>>();
  for (const location of locations) {
    appendToArrayMap(spansByFile, location.file, {
      startLine: location.startLine,
      endLine: location.endLine,
    });
  }
  const mergedSpanLengths = Array.from(spansByFile.values()).flatMap((spans) => {
    const sortedSpans = [...spans].sort(
      (left, right) => left.startLine - right.startLine || left.endLine - right.endLine,
    );
    const lengths: number[] = [];
    let currentStart = 0;
    let currentEnd = 0;
    let hasCurrent = false;
    for (const span of sortedSpans) {
      if (!hasCurrent) {
        currentStart = span.startLine;
        currentEnd = span.endLine;
        hasCurrent = true;
        continue;
      }
      if (span.startLine <= currentEnd) {
        currentEnd = Math.max(currentEnd, span.endLine);
        continue;
      }
      lengths.push(Math.max(0, currentEnd - currentStart + 1));
      currentStart = span.startLine;
      currentEnd = span.endLine;
    }
    if (hasCurrent) {
      lengths.push(Math.max(0, currentEnd - currentStart + 1));
    }
    return lengths;
  });
  const total = mergedSpanLengths.reduce((sum, spanLength) => sum + spanLength, 0);
  const max = mergedSpanLengths.reduce((best, spanLength) => Math.max(best, spanLength), 0);
  return Math.max(0, total - max);
}
export function duplicateUnitRefQuality(unit: DuplicateUnitRef): number {
  let score = 0;
  if (unit.kind === "symbol") score += 8;
  if (unit.name) score += 4;
  if (unit.symbolKind !== undefined) score += 2;
  if (unit.symbolHandle !== undefined) score += 1;
  return score;
}

export function preferredDuplicateUnitRef(left: DuplicateUnitRef, right: DuplicateUnitRef): DuplicateUnitRef {
  const qualityDiff = duplicateUnitRefQuality(left) - duplicateUnitRefQuality(right);
  if (qualityDiff > 0) return left;
  if (qualityDiff < 0) return right;
  return compareUnitRefs(left, right) <= 0 ? left : right;
}

export function mergeLocations(locations: Iterable<DuplicateUnitRef>): DuplicateUnitRef[] {
  const locationsByKey = new Map<string, DuplicateUnitRef>();
  for (const location of locations) {
    const key = unitRefRangeIdentity(location);
    const existing = locationsByKey.get(key);
    locationsByKey.set(key, existing ? preferredDuplicateUnitRef(existing, location) : location);
  }

  const merged: DuplicateUnitRef[] = [];
  for (const location of Array.from(locationsByKey.values()).sort(comparePrimaryUnitRefs)) {
    const overlappingIndex = merged.findIndex((existing) => rangesSubstantiallyOverlap(existing, location));
    if (overlappingIndex === -1) {
      merged.push(location);
      continue;
    }
    merged[overlappingIndex] = preferredDuplicateUnitRef(merged[overlappingIndex]!, location);
  }
  return merged.sort(compareUnitRefs);
}

export function groupLocations(group: DuplicateGroup): DuplicateUnitRef[] {
  if (group.locations.length) return [...group.locations].sort(compareUnitRefs);
  return mergeLocations([
    group.primaryLeft,
    group.primaryRight,
    ...group.variants.flatMap((variant) => [variant.left, variant.right]),
  ]);
}

export function locationsForSuggestions(
  primaryLeft: DuplicateUnitRef,
  primaryRight: DuplicateUnitRef,
  suggestions: readonly DuplicateSuggestion[],
): DuplicateUnitRef[] {
  return mergeLocations([
    primaryLeft,
    primaryRight,
    ...suggestions.flatMap((suggestion) => [suggestion.left, suggestion.right]),
  ]);
}

export function commonLocationName(locations: readonly DuplicateUnitRef[]): string | undefined {
  let name: string | undefined;
  for (const location of locations) {
    if (!location.name) return undefined;
    if (name === undefined) {
      name = location.name;
      continue;
    }
    if (name !== location.name) return undefined;
  }
  return name;
}

export function clusterFiles(locations: readonly DuplicateUnitRef[]): string[] {
  return Array.from(new Set(locations.map((location) => location.file))).sort();
}

export function isTestFile(file: string): boolean {
  return (
    file.startsWith("test/") ||
    file.startsWith("tests/") ||
    file.startsWith("spec/") ||
    file.startsWith("specs/") ||
    file.startsWith("__tests__/") ||
    file.includes("/test/") ||
    file.includes("/tests/") ||
    file.includes("/spec/") ||
    file.includes("/specs/") ||
    file.includes("/__tests__/") ||
    /\.test\.[^.]+$/u.test(file) ||
    /\.spec\.[^.]+$/u.test(file)
  );
}

function isProductionFile(file: string): boolean {
  return !isTestFile(file) && (file.startsWith("src/") || file.includes("/src/"));
}

function isTopLevelSourceBarrel(file: string): boolean {
  return /^src\/[^/]+\.ts$/.test(file);
}

export function isFixtureLikeFile(file: string): boolean {
  return (
    file.startsWith("fixtures/") ||
    file.startsWith("samples/") ||
    file.includes("/fixtures/") ||
    file.includes("/samples/") ||
    file.startsWith("tests/languages/") ||
    file.includes("/tests/languages/")
  );
}

export function groupLooksLikeImportListNoise(locations: readonly DuplicateUnitRef[]): boolean {
  if (!locations.length) return false;
  return locations.every((location) => location.looksLikeImportList);
}

export function groupLooksLikeBarrelNoise(locations: readonly DuplicateUnitRef[]): boolean {
  if (!locations.length) return false;
  return locations.every((location) => location.looksLikeBarrel && isTopLevelSourceBarrel(location.file));
}

export function cleanupLabelsForGroup(
  group: DuplicateGroup,
  locations: readonly DuplicateUnitRef[],
): DuplicateCleanupLabel[] {
  const labels = new Set<DuplicateCleanupLabel>();
  const files = clusterFiles(locations);
  const allTests = files.length > 0 && files.every(isTestFile);
  const allProduction = files.length > 0 && files.every(isProductionFile);
  const hasCommonName = commonLocationName(locations) !== undefined;

  if (allTests && (hasCommonName || locations.length >= 3)) labels.add("test-helper-extraction");
  if (allProduction && hasCommonName) labels.add("production-helper-extraction");
  if (files.some(isFixtureLikeFile)) labels.add("fixture-boilerplate");
  if (groupLooksLikeImportListNoise(locations)) labels.add("import-list-noise");
  if (groupLooksLikeBarrelNoise(locations)) labels.add("barrel-export-noise");
  if (group.cloneType !== "exact" && group.metrics.astShapeEqual && group.metrics.tokenJaccard < 0.65) {
    labels.add("type-shape-noise");
  }

  return Array.from(labels).sort();
}
export function isLocationClique(locations: readonly DuplicateUnitRef[], coveredPairs: ReadonlySet<string>): boolean {
  for (let index = 0; index < locations.length; index += 1) {
    const left = locations[index]!;
    for (let otherIndex = index + 1; otherIndex < locations.length; otherIndex += 1) {
      const right = locations[otherIndex]!;
      if (!coveredPairs.has(orderedUnitRangePairKey(left, right))) return false;
    }
  }
  return true;
}

export function groupClusterSummary(
  locations: readonly DuplicateUnitRef[],
  groupIds: readonly string[],
  coveredPairs: ReadonlySet<string>,
): DuplicateClusterSummary | undefined {
  if (locations.length <= 2 && groupIds.length <= 1) return undefined;
  if (!isLocationClique(locations, coveredPairs)) return undefined;
  const label = commonLocationName(locations);
  return {
    id: shortHashText(locations.map(unitRefRangeIdentity).join("\u0000")),
    ...(label !== undefined ? { label } : {}),
    locationCount: locations.length,
    locations: [...locations],
    files: clusterFiles(locations),
    estimatedLinesSaved: estimatedLinesSavedForLocations(locations),
    groupIds: [...groupIds].sort(),
  };
}

export function enrichDuplicateGroups(groups: DuplicateGroup[]): DuplicateGroup[] {
  const locationsByGroupId = new Map<string, DuplicateUnitRef[]>();
  const adjacency = new Map<string, Set<string>>();
  const locationsByKey = new Map<string, DuplicateUnitRef>();
  const coveredPairs = new Set<string>();

  const ensureNode = (location: DuplicateUnitRef) => {
    const key = unitRefRangeIdentity(location);
    locationsByKey.set(key, location);
    if (!adjacency.has(key)) adjacency.set(key, new Set<string>());
    return key;
  };

  for (const group of groups) {
    const locations = groupLocations(group);
    locationsByGroupId.set(group.id, locations);
    const keys = locations.map(ensureNode);
    const firstKey = keys[0];
    if (!firstKey) continue;
    for (const key of keys.slice(1)) {
      adjacency.get(firstKey)?.add(key);
      adjacency.get(key)?.add(firstKey);
    }
    coveredPairs.add(orderedUnitRangePairKey(group.primaryLeft, group.primaryRight));
    for (const variant of group.variants) {
      coveredPairs.add(orderedUnitRangePairKey(variant.left, variant.right));
    }
  }

  const componentByKey = new Map<string, DuplicateUnitRef[]>();
  const componentIdByKey = new Map<string, string>();
  const groupIdsByComponentId = new Map<string, string[]>();
  const visited = new Set<string>();
  for (const key of Array.from(adjacency.keys()).sort()) {
    if (visited.has(key)) continue;
    const stack = [key];
    const componentKeys: string[] = [];
    visited.add(key);
    while (stack.length) {
      const current = stack.pop()!;
      componentKeys.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        stack.push(next);
      }
    }
    const locations = componentKeys
      .map((componentKey) => locationsByKey.get(componentKey))
      .filter((location): location is DuplicateUnitRef => location !== undefined)
      .sort(compareUnitRefs);
    const componentId = shortHashText(componentKeys.sort().join("\u0000"));
    for (const componentKey of componentKeys) {
      componentByKey.set(componentKey, locations);
      componentIdByKey.set(componentKey, componentId);
    }
  }

  for (const group of groups) {
    const componentId = componentIdByKey.get(unitRefRangeIdentity(group.primaryLeft));
    if (!componentId) continue;
    appendToArrayMap(groupIdsByComponentId, componentId, group.id);
  }

  return groups.map((group) => {
    const localLocations = locationsByGroupId.get(group.id) ?? groupLocations(group);
    const primaryKey = unitRefRangeIdentity(group.primaryLeft);
    const componentLocations = componentByKey.get(primaryKey) ?? localLocations;
    const componentId = componentIdByKey.get(primaryKey);
    const groupIds = componentId
      ? Array.from(new Set(groupIdsByComponentId.get(componentId) ?? [group.id])).sort()
      : [group.id];
    const cluster = groupClusterSummary(componentLocations, groupIds, coveredPairs);
    const cleanupLabels = cleanupLabelsForGroup(group, localLocations);
    if (!cleanupLabels.includes("test-helper-extraction") && cluster) {
      if (cluster.files.length && cluster.files.every(isTestFile) && cluster.locationCount >= 3) {
        cleanupLabels.push("test-helper-extraction");
        cleanupLabels.sort();
      }
    }
    return {
      ...group,
      locations: localLocations,
      reducedLines: reducedLinesForPair(group.primaryLeft, group.primaryRight),
      estimatedLinesSaved: estimatedLinesSavedForLocations(localLocations),
      cleanupLabels,
      ...(cluster !== undefined ? { cluster } : {}),
    };
  });
}

export function mergeReasonLists(reasonLists: Iterable<readonly string[]>): string[] {
  const reasons = new Set<string>();
  for (const reasonList of reasonLists) {
    for (const reason of reasonList) reasons.add(reason);
  }
  return Array.from(reasons).sort();
}

export function mergeReasons(suggestions: readonly DuplicateSuggestion[]): string[] {
  return mergeReasonLists(suggestions.map((suggestion) => suggestion.reasons));
}

export function mergeGroupReasons(groups: readonly DuplicateGroup[]): string[] {
  return mergeReasonLists(groups.map((group) => group.reasons));
}

export function groupForSuggestions(
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
  const primaryLengthRatio = ratio(primary.left.tokenCount, primary.right.tokenCount);
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
    primaryLeft: primary.left,
    primaryRight: primary.right,
    locations: locationsForSuggestions(primary.left, primary.right, suggestions),
    reducedLines: reducedLinesForPair(primary.left, primary.right),
    estimatedLinesSaved: reducedLinesForPair(primary.left, primary.right),
    cleanupLabels: [],
    variants,
    variantCount: variants.length,
    rawPairCount: suggestions.length,
    omittedVariantCount: Math.max(0, suggestions.length - variants.length),
    metrics: primary.metrics,
    reasons,
  };
}

export function compareGroups(left: DuplicateGroup, right: DuplicateGroup): number {
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

export function coalesceDuplicateGroups(groups: DuplicateGroup[], variantLimit: number): DuplicateGroup[] {
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
      locations: mergeLocations(grouped.flatMap((group) => group.locations)),
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

export function groupSuggestions(
  suggestions: readonly DuplicateSuggestion[],
  includeRawPairs: boolean,
): DuplicateGroup[] {
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
  return enrichDuplicateGroups(coalesceDuplicateGroups(groups, variantLimit));
}
