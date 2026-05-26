import path from "node:path";
import { findDuplicates } from "../duplicates.js";
import { findDetailedCycles, getHotspots, getUnresolvedImports, sortDetailedCycles } from "../graphs.js";
import { normalizePath } from "../util/paths.js";
import { formatAgentFileHandle } from "./handles.js";
import { createAgentSession, type AgentSession } from "./session.js";
import { quoteShellArg } from "./shell.js";

export type AgentOrientBudget = "small" | "medium" | "large";

export type AgentOrientRequest = {
  root: string;
  includeRoots?: string[];
  budget?: AgentOrientBudget;
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
  kind: "file";
  handle: string;
  label: string;
  file: string;
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
    cycles: number;
    unresolved: number;
    duplicateGroups: number;
  };
  handles: AgentPacketHandle[];
  recommendedNext: AgentPacketCommand[];
  omittedCounts: {
    treeEntries: number;
    hotspots: number;
    handles: number;
  };
};

const ORIENT_BUDGETS: Record<
  AgentOrientBudget,
  { treeDepth: number; maxTreeEntries: number; maxHandles: number; maxHotspots: number }
> = {
  small: { treeDepth: 2, maxTreeEntries: 80, maxHandles: 20, maxHotspots: 8 },
  medium: { treeDepth: 3, maxTreeEntries: 160, maxHandles: 40, maxHotspots: 15 },
  large: { treeDepth: 4, maxTreeEntries: 320, maxHandles: 80, maxHotspots: 25 },
};

export async function orientCodegraph(request: AgentOrientRequest): Promise<AgentOrientResponse> {
  const root = path.resolve(request.root);
  const session = createAgentSession({ root });
  return await orientCodegraphWithSession(session, { ...request, root });
}

export async function orientCodegraphWithSession(
  session: AgentSession,
  request: AgentOrientRequest,
): Promise<AgentOrientResponse> {
  const budget = request.budget ?? "small";
  const limits = ORIENT_BUDGETS[budget];
  const includeRoots = normalizeIncludeRoots(request.includeRoots ?? []);
  const snapshot = await session.loadProject();
  const root = snapshot.root;
  const projectFiles = snapshot.files.map((file) => normalizeRelativePath(root, file));
  const scopedFiles = projectFiles.filter((file) => isUnderIncludeRoots(file, includeRoots));
  const tree = buildTree(scopedFiles, limits.treeDepth);
  const boundedTree = tree.slice(0, limits.maxTreeEntries);
  const hotspots = getHotspots(snapshot.fileGraph, { limit: limits.maxHotspots });
  const scopedHotspots = hotspots
    .map((hotspot) => ({ ...hotspot, file: normalizeRelativePath(root, hotspot.file) }))
    .filter((hotspot) => isUnderIncludeRoots(hotspot.file, includeRoots));
  const modules = scopedHotspots.map((hotspot) => ({
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
  const cycles = sortDetailedCycles(findDetailedCycles(snapshot.fileGraph), "priority");
  const unresolved = getUnresolvedImports(snapshot.fileGraph, { projectRoot: root });
  const duplicateResult = await findDuplicates(snapshot.index, {
    projectRoot: root,
    limit: 0,
    minConfidence: "high",
  });
  const recommendedNext = buildRecommendedNext(scopedFiles, fileHandles);

  return {
    schemaVersion: 1,
    root,
    budget,
    summary: [
      `${scopedFiles.length} file(s) in scope.`,
      `${modules.length} hotspot module(s) surfaced for follow-up.`,
      `${cycles.length} cycle(s), ${unresolved.length} unresolved import group(s).`,
    ],
    tree: boundedTree,
    modules,
    health: {
      cycles: cycles.length,
      unresolved: unresolved.length,
      duplicateGroups: duplicateResult.groups.length + duplicateResult.omittedCounts.groups,
    },
    handles: fileHandles,
    recommendedNext,
    omittedCounts: {
      treeEntries: Math.max(0, tree.length - boundedTree.length),
      hotspots: Math.max(0, scopedHotspots.length - modules.length),
      handles: Math.max(0, scopedFiles.length - fileHandles.length),
    },
  };
}

function normalizeIncludeRoots(includeRoots: string[]): string[] {
  return includeRoots.map((root) => normalizePath(root).replace(/^\.?\//, "").replace(/\/$/, "")).filter(Boolean);
}

function normalizeRelativePath(root: string, file: string): string {
  const relative = path.isAbsolute(file) ? path.relative(root, file) : file;
  return normalizePath(relative);
}

function isUnderIncludeRoots(file: string, includeRoots: string[]): boolean {
  if (!includeRoots.length) return true;
  return includeRoots.some((root) => file === root || file.startsWith(`${root}/`));
}

function buildTree(files: string[], maxDepth: number): AgentTreeEntry[] {
  const entries = new Map<string, AgentTreeEntry>();
  for (const file of files) {
    const parts = file.split("/").filter(Boolean);
    const fileDepth = parts.length;
    for (let index = 1; index < fileDepth; index++) {
      if (index > maxDepth) continue;
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

function buildRecommendedNext(scopedFiles: string[], handles: AgentPacketHandle[]): AgentPacketCommand[] {
  const commands: AgentPacketCommand[] = [];
  const firstHandle = handles[0];
  if (firstHandle) {
    commands.push({
      label: `Get packet for ${firstHandle.file}`,
      command: `codegraph packet get ${quoteShellArg(firstHandle.handle)} --json`,
    });
  }
  if (scopedFiles.length) {
    const firstRoot = scopedFiles[0]?.split("/", 1)[0] ?? ".";
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
