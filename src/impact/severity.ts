import type { FileId, Edge } from "../types.js";
import type { ProjectIndex, Reference } from "../indexer.js";
import type { ChangedSymbol, ImpactReason, SeverityWeights } from "./types.js";
import { DEFAULT_SEVERITY_WEIGHTS } from "./types.js";

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
};

export type SeverityResult = {
  severity: number;
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

function normalizeSeverityWeights(weights: SeverityWeights): SeverityWeights {
  const normalized: SeverityWeights = { ...DEFAULT_SEVERITY_WEIGHTS };
  const invalidEntries: string[] = [];

  for (const key of severityWeightKeys) {
    const value = weights[key];
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

  return normalized;
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

    const nextCount = (fanInByFile.get(edge.to.path) ?? 0) + 1;
    fanInByFile.set(edge.to.path, nextCount);

    const incoming = reverseDeps.get(edge.to.path);
    if (incoming) {
      incoming.push(edge);
      continue;
    }
    reverseDeps.set(edge.to.path, [edge]);
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
  weights: SeverityWeights = DEFAULT_SEVERITY_WEIGHTS,
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

  if (changedSymbol.exported) {
    score *= validatedWeights.exported;
    explain.exported = true;
  }

  const fanInCounts = fanInByFile ?? getCachedFanInByFile(index);
  const fanIn = fanInCounts.get(ref.file) ?? 0;
  if (fanIn > 0) {
    const fanInFactor = 1 + Math.min(Math.log10(fanIn + 1), 1);
    score *= fanInFactor;
    explain.fanIn = fanIn;
  }

  if (ref.file === changedSymbol.file) {
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

  return {
    severity: Math.min(1.0, Math.max(0.0, score)),
    confidence: Math.min(1.0, Math.max(0.0, confidence)),
    explain,
  };
}

export function calculateTransitiveSeverity(edge: Edge, depth: number): number {
  let score = 0.3;
  if (edge.typeOnly) {
    score *= 0.6;
  }
  score *= Math.pow(0.7, depth);
  return score;
}
