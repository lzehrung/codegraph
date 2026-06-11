import { buildProjectIndexFromFiles } from "../indexer/build-index.js";
import {
  findDuplicates,
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

type DuplicateSortMode = "similarity" | "actionability";
const ACTIONABILITY_SORT_OVERFETCH_MULTIPLIER = 10;
const ACTIONABILITY_SORT_MAX_CANDIDATES = 500;

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
  if (rawValue === "similarity" || rawValue === "actionability") return rawValue;
  throw new Error(`Invalid --sort value "${rawValue}". Expected similarity|actionability.`);
}

function parseDuplicateDetectionOptions(context: DuplicatesCommandContext): DuplicateDetectionOptions {
  const minConfidence = parseConfidenceOption(context.getOpt("--min-confidence"));
  const options: DuplicateDetectionOptions = {
    projectRoot: context.projectRootFs,
    files: context.files,
    ...(minConfidence !== undefined ? { minConfidence } : {}),
    limit: parseNonNegativeIntegerOption(context.getOpt("--limit"), "--limit", 50),
    minTokens: parsePositiveIntegerOption(context.getOpt("--min-tokens"), "--min-tokens", 40),
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
  if (group.cloneType === "exact") score += 4;
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

function sortGroups(groups: readonly DuplicateGroup[], sortMode: DuplicateSortMode): DuplicateGroup[] {
  if (sortMode === "similarity") return [...groups];
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

function formatPrettyGroupLine(group: DuplicateGroup, index: number, sortMode: DuplicateSortMode): string {
  let summary = `${index + 1}. [${group.confidence} ${group.cloneType} score=${group.score}`;
  if (sortMode === "actionability") {
    summary += ` actionability=${actionabilityScore(group)}`;
  }
  const families = duplicateGroupFamilies(group, "display");
  if (families.length) {
    summary += ` family=${families.join(",")}`;
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
function formatPrettyDuplicates(result: DuplicateDetectionResult, sortMode: DuplicateSortMode): string {
  const lines = [
    `Duplicate groups shown: ${result.groups.length}`,
    `Sorted by: ${sortMode}`,
    `Units scanned: ${result.units}`,
    `Candidate pairs compared: ${result.stats.comparedPairs}/${result.stats.candidatePairs}`,
    "Family annotations are heuristic and derived from the displayed duplicate pair.",
  ];
  const omitted = formatOmittedCounts(result);
  if (omitted) lines.push(`Omitted: ${omitted}`);
  if (!result.groups.length) {
    if (result.omittedCounts.groups) {
      lines.push("", "All duplicate groups were omitted by the current limit.");
      return lines.join("\n");
    }
    lines.push("", "No duplicate groups matched the current filters.");
    return lines.join("\n");
  }
  lines.push("");
  for (const [index, group] of result.groups.entries()) {
    lines.push(formatPrettyGroupLine(group, index, sortMode));
  }
  return lines.join("\n");
}

function sortedResult(
  result: DuplicateDetectionResult,
  sortMode: DuplicateSortMode,
  requestedLimit: number,
): DuplicateDetectionResult {
  if (sortMode === "similarity") return result;

  const groups = sortGroups(result.groups, sortMode);
  if (groups.length <= requestedLimit) {
    return {
      ...result,
      groups,
    };
  }

  const omittedGroups = groups.slice(requestedLimit);
  const omittedBySort = omittedGroups.length;
  return {
    ...result,
    groups: groups.slice(0, requestedLimit),
    omittedCounts: {
      ...result.omittedCounts,
      groups: result.omittedCounts.groups + omittedBySort,
      suggestions: result.omittedCounts.suggestions + omittedBySort,
    },
  };
}

export async function handleDuplicatesCommand(context: DuplicatesCommandContext): Promise<void> {
  try {
    const jsonOutput = context.hasFlag("--json");
    const prettyOutput = context.hasFlag("--pretty");
    if (jsonOutput && prettyOutput) {
      throw new Error("Invalid flag combination: choose either --json or --pretty.");
    }
    if (prettyOutput && context.hasFlag("--raw-pairs")) {
      throw new Error("Invalid flag combination: --raw-pairs is only supported with similarity-ranked JSON output.");
    }
    const sortMode = parseSortOption(context.getOpt("--sort")) ?? (prettyOutput ? "actionability" : "similarity");
    if (sortMode === "actionability" && context.hasFlag("--raw-pairs")) {
      throw new Error("Invalid flag combination: --raw-pairs is only supported with similarity-ranked JSON output.");
    }

    const options = parseDuplicateDetectionOptions(context);
    const requestedLimit = options.limit ?? 50;
    if (sortMode === "actionability") {
      const boundedLimit = Math.max(
        requestedLimit,
        Math.min(ACTIONABILITY_SORT_MAX_CANDIDATES, requestedLimit * ACTIONABILITY_SORT_OVERFETCH_MULTIPLIER),
      );
      options.limit = boundedLimit;
    }

    const index = await buildProjectIndexFromFiles(context.projectRootFs, context.files, context.indexOptions);
    const result = await findDuplicates(index, options);
    const sorted = sortedResult(result, sortMode, requestedLimit);
    if (!prettyOutput) {
      context.writeJSONLine(sorted);
      return;
    }
    context.writeStdoutLine(formatPrettyDuplicates(sorted, sortMode));
  } catch (error) {
    context.writeStderrLine(`Duplicate detection failed: ${error instanceof Error ? error.message : String(error)}`);
    context.exit(1);
  }
}
