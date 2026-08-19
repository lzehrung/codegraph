import type { FileId, Edge } from "../types.js";
import { type ProjectIndex, type Reference } from "../indexer/types.js";
import { fileIdentityKey } from "../util/paths.js";
import type { ChangedSymbol, ImpactReason, SeverityWeights } from "./types.js";
import { DEFAULT_SEVERITY_WEIGHTS } from "./types.js";

const normalizedWeightsCache = new WeakMap<object, SeverityWeights>();

const REASON_PRIORITY: Readonly<Record<ImpactReason, number>> = {
  directRef: 4,
  namespaceMember: 3,
  importAlias: 2,
  exportChain: 1,
  transitive: 0,
  fileLevelChange: 0,
};

export type SeverityExplain = {
  reason?: ImpactReason;
  exported?: boolean;
  fanIn?: number;
  sameFile?: boolean;
  typeOnly?: boolean;
  depth?: number;
  hints?: string[];
  resolutionConfidence?: "medium" | "low";
};

export type SeverityResult = {
  /** Normalized effective score used to rank impacts. */
  severity: number;
  /** Certainty of the reference resolution, also factored into severity. */
  confidence: number;
  explain: SeverityExplain;
};

export type DependencyStats = {
  fanInByFile: Map<FileId, number>;
  reverseDeps: Map<FileId, Edge[]>;
};

const cachedFanInByGraph = new WeakMap<object, Map<FileId, number>>();

const severityWeightKeys: ReadonlyArray<keyof SeverityWeights> = [
  "directRef",
  "namespaceMember",
  "importAlias",
  "transitive",
  "exported",
  "sameFile",
  "typeOnly",
  "depthDecay",
  "resolutionConfidenceMedium",
  "resolutionConfidenceLow",
];

export function selectStrongerImpactReason(
  existingReason: ImpactReason | undefined,
  newReason: ImpactReason | undefined,
): ImpactReason | undefined {
  if (existingReason === undefined) return newReason;
  if (newReason !== undefined && REASON_PRIORITY[newReason] > REASON_PRIORITY[existingReason]) {
    return newReason;
  }
  return existingReason;
}

export function normalizeSeverityWeights(
  weights: Partial<SeverityWeights> = DEFAULT_SEVERITY_WEIGHTS,
): SeverityWeights {
  if (weights === null || typeof weights !== "object") {
    throw new RangeError("Invalid severity weights: expected an object");
  }
  const cached = normalizedWeightsCache.get(weights);
  if (cached) return cached;

  const normalized: SeverityWeights = { ...DEFAULT_SEVERITY_WEIGHTS };
  const invalidEntries: string[] = [];

  for (const key of severityWeightKeys) {
    const value = weights[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0) {
      invalidEntries.push(`${key}=${String(value)}`);
      continue;
    }
    normalized[key] = value;
  }

  if (normalized.depthDecay >= 1) {
    invalidEntries.push(`depthDecay=${String(weights.depthDecay)}`);
  }

  if (invalidEntries.length) {
    throw new RangeError(`Invalid severity weights: ${invalidEntries.join(", ")}`);
  }

  normalizedWeightsCache.set(weights, normalized);
  return normalized;
}

/**
 * Keep severity in its public 0..1 range without collapsing distinct high
 * scores into a single value. The mapping is monotonic, so it preserves the
 * ordering of the effective score used by impact ranking.
 */
function normalizeSeverityScore(score: number): number {
  if (!Number.isFinite(score)) return 1;
  if (score <= 0) return 0;
  return score / (1 + score);
}

function getCachedFanInByFile(index: ProjectIndex): Map<FileId, number> {
  const cached = cachedFanInByGraph.get(index.graph);
  if (cached) return cached;
  const { fanInByFile } = buildDependencyStats(index.graph.edges);
  cachedFanInByGraph.set(index.graph, fanInByFile);
  return fanInByFile;
}

export function buildDependencyStats(edges: Edge[]): DependencyStats {
  const fanInByFile = new Map<FileId, number>();
  const reverseDeps = new Map<FileId, Edge[]>();

  for (const edge of edges) {
    if (edge.to.type !== "file") continue;

    const key = fileIdentityKey(edge.to.path);
    const nextCount = (fanInByFile.get(key) ?? 0) + 1;
    fanInByFile.set(key, nextCount);

    const incoming = reverseDeps.get(key);
    if (incoming) {
      incoming.push(edge);
      continue;
    }
    reverseDeps.set(key, [edge]);
  }

  return { fanInByFile, reverseDeps };
}

export function calculateSeverity(
  changedSymbol: ChangedSymbol,
  ref: Reference,
  reasons: ImpactReason[],
  depth: number,
  index: ProjectIndex,
  fanInByFile?: Map<FileId, number>,
  weights: Partial<SeverityWeights> = DEFAULT_SEVERITY_WEIGHTS,
): SeverityResult {
  const validatedWeights = normalizeSeverityWeights(weights);

  let score = 1.0;
  let confidence = 1.0;
  const explain: SeverityExplain = {};
  const hints: string[] = [];

  if (reasons.includes("directRef")) {
    score *= validatedWeights.directRef;
    explain.reason = "directRef";
    confidence = 1.0;
  } else if (reasons.includes("namespaceMember")) {
    score *= validatedWeights.namespaceMember;
    explain.reason = "namespaceMember";
    confidence = 0.9;
  } else if (reasons.includes("importAlias")) {
    score *= validatedWeights.importAlias;
    explain.reason = "importAlias";
    confidence = 0.85;
  } else if (reasons.includes("fileLevelChange")) {
    score *= validatedWeights.transitive * 0.9;
    explain.reason = "fileLevelChange";
    confidence = 0.5;
  } else {
    score *= validatedWeights.transitive;
    explain.reason = "transitive";
    confidence = 0.6;
  }

  if (ref.provenance?.confidence === "medium") {
    confidence *= validatedWeights.resolutionConfidenceMedium;
    explain.resolutionConfidence = "medium";
  } else if (ref.provenance?.confidence === "low") {
    confidence *= validatedWeights.resolutionConfidenceLow;
    explain.resolutionConfidence = "low";
  }

  if (changedSymbol.exported) {
    score *= validatedWeights.exported;
    explain.exported = true;
  }

  const fanInCounts = fanInByFile ?? getCachedFanInByFile(index);
  const fanIn = fanInCounts.get(fileIdentityKey(ref.file)) ?? 0;
  if (fanIn > 0) {
    const fanInFactor = 1 + Math.min(Math.log10(fanIn + 1), 1);
    score *= fanInFactor;
    explain.fanIn = fanIn;
  }

  if (fileIdentityKey(ref.file) === fileIdentityKey(changedSymbol.file)) {
    score *= validatedWeights.sameFile;
    explain.sameFile = true;
  }

  if (changedSymbol.typeOnly) {
    score *= validatedWeights.typeOnly;
    explain.typeOnly = true;
  }

  if (changedSymbol.exported) {
    hints.push("exportChanged");
  }
  if (changedSymbol.signatureChanged) {
    hints.push("signatureChanged");
  }
  if (hints.length) {
    explain.hints = hints;
  }

  score *= Math.pow(validatedWeights.depthDecay, depth);
  explain.depth = depth;
  confidence *= Math.pow(0.9, depth);

  // Resolution confidence is ranking evidence, not display-only metadata.
  // Apply it before the saturating normalization so lower-confidence matches
  // cannot tie exact matches solely because both scores would otherwise cap.
  score *= confidence;

  return {
    severity: normalizeSeverityScore(score),
    confidence: Math.min(1.0, Math.max(0.0, confidence)),
    explain,
  };
}

export function calculateTransitiveSeverity(
  edge: Edge,
  depth: number,
  weights: Partial<SeverityWeights> = DEFAULT_SEVERITY_WEIGHTS,
): number {
  const validatedWeights = normalizeSeverityWeights(weights);
  let score = 0.3 * (validatedWeights.transitive / DEFAULT_SEVERITY_WEIGHTS.transitive);
  if (edge.typeOnly) {
    score *= 0.6 * (validatedWeights.typeOnly / DEFAULT_SEVERITY_WEIGHTS.typeOnly);
  }
  score *= Math.pow(0.7 * (validatedWeights.depthDecay / DEFAULT_SEVERITY_WEIGHTS.depthDecay), depth);
  return score;
}
