import {
  findDuplicates,
  findDuplicatesWithPreparedAnalysis,
  type DuplicateCloneType,
  type DuplicateGroup,
  type DuplicatePreparedAnalysis,
  type DuplicateSimilarityHint,
} from "./duplicates.js";
import type { ProjectIndex } from "./indexer/types.js";

export type DuplicateLeadScope = "off" | "changed" | "impacted" | "all";

export type DuplicateLead = {
  file: string;
  startLine: number;
  endLine: number;
  otherFile: string;
  otherStartLine: number;
  otherEndLine: number;
  cloneType: DuplicateCloneType;
  score: number;
};

export type DuplicateLeadSummary = {
  scope: Exclude<DuplicateLeadScope, "off">;
  leads: DuplicateLead[];
  omittedCounts: {
    byBudget: number;
    byConfidenceOrType: number;
    byScope: number;
    hiddenEvidence: number;
  };
};

const DEFAULT_DUPLICATE_LEAD_LIMIT = 5;
const DEFAULT_DUPLICATE_LEAD_MAX_PAIRS = 20_000;
const REVIEW_CLONE_TYPES = new Set<DuplicateCloneType>(["exact", "renamed"]);

function normalizeDuplicateScope(value: string | undefined, fallback: DuplicateLeadScope): DuplicateLeadScope {
  if (value === undefined) return fallback;
  if (value === "off" || value === "changed" || value === "impacted" || value === "all") return value;
  throw new Error(`Invalid --duplicates value "${value}". Expected off|changed|impacted|all.`);
}

function uniqueFiles(files: readonly string[]): string[] {
  return Array.from(new Set(files.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function leadFromGroup(group: DuplicateGroup): DuplicateLead {
  return {
    file: group.primaryLeft.file,
    startLine: group.primaryLeft.startLine,
    endLine: group.primaryLeft.endLine,
    otherFile: group.primaryRight.file,
    otherStartLine: group.primaryRight.startLine,
    otherEndLine: group.primaryRight.endLine,
    cloneType: group.cloneType,
    score: group.score,
  };
}

function countHiddenGroups(groups: readonly DuplicateGroup[]): number {
  return groups.filter((group) => group.confidence !== "high" || !REVIEW_CLONE_TYPES.has(group.cloneType)).length;
}

export function parseDuplicateLeadScope(value: string | undefined, fallback: DuplicateLeadScope): DuplicateLeadScope {
  return normalizeDuplicateScope(value, fallback);
}

export async function collectDuplicateLeadSummary(input: {
  index: ProjectIndex;
  projectRoot: string;
  scope: Exclude<DuplicateLeadScope, "off">;
  scopedFiles?: readonly string[];
  allScopeFileCount?: number;
  limit?: number;
  maxPairs?: number;
  similarityHints?: readonly DuplicateSimilarityHint[];
  preparedAnalysis?: DuplicatePreparedAnalysis;
}): Promise<DuplicateLeadSummary | undefined> {
  const limit = input.limit ?? DEFAULT_DUPLICATE_LEAD_LIMIT;
  const maxPairs = input.maxPairs ?? DEFAULT_DUPLICATE_LEAD_MAX_PAIRS;
  const scopedFiles = input.scope === "all" ? undefined : uniqueFiles(input.scopedFiles ?? []);
  if (input.scope !== "all" && (!scopedFiles || scopedFiles.length < 2)) {
    return undefined;
  }

  const detectionOptions = {
    projectRoot: input.projectRoot,
    ...(scopedFiles ? { files: scopedFiles } : {}),
    ...(input.similarityHints !== undefined ? { similarityHints: input.similarityHints } : {}),
    minConfidence: "medium" as const,
    maxPairs,
    limit: limit * 4,
  };
  const result = input.preparedAnalysis
    ? await findDuplicatesWithPreparedAnalysis(input.preparedAnalysis, detectionOptions)
    : await findDuplicates(input.index, detectionOptions);
  const visibleGroups = result.groups.filter(
    (group) => group.confidence === "high" && REVIEW_CLONE_TYPES.has(group.cloneType),
  );
  const limitedGroups = visibleGroups.slice(0, limit);
  const hiddenGroupCount = countHiddenGroups(result.groups);
  if (!limitedGroups.length && !result.omittedCounts.groups && !hiddenGroupCount) {
    return undefined;
  }

  const allScopeFileCount = input.allScopeFileCount ?? input.index.byFile.size;
  const scopedFileCount = scopedFiles?.length ?? allScopeFileCount;
  return {
    scope: input.scope,
    leads: limitedGroups.map(leadFromGroup),
    omittedCounts: {
      byBudget: Math.max(0, visibleGroups.length - limitedGroups.length) + result.omittedCounts.groups,
      byConfidenceOrType: hiddenGroupCount,
      byScope: Math.max(0, allScopeFileCount - scopedFileCount),
      hiddenEvidence:
        result.omittedCounts.rawSuggestions +
        result.omittedCounts.oversizedBuckets +
        result.omittedCounts.candidatePairs,
    },
  };
}

export function appendDuplicateLeadSummary(lines: string[], summary: DuplicateLeadSummary | undefined): void {
  if (!summary) return;

  lines.push("");
  lines.push("Duplicate leads:");
  if (!summary.leads.length) {
    lines.push("- none after confidence/type filters");
  }
  for (const lead of summary.leads) {
    lines.push(
      `- ${lead.file}:${lead.startLine}-${lead.endLine} matches ${lead.otherFile}:${lead.otherStartLine}-${lead.otherEndLine} (${lead.cloneType}, score ${lead.score}).`,
    );
  }

  const omitted = summary.omittedCounts;
  const omittedParts: string[] = [];
  if (omitted.byBudget) omittedParts.push(`${omitted.byBudget} by budget`);
  if (omitted.byConfidenceOrType) omittedParts.push(`${omitted.byConfidenceOrType} by confidence/type`);
  if (omitted.byScope) omittedParts.push(`${omitted.byScope} outside ${summary.scope} scope`);
  if (omitted.hiddenEvidence) omittedParts.push(`${omitted.hiddenEvidence} hidden evidence items`);
  if (omittedParts.length) {
    lines.push(`- omitted: ${omittedParts.join(", ")}`);
  }
}
