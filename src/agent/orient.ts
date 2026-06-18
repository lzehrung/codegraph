import path from "node:path";
import { findDuplicates } from "../duplicates.js";
import { findDetailedCycles } from "../graphs/cycles.js";
import { getHotspots } from "../graphs/hotspots.js";
import { getUnresolvedImports } from "../graphs/unresolved.js";
import type { BuildOptions } from "../indexer/types.js";
import type { Graph } from "../types.js";
import { normalizePath } from "../util/paths.js";
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

type AgentModuleSummary = {
  file: string;
  fanIn: number;
  fanOut: number;
  score: number;
};

type AgentPacketRef = {
  id: number;
  kind: "file";
  file: string;
};

export type AgentOrientationFocus = {
  id?: number;
  kind: "hotspot" | "file" | "review";
  label?: string;
  file?: string;
  why: string;
  followUps: string[];
};

export type AgentPacketCommand = {
  label: string;
  command: string;
};

export type AgentOrientResponse = {
  schemaVersion: 2;
  root: string;
  budget: AgentOrientBudget;
  summary: string[];
  focus: AgentOrientationFocus[];
  tree: AgentTreeEntry[];
  health: {
    cycles: number | null;
    unresolved: number | null;
    duplicateGroups: number | null;
  };
  recommendedNext: AgentPacketCommand[];
  omittedCounts: {
    treeEntries: number;
    focusTargets: number;
    healthAnalyses: number;
  };
};

const ORIENT_BUDGETS: Record<
  AgentOrientBudget,
  {
    treeDepth: number;
    maxTreeEntries: number;
    maxFocusTargets: number;
    maxHotspots: number;
    includeHealth: boolean;
  }
> = {
  small: { treeDepth: 2, maxTreeEntries: 25, maxFocusTargets: 5, maxHotspots: 5, includeHealth: false },
  medium: { treeDepth: 3, maxTreeEntries: 80, maxFocusTargets: 10, maxHotspots: 10, includeHealth: true },
  large: { treeDepth: 4, maxTreeEntries: 160, maxFocusTargets: 15, maxHotspots: 15, includeHealth: true },
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
  }));
  const packets = buildFilePackets(
    scopedFiles,
    modules.map((module) => module.file),
    limits.maxFocusTargets,
  );
  const focus = buildFocusTargets(modules, packets, request.review);
  const healthMode = request.health ?? (limits.includeHealth ? "summary" : "skip");
  const health = await buildHealth(root, snapshot.index, scopedAbsoluteFiles, scopedFileGraph, healthMode);
  const recommendedNext = buildRecommendedNext(includeRoots, focus);
  const healthSummary = formatHealthSummary(health);

  return {
    schemaVersion: 2,
    root,
    budget,
    summary: [
      `${scopedFiles.length} file(s) in scope.`,
      `${modules.length} graph-central module(s) ranked for first follow-up.`,
      healthSummary,
    ],
    focus,
    tree: boundedTree,
    health: {
      cycles: health.cycles,
      unresolved: health.unresolved,
      duplicateGroups: health.duplicateGroups,
    },
    recommendedNext,
    omittedCounts: {
      treeEntries: Math.max(0, tree.length - boundedTree.length),
      focusTargets: Math.max(0, scopedFiles.length - packets.length),
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

function buildReviewFocus(base: string, head: string): AgentOrientationFocus {
  return {
    kind: "review",
    label: `Review ${base}..${head}`,
    why: "review range requested by the caller",
    followUps: [
      `codegraph review --base ${quoteShellArg(base)} --head ${quoteShellArg(head)} --summary`,
      `codegraph impact --base ${quoteShellArg(base)} --head ${quoteShellArg(head)} --pretty`,
    ],
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

function buildFilePackets(scopedFiles: string[], priorityFiles: string[], maxPackets: number): AgentPacketRef[] {
  if (!maxPackets) return [];
  const scopedFileSet = new Set(scopedFiles);
  const seen = new Set<string>();
  const orderedFiles: string[] = [];
  for (const file of priorityFiles) {
    if (!scopedFileSet.has(file) || seen.has(file)) continue;
    seen.add(file);
    orderedFiles.push(file);
  }
  for (const file of scopedFiles) {
    if (seen.has(file)) continue;
    seen.add(file);
    orderedFiles.push(file);
  }
  return orderedFiles.slice(0, maxPackets).map((file, index) => ({
    id: index + 1,
    kind: "file" as const,
    file,
  }));
}

function buildFocusTargets(
  modules: AgentModuleSummary[],
  packets: AgentPacketRef[],
  review: AgentOrientRequest["review"] | undefined,
): AgentOrientationFocus[] {
  const focus: AgentOrientationFocus[] = [];
  if (review) {
    focus.push(buildReviewFocus(review.base, review.head));
  }
  const modulesByFile = new Map(modules.map((module) => [module.file, module]));
  for (const packet of packets) {
    const module = modulesByFile.get(packet.file);
    if (module) {
      focus.push({
        id: packet.id,
        kind: "hotspot" as const,
        file: module.file,
        why: `graph-central module: fan-in ${module.fanIn}, fan-out ${module.fanOut}, score ${module.score}`,
        followUps: [formatPacketCommand(packet.file), `codegraph explain ${formatFileTargetCommandArg(module.file)}`],
      });
      continue;
    }
    focus.push({
      id: packet.id,
      kind: "file" as const,
      file: packet.file,
      why: "bounded file packet candidate inside the requested scope",
      followUps: [formatPacketCommand(packet.file)],
    });
  }
  return focus;
}

function buildRecommendedNext(includeRoots: string[], focus: AgentOrientationFocus[]): AgentPacketCommand[] {
  const commands: AgentPacketCommand[] = [];
  const firstFocus = focus[0];
  if (firstFocus) {
    for (const followUp of firstFocus.followUps) {
      commands.push({
        label: labelForFollowUp(firstFocus, followUp),
        command: followUp,
      });
    }
  }
  const firstRoot = includeRoots[0] ?? ".";
  commands.push({
    label: "Rank scoped hotspots",
    command: `codegraph hotspots ${quoteShellArg(firstRoot)} --limit 20`,
  });
  commands.push({
    label: "Map current worktree impact",
    command: "codegraph impact --base HEAD --head WORKTREE --pretty",
  });
  commands.push({
    label: "Review current worktree",
    command: "codegraph review --base HEAD --head WORKTREE --summary",
  });
  commands.push({
    label: "Search for a task-specific anchor",
    command: "codegraph search <query> --json",
  });
  return commands;
}

function formatPacketCommand(file: string): string {
  return `codegraph packet get ${formatFileTargetCommandArg(file)} --pretty`;
}

function formatFileTargetCommandArg(file: string): string {
  const target = fileNeedsRelativePrefix(file) ? `./${file}` : file;
  return quoteShellArg(target);
}

function fileNeedsRelativePrefix(file: string): boolean {
  return (
    file.startsWith("-") ||
    file.startsWith("file:") ||
    file.startsWith("symbol:") ||
    file.startsWith("chunk:") ||
    file.startsWith("sql:") ||
    file.startsWith("graph:") ||
    file.startsWith("review:")
  );
}

function labelForFollowUp(focus: AgentOrientationFocus, followUp: string): string {
  const label = focus.file ?? focus.label ?? "focus target";
  if (followUp.startsWith("codegraph packet get ")) return `Get packet for ${label}`;
  if (followUp.startsWith("codegraph explain ")) return `Explain ${label}`;
  if (followUp.startsWith("codegraph review ")) return `Review ${label}`;
  if (followUp.startsWith("codegraph impact ")) return `Map impact for ${label}`;
  return label;
}
