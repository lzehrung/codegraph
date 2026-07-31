import { buildProjectIndexIncremental } from "../indexer/build-index.js";
import {
  findDuplicates,
  type DuplicateCleanupLabel,
  type DuplicateConfidence,
  type DuplicateDetectionOptions,
  type DuplicateDetectionResult,
  type DuplicateGroup,
  type DuplicateUnitRef,
} from "../duplicates.js";
import type { BuildOptions } from "../indexer/types.js";
import { parseNonNegativeIntegerOption, parsePositiveIntegerOption } from "./options.js";

export type DuplicatesCommandContext = {
  projectRootFs: string;
  files: string[];
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  indexOptions?: BuildOptions;
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
  writeStderrLine: (message: string) => void;
  exit: (code: number) => never;
};
type DuplicateGroupFamily = "language-parity" | "declaration-mirror" | "cli-boilerplate";
type DuplicateProfile = "cleanup";

type DuplicateSortMode = "similarity" | "actionability" | "reduced-lines";
const ACTIONABILITY_SORT_OVERFETCH_MULTIPLIER = 10;
const ACTIONABILITY_SORT_MAX_CANDIDATES = 500;
const REDUCED_LINES_SORT_OVERFETCH_MULTIPLIER = 25;
const REDUCED_LINES_SORT_MAX_CANDIDATES = 5000;

const confidenceWeight: Record<DuplicateConfidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function parseConfidenceOption(rawValue: string | undefined): DuplicateConfidence | undefined {
  if (rawValue === undefined) return undefined;
  if (rawValue === "high" || rawValue === "medium" || rawValue === "low") return rawValue;
  throw new Error(`Invalid --min-confidence value "${rawValue}". Expected high|medium|low.`);
}

function parseSortOption(rawValue: string | undefined): DuplicateSortMode | undefined {
  if (rawValue === undefined) return undefined;
  if (rawValue === "similarity" || rawValue === "actionability" || rawValue === "reduced-lines") return rawValue;
  throw new Error(`Invalid --sort value "${rawValue}". Expected similarity|actionability|reduced-lines.`);
}

function parseProfileOption(rawValue: string | undefined): DuplicateProfile | undefined {
  if (rawValue === undefined) return undefined;
  if (rawValue === "cleanup" || rawValue === "refactor-roi") return "cleanup";
  throw new Error(`Invalid --profile value "${rawValue}". Expected cleanup|refactor-roi.`);
}

function getOptionWithProfileDefault(
  context: DuplicatesCommandContext,
  optionName: string,
  profile: DuplicateProfile | undefined,
  cleanupDefault: string,
): string | undefined {
  const explicitValue = context.getOpt(optionName);
  if (explicitValue !== undefined) return explicitValue;
  if (profile === "cleanup") return cleanupDefault;
  return undefined;
}

function parseDuplicateDetectionOptions(
  context: DuplicatesCommandContext,
  profile: DuplicateProfile | undefined,
): DuplicateDetectionOptions {
  const minConfidence = parseConfidenceOption(
    getOptionWithProfileDefault(context, "--min-confidence", profile, "medium"),
  );
  const minTokens = parsePositiveIntegerOption(
    getOptionWithProfileDefault(context, "--min-tokens", profile, "80"),
    "--min-tokens",
    40,
  );
  const options: DuplicateDetectionOptions = {
    projectRoot: context.projectRootFs,
    files: context.files,
    ...(minConfidence !== undefined ? { minConfidence } : {}),
    limit: parseNonNegativeIntegerOption(context.getOpt("--limit"), "--limit", 50),
    minTokens,
    maxTokens: parsePositiveIntegerOption(context.getOpt("--max-tokens"), "--max-tokens", 800),
    maxBucketSize: parsePositiveIntegerOption(context.getOpt("--max-bucket-size"), "--max-bucket-size", 200),
    ...(context.hasFlag("--include-same-file") ? { includeSameFile: true } : {}),
    ...(context.hasFlag("--include-small") ? { includeSmall: true } : {}),
    ...(context.hasFlag("--raw-pairs") ? { includeRawPairs: true } : {}),
  };

  if (options.maxTokens !== undefined && options.minTokens !== undefined && options.maxTokens < options.minTokens) {
    throw new Error(
      `Invalid --max-tokens value "${options.maxTokens}". Expected a value greater than or equal to --min-tokens.`,
    );
  }
  return options;
}

function duplicateGroupFiles(group: DuplicateGroup): string[] {
  const files = new Set<string>([group.primaryLeft.file, group.primaryRight.file]);
  for (const variant of group.variants) {
    files.add(variant.left.file);
    files.add(variant.right.file);
  }
  return Array.from(files).sort();
}

function duplicateGroupFamilies(group: DuplicateGroup, mode: "display" | "score"): DuplicateGroupFamily[] {
  const files = mode === "display" ? [group.primaryLeft.file, group.primaryRight.file] : duplicateGroupFiles(group);
  if (!files.length) return [];

  const totalTokens = group.primaryLeft.tokenCount + group.primaryRight.tokenCount;
  const primaryNames = [group.primaryLeft.name, group.primaryRight.name];
  const families: DuplicateGroupFamily[] = [];

  const allLanguageParity = files.every(
    (file) => file.startsWith("src/languages/definitions/") || file.startsWith("tests/languages/"),
  );
  if (allLanguageParity) families.push("language-parity");

  const allDeclarationMirrors = files.every((file) => /\.d\.[cm]?ts$/.test(file));
  if (allDeclarationMirrors) families.push("declaration-mirror");

  const cliBoilerplate =
    mode === "display" &&
    files.every((file) => file.startsWith("src/cli/")) &&
    primaryNames.every((name) => name !== undefined && /^(format|render)/.test(name)) &&
    totalTokens <= 240;
  if (cliBoilerplate) families.push("cli-boilerplate");

  return families;
}

function subsystemDistance(leftFile: string, rightFile: string): number {
  const leftParts = leftFile.split("/").slice(0, 3);
  const rightParts = rightFile.split("/").slice(0, 3);
  let sharedPrefix = 0;
  const maxShared = Math.min(leftParts.length, rightParts.length);
  while (sharedPrefix < maxShared && leftParts[sharedPrefix] === rightParts[sharedPrefix]) {
    sharedPrefix += 1;
  }
  return Math.max(leftParts.length, rightParts.length) - sharedPrefix;
}
function actionabilityTier(group: DuplicateGroup): number {
  const families = duplicateGroupFamilies(group, "score");
  if (families.includes("language-parity") || families.includes("declaration-mirror")) return 1;
  return 0;
}

function actionabilityScore(group: DuplicateGroup): number {
  const totalTokens = group.primaryLeft.tokenCount + group.primaryRight.tokenCount;
  let score = group.score;
  score += confidenceWeight[group.confidence] * 6;
  score += Math.min(24, Math.round(totalTokens / 15));
  score += Math.min(12, group.variants.length * 3);
  score += Math.min(12, subsystemDistance(group.primaryLeft.file, group.primaryRight.file) * 3);
  score += Math.min(20, group.estimatedLinesSaved);
  if (group.cloneType === "exact") score += 4;
  if (group.cleanupLabels.includes("test-helper-extraction")) score += 18;
  if (group.cleanupLabels.includes("production-helper-extraction")) score += 22;
  if (group.cleanupLabels.includes("fixture-boilerplate")) score -= 18;
  if (group.cleanupLabels.includes("type-shape-noise")) score -= 16;
  for (const family of duplicateGroupFamilies(group, "score")) {
    if (family === "language-parity") {
      score -= 45;
      continue;
    }
    if (family === "declaration-mirror") {
      score -= 40;
    }
  }
  return score;
}

function compareByReducedLines(left: DuplicateGroup, right: DuplicateGroup): number {
  const reducedDiff = right.reducedLines - left.reducedLines;
  if (reducedDiff) return reducedDiff;
  const savedDiff = right.estimatedLinesSaved - left.estimatedLinesSaved;
  if (savedDiff) return savedDiff;
  return right.score - left.score;
}

function sortGroups(groups: readonly DuplicateGroup[], sortMode: DuplicateSortMode): DuplicateGroup[] {
  if (sortMode === "similarity") return [...groups];
  if (sortMode === "reduced-lines") return [...groups].sort(compareByReducedLines);
  return [...groups].sort((left, right) => {
    const tierDiff = actionabilityTier(left) - actionabilityTier(right);
    if (tierDiff) return tierDiff;
    return actionabilityScore(right) - actionabilityScore(left);
  });
}

function formatUnitLabel(unit: DuplicateUnitRef): string {
  const base = `${unit.file}:${unit.startLine}-${unit.endLine}`;
  if (unit.name) return `${base} ${unit.name}`;
  if (unit.kind === "chunk") return `${base} <chunk>`;
  return base;
}

function formatOmittedCounts(result: DuplicateDetectionResult): string | undefined {
  const entries: string[] = [];
  if (result.omittedCounts.groups) entries.push(`groups=${result.omittedCounts.groups}`);
  if (result.omittedCounts.rawSuggestions) entries.push(`rawSuggestions=${result.omittedCounts.rawSuggestions}`);
  if (result.omittedCounts.oversizedBuckets) entries.push(`oversizedBuckets=${result.omittedCounts.oversizedBuckets}`);
  if (result.omittedCounts.belowThresholdUnits)
    entries.push(`belowThresholdUnits=${result.omittedCounts.belowThresholdUnits}`);
  if (result.omittedCounts.overlappingPairs) entries.push(`overlappingPairs=${result.omittedCounts.overlappingPairs}`);
  if (result.omittedCounts.candidatePairs) entries.push(`candidatePairs=${result.omittedCounts.candidatePairs}`);
  if (!entries.length) return undefined;
  return entries.join(", ");
}

function formatCleanupLabels(labels: readonly DuplicateCleanupLabel[]): string | undefined {
  if (!labels.length) return undefined;
  return labels.join(",");
}

function formatPrettyGroupLine(group: DuplicateGroup, index: number, sortMode: DuplicateSortMode): string {
  let summary = `${index + 1}. [${group.confidence} ${group.cloneType} score=${group.score}`;
  summary += ` reducedLines=${group.reducedLines}`;
  if (group.estimatedLinesSaved) {
    summary += ` estimatedSaved=${group.estimatedLinesSaved}`;
  }
  if (sortMode === "actionability") {
    summary += ` actionability=${actionabilityScore(group)}`;
  }
  const families = duplicateGroupFamilies(group, "display");
  if (families.length) {
    summary += ` family=${families.join(",")}`;
  }
  const labels = formatCleanupLabels(group.cleanupLabels);
  if (labels) {
    summary += ` labels=${labels}`;
  }
  if (group.cluster) {
    summary += ` cluster=${group.cluster.locationCount}loc`;
    if (group.cluster.label) summary += `:${group.cluster.label}`;
  }
  summary += `] ${formatUnitLabel(group.primaryLeft)} <-> ${formatUnitLabel(group.primaryRight)}`;
  summary += ` tokenCounts=${group.primaryLeft.tokenCount}/${group.primaryRight.tokenCount}`;
  summary += ` variants=${group.variantCount}`;
  if (group.omittedVariantCount) {
    summary += ` (+${group.omittedVariantCount} hidden)`;
  }
  if (group.rawPairCount !== group.variantCount) {
    summary += ` rawPairs=${group.rawPairCount}`;
  }
  return summary;
}

function labelCounts(groups: readonly DuplicateGroup[]): Array<[DuplicateCleanupLabel, number]> {
  const counts = new Map<DuplicateCleanupLabel, number>();
  for (const group of groups) {
    for (const label of group.cleanupLabels) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return Array.from(counts).sort(([leftLabel, leftCount], [rightLabel, rightCount]) => {
    const countDiff = rightCount - leftCount;
    if (countDiff) return countDiff;
    return leftLabel.localeCompare(rightLabel);
  });
}

function topClusterSummaries(groups: readonly DuplicateGroup[]): string[] {
  const clusters = new Map<string, NonNullable<DuplicateGroup["cluster"]>>();
  for (const group of groups) {
    if (group.cluster) clusters.set(group.cluster.id, group.cluster);
  }
  return Array.from(clusters.values())
    .sort((left, right) => right.estimatedLinesSaved - left.estimatedLinesSaved)
    .slice(0, 3)
    .map((cluster) => {
      const label = cluster.label ? `${cluster.label}: ` : "";
      const files = cluster.files.slice(0, 3).join(", ");
      return `${label}${cluster.locationCount} locations, estimatedSaved=${cluster.estimatedLinesSaved}, files=${files}`;
    });
}

function appendPrettySummary(
  lines: string[],
  result: DuplicateDetectionResult,
  summaryGroups: readonly DuplicateGroup[],
): void {
  lines.push("", "Summary:");
  lines.push(`- groups returned: ${result.groups.length}`);
  const omitted = formatOmittedCounts(result);
  lines.push(`- omitted: ${omitted ?? "none"}`);
  const clusters = topClusterSummaries(summaryGroups);
  if (result.filteredCounts?.cleanupProfileGroups) {
    lines.push(`- filtered by cleanup profile: ${result.filteredCounts.cleanupProfileGroups}`);
  }
  if (clusters.length) {
    lines.push("- top cleanup clusters:");
    for (const cluster of clusters) lines.push(`  - ${cluster}`);
  }
  const labels = labelCounts(summaryGroups);
  if (labels.length) {
    lines.push(`- labels: ${labels.map(([label, count]) => `${label}(${count})`).join(", ")}`);
  }
  lines.push(
    "- rerun with --json for stable fields or with --json --sort similarity --raw-pairs for low-level pair evidence; omit --profile cleanup if set",
  );
}

function formatPrettyDuplicates(
  result: DuplicateDetectionResult,
  sortMode: DuplicateSortMode,
  options: { showSummary: boolean; profileFilteredCount: number; summaryGroups: readonly DuplicateGroup[] },
): string {
  const lines = [
    `Duplicate groups shown: ${result.groups.length}`,
    `Sorted by: ${sortMode}`,
    `Units scanned: ${result.units}`,
    `Candidate pairs compared: ${result.stats.comparedPairs}/${result.stats.candidatePairs}`,
    "Family annotations are heuristic and derived from the displayed duplicate pair.",
  ];
  const omitted = formatOmittedCounts(result);
  if (result.filteredCounts?.cleanupProfileGroups) {
    lines.push(`Filtered by cleanup profile: ${result.filteredCounts.cleanupProfileGroups}`);
  }
  if (omitted) lines.push(`Omitted: ${omitted}`);
  if (!result.groups.length) {
    if (result.omittedCounts.groups) {
      lines.push("", "All duplicate groups were omitted by the current limit.");
      if (options.showSummary) appendPrettySummary(lines, result, options.summaryGroups);
      return lines.join("\n");
    }
    if (options.profileFilteredCount > 0) {
      lines.push("", "All duplicate groups were filtered by the active cleanup profile.");
      if (options.showSummary) appendPrettySummary(lines, result, options.summaryGroups);
      return lines.join("\n");
    }
    lines.push("", "No duplicate groups matched the current filters.");
    if (options.showSummary) appendPrettySummary(lines, result, options.summaryGroups);
    return lines.join("\n");
  }
  lines.push("");
  for (const [index, group] of result.groups.entries()) {
    lines.push(formatPrettyGroupLine(group, index, sortMode));
  }
  if (options.showSummary) appendPrettySummary(lines, result, options.summaryGroups);
  return lines.join("\n");
}

function isCleanupProfileNoise(group: DuplicateGroup): boolean {
  return group.cleanupLabels.includes("import-list-noise") || group.cleanupLabels.includes("barrel-export-noise");
}

function profileFilteredGroups(
  groups: readonly DuplicateGroup[],
  profile: DuplicateProfile | undefined,
): { groups: DuplicateGroup[]; profileFilteredCount: number } {
  if (profile !== "cleanup") {
    return { groups: [...groups], profileFilteredCount: 0 };
  }
  const filteredGroups = groups.filter((group) => !isCleanupProfileNoise(group));
  return {
    groups: filteredGroups,
    profileFilteredCount: groups.length - filteredGroups.length,
  };
}

function sortedResult(
  result: DuplicateDetectionResult,
  sortMode: DuplicateSortMode,
  requestedLimit: number,
  profile: DuplicateProfile | undefined,
): { result: DuplicateDetectionResult; profileFilteredCount: number; summaryGroups: DuplicateGroup[] } {
  const sortedGroups = sortGroups(result.groups, sortMode);
  const { groups, profileFilteredCount } = profileFilteredGroups(sortedGroups, profile);
  if (groups.length <= requestedLimit) {
    return {
      result: {
        ...result,
        groups,
        ...(profileFilteredCount > 0 ? { filteredCounts: { cleanupProfileGroups: profileFilteredCount } } : {}),
      },
      profileFilteredCount,
      summaryGroups: groups,
    };
  }

  const omittedBySort = groups.length - requestedLimit;
  return {
    result: {
      ...result,
      groups: groups.slice(0, requestedLimit),
      omittedCounts: {
        ...result.omittedCounts,
        groups: result.omittedCounts.groups + omittedBySort,
        suggestions: result.omittedCounts.suggestions + omittedBySort,
      },
      ...(profileFilteredCount > 0 ? { filteredCounts: { cleanupProfileGroups: profileFilteredCount } } : {}),
    },
    profileFilteredCount,
    summaryGroups: groups,
  };
}

export async function handleDuplicatesCommand(context: DuplicatesCommandContext): Promise<void> {
  try {
    const jsonOutput = context.hasFlag("--json");
    const prettyOutput = context.hasFlag("--pretty");
    const rawPairsOutput = context.hasFlag("--raw-pairs");
    const profile = parseProfileOption(context.getOpt("--profile"));
    if (prettyOutput && !jsonOutput && rawPairsOutput) {
      throw new Error("Invalid flag combination: --raw-pairs is only supported with similarity-ranked JSON output.");
    }
    if (profile === "cleanup" && rawPairsOutput) {
      throw new Error("Invalid flag combination: --profile cleanup is not supported with --raw-pairs.");
    }
    const renderPretty = !jsonOutput && !rawPairsOutput;

    let defaultSort: DuplicateSortMode = "similarity";
    if (renderPretty) {
      defaultSort = profile === "cleanup" ? "reduced-lines" : "actionability";
    }
    const sortMode = parseSortOption(context.getOpt("--sort")) ?? defaultSort;
    if ((sortMode === "actionability" || sortMode === "reduced-lines") && rawPairsOutput) {
      throw new Error("Invalid flag combination: --raw-pairs is only supported with similarity-ranked JSON output.");
    }

    const options = parseDuplicateDetectionOptions(context, profile);
    const requestedLimit = options.limit ?? 50;
    if (profile === "cleanup" || sortMode === "reduced-lines") {
      const boundedLimit = Math.max(
        requestedLimit,
        Math.min(REDUCED_LINES_SORT_MAX_CANDIDATES, requestedLimit * REDUCED_LINES_SORT_OVERFETCH_MULTIPLIER),
      );
      options.limit = boundedLimit;
    } else if (sortMode === "actionability") {
      const boundedLimit = Math.max(
        requestedLimit,
        Math.min(ACTIONABILITY_SORT_MAX_CANDIDATES, requestedLimit * ACTIONABILITY_SORT_OVERFETCH_MULTIPLIER),
      );
      options.limit = boundedLimit;
    }

    const index = await buildProjectIndexIncremental(context.projectRootFs, {
      ...context.indexOptions,
      files: context.files,
      filesAreProjectScope: true,
    });
    const result = await findDuplicates(index, options);
    const sorted = sortedResult(result, sortMode, requestedLimit, profile);
    if (!renderPretty) {
      context.writeJSONLine(sorted.result);
      return;
    }
    context.writeStdoutLine(
      formatPrettyDuplicates(sorted.result, sortMode, {
        showSummary: !context.hasFlag("--no-summary"),
        profileFilteredCount: sorted.profileFilteredCount,
        summaryGroups: sorted.summaryGroups,
      }),
    );
  } catch (error) {
    context.writeStderrLine(`Duplicate detection failed: ${error instanceof Error ? error.message : String(error)}`);
    context.exit(1);
  }
}
