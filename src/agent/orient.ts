import path from "node:path";
import { findDuplicates } from "../duplicates.js";
import { findDetailedCycles } from "../graphs/cycles.js";
import { getHotspots } from "../graphs/hotspots.js";
import { getUnresolvedImports } from "../graphs/unresolved.js";
import type { BuildOptions } from "../indexer/types.js";
import type { Graph } from "../types.js";
import { normalizePath } from "../util/paths.js";
import { formatAgentFileHandle } from "./handles.js";
import { createAgentSession, type AgentSession } from "./session.js";
import { quoteShellArg } from "./shell.js";

export type AgentOrientBudget = "small" | "medium" | "large";
export type AgentOrientHealthMode = "skip" | "summary" | "full";

export type AgentOrientRequest = {
  root: string;
  includeRoots?: string[];
  budget?: AgentOrientBudget;
  health?: AgentOrientHealthMode;
  buildOptions?: BuildOptions;
  review?: {
    base: string;
    head: string;
  };
};

export type AgentTreeEntry = {
  path: string;
  kind: "directory" | "file";
  depth: number;
};

export type AgentModuleSummary = {
  file: string;
  fanIn: number;
  fanOut: number;
  score: number;
  handle: string;
};

export type AgentPacketHandle = {
  kind: "file" | "review";
  handle: string;
  label: string;
  file?: string;
};

export type AgentPacketCommand = {
  label: string;
  command: string;
};

export type AgentOrientResponse = {
  schemaVersion: 1;
  root: string;
  budget: AgentOrientBudget;
  summary: string[];
  tree: AgentTreeEntry[];
  modules: AgentModuleSummary[];
  health: {
    cycles: number | null;
    unresolved: number | null;
    duplicateGroups: number | null;
  };
  handles: AgentPacketHandle[];
  recommendedNext: AgentPacketCommand[];
  omittedCounts: {
    treeEntries: number;
    hotspots: number;
    handles: number;
    healthAnalyses: number;
  };
};

const ORIENT_BUDGETS: Record<
  AgentOrientBudget,
  {
    treeDepth: number;
    maxTreeEntries: number;
    maxHandles: number;
    maxHotspots: number;
    includeHealth: boolean;
  }
> = {
  small: { treeDepth: 2, maxTreeEntries: 80, maxHandles: 20, maxHotspots: 8, includeHealth: false },
  medium: { treeDepth: 3, maxTreeEntries: 160, maxHandles: 40, maxHotspots: 15, includeHealth: true },
  large: { treeDepth: 4, maxTreeEntries: 320, maxHandles: 80, maxHotspots: 25, includeHealth: true },
};

export async function orientCodegraph(request: AgentOrientRequest): Promise<AgentOrientResponse> {
  const root = path.resolve(request.root);
  const session = createAgentSession({
    root,
    ...(request.buildOptions ? { buildOptions: request.buildOptions } : {}),
  });
  return await orientCodegraphWithSession(session, { ...request, root });
}

export async function orientCodegraphWithSession(
  session: AgentSession,
  request: AgentOrientRequest,
): Promise<AgentOrientResponse> {
  const budget = request.budget ?? "small";
  const limits = ORIENT_BUDGETS[budget];
  const snapshot = await session.loadProject({ symbolGraph: "skip" });
  const root = snapshot.root;
  const includeRoots = normalizeIncludeRoots(root, request.includeRoots ?? []);
  const projectFiles = snapshot.files.map((file) => normalizeRelativePath(root, file));
  const scopedFiles = projectFiles.filter((file) => isUnderIncludeRoots(file, includeRoots));
  const scopedFileSet = new Set(scopedFiles);
  const scopedAbsoluteFiles = snapshot.files.filter((file) => scopedFileSet.has(normalizeRelativePath(root, file)));
  const scopedFileGraph = buildScopedGraph(snapshot.fileGraph, root, scopedFileSet);
  const tree = buildTree(scopedFiles, limits.treeDepth);
  const boundedTree = tree.slice(0, limits.maxTreeEntries);
  const hotspots = getHotspots(scopedFileGraph);
  const scopedHotspots = hotspots
    .map((hotspot) => ({ ...hotspot, file: normalizeRelativePath(root, hotspot.file) }))
    .filter((hotspot) => scopedFileSet.has(hotspot.file) && hotspot.score);
  const boundedHotspots = scopedHotspots.slice(0, limits.maxHotspots);
  const modules = boundedHotspots.map((hotspot) => ({
    file: hotspot.file,
    fanIn: hotspot.fanIn,
    fanOut: hotspot.fanOut,
    score: hotspot.score,
    handle: formatAgentFileHandle({ file: hotspot.file }),
  }));
  const fileHandles = scopedFiles.slice(0, limits.maxHandles).map((file) => ({
    kind: "file" as const,
    handle: formatAgentFileHandle({ file }),
    label: file,
    file,
  }));
  const reviewHandles = request.review ? [buildReviewPacketHandle(request.review.base, request.review.head)] : [];
  const healthMode = request.health ?? (limits.includeHealth ? "summary" : "skip");
  const health = await buildHealth(root, snapshot.index, scopedAbsoluteFiles, scopedFileGraph, healthMode);
  const handles = [...reviewHandles, ...fileHandles];
  const recommendedNext = buildRecommendedNext(scopedFiles, includeRoots, handles);
  const healthSummary = formatHealthSummary(health);

  return {
    schemaVersion: 1,
    root,
    budget,
    summary: [
      `${scopedFiles.length} file(s) in scope.`,
      `${modules.length} hotspot module(s) surfaced for follow-up.`,
      healthSummary,
    ],
    tree: boundedTree,
    modules,
    health: {
      cycles: health.cycles,
      unresolved: health.unresolved,
      duplicateGroups: health.duplicateGroups,
    },
    handles,
    recommendedNext,
    omittedCounts: {
      treeEntries: Math.max(0, tree.length - boundedTree.length),
      hotspots: Math.max(0, scopedHotspots.length - boundedHotspots.length),
      handles: Math.max(0, scopedFiles.length + reviewHandles.length - handles.length),
      healthAnalyses: health.omittedAnalyses,
    },
  };
}

async function buildHealth(
  root: string,
  index: Parameters<typeof findDuplicates>[0],
  files: string[],
  graph: Graph,
  healthMode: AgentOrientHealthMode,
): Promise<{
  cycles: number | null;
  unresolved: number | null;
  duplicateGroups: number | null;
  omittedAnalyses: number;
}> {
  if (healthMode === "skip") {
    return {
      cycles: null,
      unresolved: null,
      duplicateGroups: null,
      omittedAnalyses: 3,
    };
  }
  const cycles = findDetailedCycles(graph);
  const unresolved = getUnresolvedImports(graph, { projectRoot: root });
  if (healthMode === "summary") {
    return {
      cycles: cycles.length,
      unresolved: unresolved.length,
      duplicateGroups: null,
      omittedAnalyses: 1,
    };
  }
  const duplicateResult = await findDuplicates(index, {
    projectRoot: root,
    files,
    limit: 0,
    minConfidence: "high",
  });
  return {
    cycles: cycles.length,
    unresolved: unresolved.length,
    duplicateGroups: duplicateResult.groups.length + duplicateResult.omittedCounts.groups,
    omittedAnalyses: 0,
  };
}

function formatHealthSummary(health: {
  cycles: number | null;
  unresolved: number | null;
  duplicateGroups: number | null;
  omittedAnalyses: number;
}): string {
  if (health.cycles === null || health.unresolved === null) {
    return "Health analysis skipped for small budget.";
  }
  if (health.duplicateGroups === null) {
    return `${health.cycles} cycle(s), ${health.unresolved} unresolved import group(s); duplicate health skipped.`;
  }
  return `${health.cycles} cycle(s), ${health.unresolved} unresolved import group(s), ${health.duplicateGroups} duplicate group(s).`;
}

function buildReviewPacketHandle(base: string, head: string): AgentPacketHandle {
  const handle = `review:base=${encodeURIComponent(base)};head=${encodeURIComponent(head)}`;
  return {
    kind: "review",
    handle,
    label: `Review ${base}..${head}`,
  };
}

function normalizeIncludeRoots(root: string, includeRoots: string[]): string[] {
  return includeRoots
    .map((includeRoot) => {
      const relativeRoot = path.isAbsolute(includeRoot) ? path.relative(root, includeRoot) : includeRoot;
      return normalizePath(relativeRoot)
        .replace(/^\.?\//, "")
        .replace(/\/$/, "");
    })
    .filter((includeRoot) => includeRoot && includeRoot !== ".");
}

function normalizeRelativePath(root: string, file: string): string {
  const relative = path.isAbsolute(file) ? path.relative(root, file) : file;
  return normalizePath(relative);
}

function isUnderIncludeRoots(file: string, includeRoots: string[]): boolean {
  if (!includeRoots.length) return true;
  return includeRoots.some((root) => file === root || file.startsWith(`${root}/`));
}

function buildScopedGraph(graph: Graph, root: string, scopedFiles: ReadonlySet<string>): Graph {
  const nodes = new Set<string>();
  for (const node of graph.nodes) {
    if (scopedFiles.has(normalizeRelativePath(root, node))) {
      nodes.add(node);
    }
  }
  const edges = graph.edges.filter((edge) => {
    if (!nodes.has(edge.from)) return false;
    return edge.to.type !== "file" || nodes.has(edge.to.path);
  });
  return { nodes, edges };
}

function buildTree(files: string[], maxDepth: number): AgentTreeEntry[] {
  const entries = new Map<string, AgentTreeEntry>();
  for (const file of files) {
    const parts = file.split("/").filter(Boolean);
    const fileDepth = parts.length;
    for (let index = 1; index < fileDepth; index++) {
      if (index > maxDepth) break;
      const directory = parts.slice(0, index).join("/");
      entries.set(directory, { path: directory, kind: "directory", depth: index });
    }
    if (fileDepth <= maxDepth) {
      entries.set(file, { path: file, kind: "file", depth: fileDepth });
    }
  }
  return Array.from(entries.values()).sort(compareTreeEntries);
}

function compareTreeEntries(left: AgentTreeEntry, right: AgentTreeEntry): number {
  const leftParent = parentPath(left.path);
  const rightParent = parentPath(right.path);
  if (leftParent !== rightParent) {
    if (leftParent < rightParent) return -1;
    return 1;
  }
  if (left.kind !== right.kind) {
    return left.kind === "directory" ? -1 : 1;
  }
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function parentPath(file: string): string {
  const separator = file.lastIndexOf("/");
  if (separator < 0) return "";
  return file.slice(0, separator);
}

function buildRecommendedNext(
  scopedFiles: string[],
  includeRoots: string[],
  handles: AgentPacketHandle[],
): AgentPacketCommand[] {
  const commands: AgentPacketCommand[] = [];
  const firstHandle = handles[0];
  if (firstHandle) {
    const label = firstHandle.file ?? firstHandle.label;
    commands.push({
      label: `Get packet for ${label}`,
      command: `codegraph packet get ${quoteShellArg(firstHandle.handle)} --json`,
    });
  }
  if (scopedFiles.length) {
    const firstRoot = includeRoots[0] ?? ".";
    commands.push({
      label: "Inspect hotspots",
      command: `codegraph hotspots ${quoteShellArg(firstRoot)} --limit 20 --json`,
    });
  }
  commands.push({
    label: "Search for an anchor",
    command: "codegraph search <query> --json",
  });
  return commands;
}
