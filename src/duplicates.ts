import { normalizePath, toProjectDisplayPath } from "./util/paths.js";
import type { ProjectIndex } from "./indexer/types.js";
import * as duplicateUnits from "./duplicates/units.js";
import * as duplicateCandidates from "./duplicates/candidates.js";
import * as duplicateScoring from "./duplicates/scoring.js";
import * as duplicateUnitCache from "./duplicates/unit-cache.js";
import {
  DUPLICATE_STAGE_GROUPING,
  DUPLICATE_STAGE_PAIRS,
  DUPLICATE_STAGE_SCORING,
  DUPLICATE_STAGE_UNITS,
  createDuplicateProgress,
  type DuplicateProgress,
} from "./duplicates/progress.js";
import type {
  CollectedDuplicateUnits,
  DuplicateContextResult,
  DuplicateDetectionOptions,
  DuplicateDetectionResult,
  DuplicateDetectionStats,
  DuplicateGroup,
  DuplicateInternalUnit,
  DuplicatePreparedAnalysis,
  DuplicatePreparedAnalysisData,
  DuplicatePreparationOptions,
  DuplicateSuggestion,
  DuplicateTarget,
  DuplicateTargetedResult,
  DuplicateUnitCollectionOptions,
  DuplicateUnitRef,
  PairEvidence,
  PairFilter,
  PreparedDuplicateBuckets,
  UnitFilter,
} from "./duplicates/types.js";

const { collectDuplicateUnits, normalizeDetectionFile } = duplicateUnits;
const { buildCandidatePairs, filterPreparedDuplicateBuckets, prepareDuplicateCandidateBuckets } = duplicateCandidates;
const {
  DEFAULT_GROUP_VARIANT_LIMIT,
  DEFAULT_LIMIT,
  DEFAULT_MAX_BUCKET_SIZE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MIN_TOKENS,
  DEFAULT_SHINGLE_SIZE,
  DEFAULT_WINDOW_SIZE,
  compareSuggestions,
  confidenceRank,
  groupSuggestions,
  lineOverlap,
  normalizeConfidence,
  normalizeMaxCandidatePairsOption,
  normalizeNonNegativeIntegerOption,
  normalizePositiveIntegerOption,
  suggestionForPair,
  suggestionVariantKey,
} = duplicateScoring;
const { closeDuplicateUnitCacheForIndex, leaseDuplicateUnitCacheForIndex, maintainDuplicateUnitDiskCache } =
  duplicateUnitCache;

const duplicatePreparedAnalyses = new WeakMap<DuplicatePreparedAnalysis, DuplicatePreparedAnalysisData>();

export async function findDuplicates(
  index: ProjectIndex,
  options: DuplicateDetectionOptions = {},
): Promise<DuplicateDetectionResult> {
  const releaseDuplicateUnitCache = leaseDuplicateUnitCacheForIndex(index);
  try {
    return await findDuplicatesWithOpenDuplicateUnitCache(index, options);
  } finally {
    maintainDuplicateUnitDiskCache(index);
    closeDuplicateUnitCacheForIndex(index);
    releaseDuplicateUnitCache();
  }
}

type CandidateCollection = {
  unitCount: number;
  belowThresholdUnits: number;
  pairs: Map<number, PairEvidence>;
  oversizedBuckets: number;
  skippedPairs: number;
  unscorablePairs: number;
  overlappingPairs: number;
};

type CandidatePairBudget = NonNullable<DuplicateDetectionStats["candidatePairBudget"]>;

/**
 * The candidate pairs a result leaves out of scoring: the pairs `maxPairs` left uncompared plus the pair
 * occurrences `maxCandidatePairs` never admitted. Every path that consumes either bound reports them here,
 * so a whole-project result and a target's context count the skips alike.
 */
function omittedCandidatePairs(uncomparedPairs: number, budget: CandidatePairBudget | undefined): number {
  return uncomparedPairs + (budget?.skipped ?? 0);
}

/**
 * The candidate pairs a result reports as found: those kept for scoring plus those that can never be scored. The count
 * is capped at the bound, so it never exceeds `maxCandidatePairs`.
 */
function foundCandidatePairs(keptPairs: number, unscorablePairs: number, maxCandidatePairs: number): number {
  return Math.min(maxCandidatePairs, keptPairs + unscorablePairs);
}

/**
 * Collects the duplicate units and pairs them. The units and their fingerprint buckets stay local to
 * this call, so a full run can release them before the pairs are scored and grouped.
 */
async function collectCandidatePairs(
  index: ProjectIndex,
  options: DuplicateDetectionOptions,
  collectionOptions: DuplicateUnitCollectionOptions,
  preparedData: DuplicatePreparedAnalysisData | undefined,
  limits: { maxBucketSize: number; maxCandidatePairs: number; crossFileOnly: boolean },
  progress: DuplicateProgress | undefined,
): Promise<CandidateCollection> {
  const collectedUnits =
    preparedData?.collectedUnits ?? (await collectDuplicateUnits(index, collectionOptions, progress));
  let units = collectedUnits.units;
  let belowThresholdUnits = collectedUnits.belowThresholdUnits;
  let candidateBuckets = preparedData?.preparedBuckets;
  if (candidateBuckets && collectionOptions.files !== undefined) {
    const scopedFiles = new Set(
      collectionOptions.files.map((file) => normalizeDetectionFile(file, collectionOptions.projectRoot)),
    );
    const scopedUnitFilter: UnitFilter = (unit) => scopedFiles.has(unit.absoluteFile);
    candidateBuckets = filterPreparedDuplicateBuckets(candidateBuckets, scopedUnitFilter);
    units = [...candidateBuckets.units];
    belowThresholdUnits = 0;
    for (const file of scopedFiles) {
      belowThresholdUnits += collectedUnits.belowThresholdUnitsByFile.get(file) ?? 0;
    }
  }
  progress?.stage(DUPLICATE_STAGE_PAIRS);
  const { pairs, oversizedBuckets, skippedPairs, unscorablePairs, overlappingPairs } = await buildCandidatePairs(
    candidateBuckets ?? prepareDuplicateCandidateBuckets(units),
    {
      ...limits,
      similarityHints: options.similarityHints,
      projectRoot: collectionOptions.projectRoot,
      onFingerprintProgress: progress
        ? (current, total) => progress.stage(DUPLICATE_STAGE_PAIRS, current, total, "unit")
        : undefined,
      yieldPoint: progress?.yieldPoint,
    },
  );
  return {
    unitCount: units.length,
    belowThresholdUnits,
    pairs,
    oversizedBuckets,
    skippedPairs,
    unscorablePairs,
    overlappingPairs,
  };
}

/** Finds scored duplicate candidates from an already-built project index. */
async function findDuplicatesWithOpenDuplicateUnitCache(
  index: ProjectIndex,
  options: DuplicateDetectionOptions = {},
  preparedData?: DuplicatePreparedAnalysisData,
): Promise<DuplicateDetectionResult> {
  const collectionOptions = duplicateUnitCollectionOptions(index, options);
  const maxBucketSize = normalizePositiveIntegerOption(options.maxBucketSize, "maxBucketSize", DEFAULT_MAX_BUCKET_SIZE);
  const maxCandidatePairs = normalizeMaxCandidatePairsOption(options.maxCandidatePairs);
  const maxPairs =
    options.maxPairs === undefined
      ? Number.POSITIVE_INFINITY
      : normalizeNonNegativeIntegerOption(options.maxPairs, "maxPairs", DEFAULT_LIMIT);
  const crossFileOnly = options.crossFileOnly ?? !(options.includeSameFile ?? false);
  const minConfidence = normalizeConfidence(options.minConfidence);
  const limit = normalizeNonNegativeIntegerOption(options.limit, "limit", DEFAULT_LIMIT);
  const progress = createDuplicateProgress(options.onProgress, options.progressStartedAt);
  progress?.stage(preparedData ? DUPLICATE_STAGE_PAIRS : DUPLICATE_STAGE_UNITS);
  const { unitCount, belowThresholdUnits, pairs, oversizedBuckets, skippedPairs, unscorablePairs, overlappingPairs } =
    await collectCandidatePairs(
      index,
      options,
      collectionOptions,
      preparedData,
      { maxBucketSize, maxCandidatePairs, crossFileOnly },
      progress,
    );
  // The builder keeps only pairs the scorers can score. Pairs they can never score still count as candidates found.
  const scorablePairCount = pairs.size;
  const candidatePairCount = foundCandidatePairs(scorablePairCount, unscorablePairs, maxCandidatePairs);
  const candidatePairBudget = skippedPairs ? { limit: maxCandidatePairs, skipped: skippedPairs } : undefined;
  if (options.countOnly) {
    const groupCount = countCandidateDuplicateGroups(pairs);
    progress?.complete(unitCount);
    return {
      schemaVersion: 3,
      units: unitCount,
      groups: [],
      omittedCounts: {
        groups: groupCount,
        rawSuggestions: 0,
        oversizedBuckets,
        belowThresholdUnits,
        overlappingPairs: 0,
        candidatePairs: omittedCandidatePairs(pairs.size, candidatePairBudget),
      },
      stats: {
        comparedPairs: 0,
        candidatePairs: candidatePairCount,
        ...(candidatePairBudget ? { candidatePairBudget } : {}),
      },
    };
  }
  const suggestions: DuplicateSuggestion[] = [];
  let comparedPairs = 0;
  let skippedCandidatePairs = 0;

  progress?.stage(DUPLICATE_STAGE_SCORING, 0, scorablePairCount, "pair");
  const reportEvery = Math.max(1, Math.floor(scorablePairCount / 100));
  let visitedPairs = 0;
  for (const evidence of pairs.values()) {
    visitedPairs++;
    if (progress && visitedPairs % reportEvery === 0) {
      progress.stage(DUPLICATE_STAGE_SCORING, visitedPairs, scorablePairCount, "pair");
      const pending = progress.yieldPoint();
      if (pending) await pending;
    }
    if (comparedPairs >= maxPairs) {
      skippedCandidatePairs++;
      continue;
    }

    comparedPairs++;
    const suggestion = suggestionForPair(evidence);

    if (confidenceRank[suggestion.confidence] < confidenceRank[minConfidence]) continue;
    suggestions.push(suggestion);
  }
  pairs.clear();

  progress?.stage(DUPLICATE_STAGE_GROUPING);
  suggestions.sort(compareSuggestions);

  const includeRawPairs = options.includeRawPairs ?? false;
  const groups = groupSuggestions(suggestions, includeRawPairs).filter(
    (group) => confidenceRank[group.confidence] >= confidenceRank[minConfidence],
  );
  const limitedGroups = groups.slice(0, limit);
  const omittedGroups = Math.max(0, groups.length - limitedGroups.length);
  const limitedRawSuggestions = includeRawPairs ? suggestions.slice(0, limit) : [];
  const result: DuplicateDetectionResult = {
    schemaVersion: 3,
    units: unitCount,
    groups: limitedGroups,
    omittedCounts: {
      groups: omittedGroups,
      rawSuggestions: Math.max(0, suggestions.length - limitedRawSuggestions.length),
      oversizedBuckets,
      belowThresholdUnits,
      overlappingPairs,
      candidatePairs: omittedCandidatePairs(skippedCandidatePairs, candidatePairBudget),
    },
    stats: {
      comparedPairs,
      candidatePairs: candidatePairCount,
      ...(candidatePairBudget ? { candidatePairBudget } : {}),
    },
  };
  if (includeRawPairs) {
    result.suggestions = limitedRawSuggestions;
  }
  progress?.complete(unitCount);
  return result;
}

function countCandidateDuplicateGroups(pairs: ReadonlyMap<number, PairEvidence>): number {
  const parents = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    for (;;) {
      const parent = parents.get(root);
      if (!parent || parent === root) break;
      root = parent;
    }
    let current = id;
    while (current !== root) {
      const next = parents.get(current)!;
      parents.set(current, root);
      current = next;
    }
    return root;
  };
  const join = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    parents.set(leftRoot, rightRoot);
  };

  for (const evidence of pairs.values()) {
    parents.set(evidence.left.id, parents.get(evidence.left.id) ?? evidence.left.id);
    parents.set(evidence.right.id, parents.get(evidence.right.id) ?? evidence.right.id);
    join(evidence.left.id, evidence.right.id);
  }
  return new Set(Array.from(parents, ([id]) => find(id))).size;
}

function normalizeDuplicateTarget(target: DuplicateTarget, projectRoot: string | undefined): DuplicateTarget {
  const normalizedFile = projectRoot
    ? toProjectDisplayPath(projectRoot, target.file)
    : normalizePath(target.file).replace(/^\.\//, "");
  return {
    file: normalizedFile,
    ...(target.startLine !== undefined ? { startLine: target.startLine } : {}),
    ...(target.endLine !== undefined ? { endLine: target.endLine } : {}),
  };
}

function duplicateTargetKey(target: DuplicateTarget): string {
  return [target.file, target.startLine ?? "", target.endLine ?? ""].join("\u0000");
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

function boundDuplicateGroupVariants(
  group: DuplicateGroup,
  target: DuplicateTarget,
  includeRawPairs: boolean,
): DuplicateGroup {
  if (includeRawPairs) return group;
  let variants = group.variants;
  if (
    !unitTouchesDuplicateTarget(group.primaryLeft, target) &&
    !unitTouchesDuplicateTarget(group.primaryRight, target)
  ) {
    const targetVariant = group.variants.find((variant) => suggestionTouchesDuplicateTarget(variant, target));
    if (targetVariant) {
      const targetVariantKey = suggestionVariantKey(targetVariant);
      variants = [
        targetVariant,
        ...group.variants.filter((variant) => suggestionVariantKey(variant) !== targetVariantKey),
      ];
    }
  }
  variants = variants.slice(0, DEFAULT_GROUP_VARIANT_LIMIT);
  return {
    ...group,
    variants,
    variantCount: variants.length,
    omittedVariantCount: Math.max(0, group.variants.length - variants.length),
  };
}
function duplicateContextFromResult(
  result: DuplicateTargetedResult,
  target: DuplicateTarget,
  options: { projectRoot: string | undefined; limit: number; includeRawPairs: boolean },
): DuplicateContextResult {
  const normalizedTarget = normalizeDuplicateTarget(target, options.projectRoot);
  const targetSuggestionKeys = result.perTargetSuggestionKeys?.get(duplicateTargetKey(normalizedTarget));
  const targetSuggestions = (result.suggestions ?? []).filter((suggestion) => {
    if (!suggestionTouchesDuplicateTarget(suggestion, normalizedTarget)) return false;
    return !targetSuggestionKeys || targetSuggestionKeys.has(suggestionVariantKey(suggestion));
  });
  const groups = groupSuggestions(targetSuggestions, true);
  const limitedGroups = groups
    .slice(0, options.limit)
    .map((group) => boundDuplicateGroupVariants(group, normalizedTarget, options.includeRawPairs));
  const omittedGroups = Math.max(0, groups.length - limitedGroups.length);
  const rawSuggestions = options.includeRawPairs ? targetSuggestions : [];
  const limitedRawSuggestions = rawSuggestions.slice(0, options.limit);
  const context: DuplicateContextResult = {
    schemaVersion: result.schemaVersion,
    units: result.units,
    target: normalizedTarget,
    groups: limitedGroups,
    omittedCounts: {
      ...result.omittedCounts,
      groups: omittedGroups,
      rawSuggestions: Math.max(0, rawSuggestions.length - limitedRawSuggestions.length),
      // The pair limit is shared by every target of one call, so each context carries the whole call's skips,
      // as it carries the call's `oversizedBuckets` and `overlappingPairs`.
      candidatePairs: omittedCandidatePairs(
        result.perTargetSkippedCandidateCounts?.get(duplicateTargetKey(normalizedTarget)) ?? 0,
        result.stats.candidatePairBudget,
      ),
    },
    stats: {
      ...result.stats,
      candidatePairs: result.perTargetCandidateCounts?.get(duplicateTargetKey(normalizedTarget)) ?? 0,
      comparedPairs: result.perTargetComparedCounts?.get(duplicateTargetKey(normalizedTarget)) ?? 0,
    },
  };
  if (options.includeRawPairs) {
    context.suggestions = limitedRawSuggestions;
  } else {
    delete context.suggestions;
  }
  return context;
}

function duplicateUnitCollectionOptions(
  index: ProjectIndex,
  options: DuplicateDetectionOptions,
): DuplicateUnitCollectionOptions {
  const projectRoot = options.projectRoot ?? index.projectRoot;
  const minTokens = normalizePositiveIntegerOption(options.minTokens, "minTokens", DEFAULT_MIN_TOKENS);
  const maxTokens = normalizePositiveIntegerOption(options.maxTokens, "maxTokens", DEFAULT_MAX_TOKENS);
  const shingleSize = normalizePositiveIntegerOption(options.shingleSize, "shingleSize", DEFAULT_SHINGLE_SIZE);
  const windowSize = normalizePositiveIntegerOption(options.windowSize, "windowSize", DEFAULT_WINDOW_SIZE);
  const includeSmall = options.includeSmall ?? false;

  if (maxTokens < minTokens) {
    throw new Error(`Invalid maxTokens value "${maxTokens}". Expected a value greater than or equal to minTokens.`);
  }

  return {
    projectRoot,
    files: options.files,
    includeSmall,
    minTokens,
    maxTokens,
    shingleSize,
    windowSize,
  };
}

async function collectDuplicateUnitsForOptions(
  index: ProjectIndex,
  options: DuplicateDetectionOptions,
): Promise<CollectedDuplicateUnits> {
  return await collectDuplicateUnits(index, duplicateUnitCollectionOptions(index, options));
}

function preparedDuplicateAnalysisData(analysis: DuplicatePreparedAnalysis): DuplicatePreparedAnalysisData {
  const data = duplicatePreparedAnalyses.get(analysis);
  if (!data) {
    throw new Error("Invalid duplicate prepared analysis.");
  }
  return data;
}

function assertPreparedDuplicateOptions(data: DuplicatePreparedAnalysisData, options: DuplicateDetectionOptions): void {
  const normalized = duplicateUnitCollectionOptions(data.index, options);
  const expected = data.collectionOptions;
  const sameProjectRoot = normalizePath(normalized.projectRoot ?? "") === normalizePath(expected.projectRoot ?? "");
  if (
    !sameProjectRoot ||
    normalized.includeSmall !== expected.includeSmall ||
    normalized.minTokens !== expected.minTokens ||
    normalized.maxTokens !== expected.maxTokens ||
    normalized.shingleSize !== expected.shingleSize ||
    normalized.windowSize !== expected.windowSize
  ) {
    throw new Error("Duplicate query options do not match the prepared analysis.");
  }
}

/** Collects duplicate units and candidate buckets once for multiple review queries. */
export async function prepareDuplicateAnalysis(
  index: ProjectIndex,
  options: DuplicatePreparationOptions = {},
): Promise<DuplicatePreparedAnalysis> {
  const collectionOptions = duplicateUnitCollectionOptions(index, options);
  const releaseDuplicateUnitCache = leaseDuplicateUnitCacheForIndex(index);
  try {
    const collectedUnits = await collectDuplicateUnits(index, collectionOptions);
    const analysis = Object.freeze({ preparedAnalysisId: Symbol("duplicate-prepared-analysis") });
    duplicatePreparedAnalyses.set(analysis, {
      index,
      collectionOptions: {
        projectRoot: collectionOptions.projectRoot,
        includeSmall: collectionOptions.includeSmall,
        minTokens: collectionOptions.minTokens,
        maxTokens: collectionOptions.maxTokens,
        shingleSize: collectionOptions.shingleSize,
        windowSize: collectionOptions.windowSize,
      },
      collectedUnits,
      preparedBuckets: prepareDuplicateCandidateBuckets(collectedUnits.units),
    });
    return analysis;
  } finally {
    maintainDuplicateUnitDiskCache(index);
    closeDuplicateUnitCacheForIndex(index);
    releaseDuplicateUnitCache();
  }
}

/** Scores duplicate groups from a previously collected and bucketed analysis. */
export async function findDuplicatesWithPreparedAnalysis(
  analysis: DuplicatePreparedAnalysis,
  options: DuplicateDetectionOptions = {},
): Promise<DuplicateDetectionResult> {
  const data = preparedDuplicateAnalysisData(analysis);
  assertPreparedDuplicateOptions(data, options);
  return await findDuplicatesWithOpenDuplicateUnitCache(data.index, options, data);
}

async function findDuplicatesTouchingTargets(
  index: ProjectIndex,
  targets: readonly DuplicateTarget[],
  options: DuplicateDetectionOptions,
  collectedUnits?: CollectedDuplicateUnits,
  preparedBuckets?: PreparedDuplicateBuckets,
): Promise<DuplicateTargetedResult> {
  const projectRoot = options.projectRoot ?? index.projectRoot;
  const normalizedTargets = targets.map((target) => normalizeDuplicateTarget(target, projectRoot));
  const maxBucketSize = normalizePositiveIntegerOption(options.maxBucketSize, "maxBucketSize", DEFAULT_MAX_BUCKET_SIZE);
  const maxCandidatePairs = normalizeMaxCandidatePairsOption(options.maxCandidatePairs);
  const maxPairs =
    options.maxPairs === undefined
      ? Number.POSITIVE_INFINITY
      : normalizeNonNegativeIntegerOption(options.maxPairs, "maxPairs", DEFAULT_LIMIT);
  const crossFileOnly = options.crossFileOnly ?? !(options.includeSameFile ?? false);
  const minConfidence = normalizeConfidence(options.minConfidence);
  const { units, belowThresholdUnits } = collectedUnits ?? (await collectDuplicateUnitsForOptions(index, options));
  const touchesTarget: UnitFilter = (unit) =>
    normalizedTargets.some((target) => unitTouchesDuplicateTarget(unit, target));
  const targetCandidateCounts = new Map<string, number>();
  const targetCompareCounts = new Map<string, number>();
  const targetSkippedCandidateCounts = new Map<string, number>();
  const targetSuggestionKeys = new Map<string, Set<string>>();
  for (const target of normalizedTargets) {
    targetSuggestionKeys.set(duplicateTargetKey(target), new Set());
  }
  const targetsTouchedByPair = (left: DuplicateInternalUnit, right: DuplicateInternalUnit): DuplicateTarget[] =>
    normalizedTargets.filter(
      (target) => unitTouchesDuplicateTarget(left, target) || unitTouchesDuplicateTarget(right, target),
    );
  const touchesAnyTarget: PairFilter = (left, right) => targetsTouchedByPair(left, right).length > 0;
  const { pairs, oversizedBuckets, skippedPairs, unscorablePairs, overlappingPairs } = await buildCandidatePairs(
    preparedBuckets ?? prepareDuplicateCandidateBuckets(units),
    {
      maxBucketSize,
      maxCandidatePairs,
      crossFileOnly,
      similarityHints: options.similarityHints,
      projectRoot,
      filter: { unit: touchesTarget, pair: touchesAnyTarget },
    },
  );
  const candidatePairBudget = skippedPairs ? { limit: maxCandidatePairs, skipped: skippedPairs } : undefined;
  const suggestions: DuplicateSuggestion[] = [];
  let comparedPairs = 0;
  let skippedCandidatePairs = 0;

  for (const evidence of pairs.values()) {
    const touchedTargets = targetsTouchedByPair(evidence.left, evidence.right);
    if (!touchedTargets.length) continue;
    for (const target of touchedTargets) {
      const key = duplicateTargetKey(target);
      targetCandidateCounts.set(key, (targetCandidateCounts.get(key) ?? 0) + 1);
    }
    const eligibleTargets: DuplicateTarget[] = [];
    for (const target of touchedTargets) {
      const key = duplicateTargetKey(target);
      if ((targetCompareCounts.get(key) ?? 0) < maxPairs) {
        eligibleTargets.push(target);
      } else {
        targetSkippedCandidateCounts.set(key, (targetSkippedCandidateCounts.get(key) ?? 0) + 1);
      }
    }
    if (!eligibleTargets.length) {
      skippedCandidatePairs++;
      continue;
    }

    comparedPairs++;
    for (const target of eligibleTargets) {
      const key = duplicateTargetKey(target);
      targetCompareCounts.set(key, (targetCompareCounts.get(key) ?? 0) + 1);
    }

    const suggestion = suggestionForPair(evidence);
    if (confidenceRank[suggestion.confidence] < confidenceRank[minConfidence]) continue;
    const suggestionKey = suggestionVariantKey(suggestion);
    for (const target of eligibleTargets) {
      const key = duplicateTargetKey(target);
      const keys = targetSuggestionKeys.get(key);
      if (keys) keys.add(suggestionKey);
      else targetSuggestionKeys.set(key, new Set([suggestionKey]));
    }
    suggestions.push(suggestion);
  }

  suggestions.sort(compareSuggestions);
  return {
    schemaVersion: 3,
    units: units.length,
    groups: [],
    suggestions,
    omittedCounts: {
      groups: 0,
      rawSuggestions: 0,
      oversizedBuckets,
      belowThresholdUnits,
      overlappingPairs,
      candidatePairs: omittedCandidatePairs(skippedCandidatePairs, candidatePairBudget),
    },
    stats: {
      comparedPairs,
      candidatePairs: foundCandidatePairs(pairs.size, unscorablePairs, maxCandidatePairs),
      ...(candidatePairBudget ? { candidatePairBudget } : {}),
    },
    perTargetCandidateCounts: targetCandidateCounts,
    perTargetComparedCounts: targetCompareCounts,
    perTargetSkippedCandidateCounts: targetSkippedCandidateCounts,
    perTargetSuggestionKeys: targetSuggestionKeys,
  };
}

export async function findDuplicateContexts(
  index: ProjectIndex,
  targets: readonly DuplicateTarget[],
  options: DuplicateDetectionOptions = {},
): Promise<DuplicateContextResult[]> {
  const releaseDuplicateUnitCache = leaseDuplicateUnitCacheForIndex(index);
  try {
    return await findDuplicateContextsWithOpenDuplicateUnitCache(index, targets, options);
  } finally {
    maintainDuplicateUnitDiskCache(index);
    closeDuplicateUnitCacheForIndex(index);
    releaseDuplicateUnitCache();
  }
}

async function findDuplicateContextsWithOpenDuplicateUnitCache(
  index: ProjectIndex,
  targets: readonly DuplicateTarget[],
  options: DuplicateDetectionOptions = {},
  preparedData?: DuplicatePreparedAnalysisData,
): Promise<DuplicateContextResult[]> {
  if (!targets.length) return [];
  const limit = normalizeNonNegativeIntegerOption(options.limit, "limit", DEFAULT_LIMIT);
  const includeRawPairs = options.includeRawPairs ?? false;
  const projectRoot = options.projectRoot ?? index.projectRoot;
  const sharedUnits = preparedData?.collectedUnits ?? (await collectDuplicateUnitsForOptions(index, options));
  const preparedBuckets = preparedData?.preparedBuckets ?? prepareDuplicateCandidateBuckets(sharedUnits.units);
  const result = await findDuplicatesTouchingTargets(
    index,
    targets,
    {
      ...options,
      minConfidence: options.minConfidence ?? "medium",
    },
    sharedUnits,
    preparedBuckets,
  );
  return targets.map((target) => duplicateContextFromResult(result, target, { projectRoot, limit, includeRawPairs }));
}

/** Finds targeted duplicate contexts from a previously collected and bucketed analysis. */
export async function findDuplicateContextsWithPreparedAnalysis(
  analysis: DuplicatePreparedAnalysis,
  targets: readonly DuplicateTarget[],
  options: DuplicateDetectionOptions = {},
): Promise<DuplicateContextResult[]> {
  const data = preparedDuplicateAnalysisData(analysis);
  assertPreparedDuplicateOptions(data, options);
  return await findDuplicateContextsWithOpenDuplicateUnitCache(data.index, targets, options, data);
}

export async function findDuplicateContext(
  index: ProjectIndex,
  target: DuplicateTarget,
  options: DuplicateDetectionOptions = {},
): Promise<DuplicateContextResult> {
  const contexts = await findDuplicateContexts(index, [target], options);
  return contexts[0]!;
}

export type {
  DuplicateConfidence,
  DuplicateCloneType,
  DuplicateCleanupLabel,
  DuplicateUnitKind,
  DuplicateUnitRef,
  DuplicateMetrics,
  DuplicateSuggestion,
  DuplicateClusterSummary,
  DuplicateGroup,
  DuplicateDetectionOptions,
  DuplicateSimilarityHint,
  DuplicateDetectionOmittedCounts,
  DuplicateDetectionStats,
  DuplicateDetectionFilteredCounts,
  DuplicateDetectionResult,
  DuplicateTarget,
  DuplicateContextResult,
  DuplicatePreparedAnalysis,
  DuplicatePreparationOptions,
} from "./duplicates/types.js";
export { closeDuplicateUnitCacheDatabase } from "./duplicates/unit-cache.js";
export { DEFAULT_MAX_CANDIDATE_PAIRS, MAX_CANDIDATE_PAIRS_LIMIT } from "./duplicates/scoring.js";
