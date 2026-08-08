import { normalizePath, toProjectDisplayPath } from "./util/paths.js";
import type { ProjectIndex } from "./indexer/types.js";
import * as duplicateUnits from "./duplicates/units.js";
import * as duplicateScoring from "./duplicates/scoring.js";
import * as duplicateUnitCache from "./duplicates/unitCache.js";
import type {
  CollectedDuplicateUnits,
  DuplicateContextResult,
  DuplicateDetectionOptions,
  DuplicateDetectionResult,
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
  PairFilter,
  PreparedDuplicateBuckets,
  UnitFilter,
} from "./duplicates/types.js";

const { collectDuplicateUnits, normalizeDetectionFile } = duplicateUnits;
const {
  DEFAULT_GROUP_VARIANT_LIMIT,
  DEFAULT_LIMIT,
  DEFAULT_MAX_BUCKET_SIZE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MIN_TOKENS,
  DEFAULT_SHINGLE_SIZE,
  DEFAULT_WINDOW_SIZE,
  buildCandidatePairs,
  buildCandidatePairsFromPreparedBuckets,
  compareSuggestions,
  confidenceRank,
  filterPreparedDuplicateBuckets,
  groupSuggestions,
  hasLineOverlap,
  lineOverlap,
  normalizeConfidence,
  normalizeNonNegativeIntegerOption,
  normalizePositiveIntegerOption,
  prepareDuplicateCandidateBuckets,
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

/** Finds scored duplicate candidates from an already-built project index. */
async function findDuplicatesWithOpenDuplicateUnitCache(
  index: ProjectIndex,
  options: DuplicateDetectionOptions = {},
  preparedData?: DuplicatePreparedAnalysisData,
): Promise<DuplicateDetectionResult> {
  const collectionOptions = duplicateUnitCollectionOptions(index, options);
  const projectRoot = collectionOptions.projectRoot;
  const maxBucketSize = normalizePositiveIntegerOption(options.maxBucketSize, "maxBucketSize", DEFAULT_MAX_BUCKET_SIZE);
  const maxPairs =
    options.maxPairs === undefined
      ? Number.POSITIVE_INFINITY
      : normalizeNonNegativeIntegerOption(options.maxPairs, "maxPairs", DEFAULT_LIMIT);
  const crossFileOnly = options.crossFileOnly ?? !(options.includeSameFile ?? false);
  const minConfidence = normalizeConfidence(options.minConfidence);
  const limit = normalizeNonNegativeIntegerOption(options.limit, "limit", DEFAULT_LIMIT);
  const collectedUnits = preparedData?.collectedUnits ?? (await collectDuplicateUnits(index, collectionOptions));
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
  const candidateResult = candidateBuckets
    ? buildCandidatePairsFromPreparedBuckets(candidateBuckets, maxBucketSize, options.similarityHints, projectRoot)
    : buildCandidatePairs(units, maxBucketSize, options.similarityHints, projectRoot);
  const { pairs, oversizedBuckets } = candidateResult;
  const suggestions: DuplicateSuggestion[] = [];
  let overlappingPairs = 0;
  let comparedPairs = 0;
  let skippedCandidatePairs = 0;

  for (const evidence of pairs.values()) {
    if (crossFileOnly && evidence.left.absoluteFile === evidence.right.absoluteFile) continue;
    if (hasLineOverlap(evidence.left, evidence.right)) {
      overlappingPairs++;
      continue;
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
    units: units.length,
    groups: limitedGroups,
    omittedCounts: {
      groups: omittedGroups,
      rawSuggestions: Math.max(0, suggestions.length - limitedRawSuggestions.length),
      oversizedBuckets,
      belowThresholdUnits,
      overlappingPairs,
      candidatePairs: skippedCandidatePairs,
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

function groupTouchesDuplicateTarget(group: DuplicateGroup, target: DuplicateTarget): boolean {
  if (unitTouchesDuplicateTarget(group.primaryLeft, target) || unitTouchesDuplicateTarget(group.primaryRight, target)) {
    return true;
  }
  return group.variants.some((variant) => suggestionTouchesDuplicateTarget(variant, target));
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
      candidatePairs: result.perTargetSkippedCandidateCounts?.get(duplicateTargetKey(normalizedTarget)) ?? 0,
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
  const { pairs, oversizedBuckets } = buildCandidatePairsFromPreparedBuckets(
    preparedBuckets ?? prepareDuplicateCandidateBuckets(units),
    maxBucketSize,
    options.similarityHints,
    projectRoot,
    touchesAnyTarget,
    touchesTarget,
  );
  const suggestions: DuplicateSuggestion[] = [];
  let overlappingPairs = 0;
  let comparedPairs = 0;
  let skippedCandidatePairs = 0;

  for (const evidence of pairs.values()) {
    if (crossFileOnly && evidence.left.absoluteFile === evidence.right.absoluteFile) continue;
    if (hasLineOverlap(evidence.left, evidence.right)) {
      overlappingPairs++;
      continue;
    }
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
      candidatePairs: skippedCandidatePairs,
    },
    stats: {
      comparedPairs,
      candidatePairs: pairs.size,
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
export { closeDuplicateUnitCacheDatabase } from "./duplicates/unitCache.js";
