import path from "node:path";
import type { AnalysisSummary } from "../analysisSummary.js";
import { getReverseDependencies, getShortestPath, type DependencyNode } from "../graphs/traversal.js";
import { defNodeId } from "../graphs/symbol-graph.js";
import type { BuildOptions } from "../indexer/types.js";
import { listCandidateTestFiles } from "../impact/context.js";
import { normalizePath, toProjectDisplayPath } from "../util/paths.js";
import { parseAgentSymbolHandle } from "./handles.js";
import {
  formatAgentFileViewResponse,
  getCodegraphFileViewWithSession,
  type AgentFileViewResponse,
} from "./fileView.js";
import { getCodegraphPacketWithSession, type AgentPacketResponse } from "./packet.js";
import { searchCodegraphWithSession, type AgentSearchResponse, type AgentSearchResult } from "./search.js";
import { createAgentSession, type AgentProjectSnapshot, type AgentSession } from "./session.js";
import { quoteShellArg } from "./shell.js";

export type AgentExploreRequest = {
  root: string;
  query: string;
  buildOptions?: BuildOptions;
  limit?: number;
  maxPackets?: number;
  maxPaths?: number;
  includeSource?: boolean;
  includeGraphContext?: boolean;
  allowSensitive?: boolean;
};

export type AgentExplorePacketSummary = AgentPacketResponse;

export type AgentExploreDependencyPathSummary = {
  from: string;
  to: string;
  path: string[];
};

export type AgentExploreBlastRadiusSummary = {
  file: string;
  reverseDependencies: Array<{ file: string; depth: number }>;
  omittedLowerBound: number;
};

export type AgentExploreLimits = {
  anchors: number;
  packets: number;
  paths: number;
  blastRadiusEntries: number;
  reverseDependencies: number;
  candidateTests: number;
};

export type AgentExploreOmittedCounts = {
  anchors: number;
  packets: number;
  paths: number;
  blastRadius: number;
  blastRadiusEntries: number;
  candidateTests: number;
};

export type AgentExploreResponse = {
  schemaVersion: 1;
  query: string;
  analysis: AnalysisSummary;
  summary: string[];
  anchors: AgentSearchResult[];
  packets: AgentExplorePacketSummary[];
  fileView?: AgentFileViewResponse;
  paths: AgentExploreDependencyPathSummary[];
  blastRadius: AgentExploreBlastRadiusSummary[];
  candidateTests: string[];
  followUps: string[];
  limits: AgentExploreLimits;
  omittedCounts: AgentExploreOmittedCounts;
};

type AgentExploreCollection<T> = {
  items: T[];
  omittedCount: number;
};

type AgentExploreAnchorSelection = {
  files: string[];
  symbolIds: string[];
};

const DEFAULT_ANCHOR_LIMIT = 5;
const DEFAULT_MAX_PACKETS = 3;
const DEFAULT_MAX_PATHS = 3;
const DEFAULT_MAX_REVERSE_DEPENDENCIES = 20;
const DEFAULT_MAX_BLAST_RADIUS_ENTRIES = DEFAULT_ANCHOR_LIMIT;
const DEFAULT_MAX_CANDIDATE_TESTS = 10;
const MAX_ANCHOR_LIMIT = 50;
const MAX_PACKET_LIMIT = 10;
const MAX_PATH_LIMIT = 10;

export async function exploreCodegraph(request: AgentExploreRequest): Promise<AgentExploreResponse> {
  const session = createAgentSession({
    root: request.root,
    ...(request.buildOptions ? { buildOptions: request.buildOptions } : {}),
  });
  return await exploreCodegraphWithSession(session, request);
}

export async function exploreCodegraphWithSession(
  session: AgentSession,
  request: AgentExploreRequest,
): Promise<AgentExploreResponse> {
  const anchorLimit = boundedNonNegativeInteger(request.limit, DEFAULT_ANCHOR_LIMIT, MAX_ANCHOR_LIMIT);
  const maxPackets = boundedNonNegativeInteger(request.maxPackets, DEFAULT_MAX_PACKETS, MAX_PACKET_LIMIT);
  const maxPaths = boundedNonNegativeInteger(request.maxPaths, DEFAULT_MAX_PATHS, MAX_PATH_LIMIT);
  const includeSource = request.includeSource ?? true;
  const effectivePacketLimit = includeSource ? maxPackets : 0;
  const search = await searchCodegraphWithSession(session, {
    root: request.root,
    query: request.query,
    limit: anchorLimit,
    includeSnippets: includeSource,
  });
  const snapshot = await session.loadProject({ symbolGraph: "skip" });
  const anchors = search.results.slice(0, anchorLimit);
  const anchorSelection = collectAnchorSelection(snapshot, request.query, anchors);
  const anchorFiles = anchorSelection.files;
  const packetTargets = includeSource ? collectPacketTargets(anchors, effectivePacketLimit) : [];
  const packets = await collectPackets(session, request.root, packetTargets);
  const exactFile = includeSource ? resolveExactFileTarget(snapshot, request.query) : undefined;
  let fileView: AgentFileViewResponse | undefined;
  if (exactFile) {
    fileView = await getCodegraphFileViewWithSession(session, {
      root: request.root,
      file: toProjectDisplayPath(snapshot.root, exactFile),
      ...(request.includeGraphContext !== undefined ? { includeGraphContext: request.includeGraphContext } : {}),
      ...(request.allowSensitive !== undefined ? { allowSensitive: request.allowSensitive } : {}),
      ...(request.buildOptions ? { buildOptions: request.buildOptions } : {}),
    });
  }
  const pathResult = collectDependencyPaths(snapshot, request.query, anchorFiles, maxPaths);
  const paths = pathResult.items;
  const blastRadius = collectBlastRadius(
    snapshot,
    anchorFiles,
    DEFAULT_MAX_BLAST_RADIUS_ENTRIES,
    DEFAULT_MAX_REVERSE_DEPENDENCIES,
  );
  const candidateTestResult = collectCandidateTests(
    snapshot,
    anchorFiles,
    anchorSelection.symbolIds,
    DEFAULT_MAX_CANDIDATE_TESTS,
  );
  const candidateTests = candidateTestResult.items;
  const followUps = collectFollowUps(request.root, request.query, anchors, packets, anchorFiles, includeSource);

  return {
    schemaVersion: 1,
    query: request.query,
    analysis: search.analysis,
    summary: buildSummary(search, packets, paths, blastRadius, candidateTests, fileView),
    anchors,
    packets,
    ...(fileView ? { fileView } : {}),
    paths,
    blastRadius,
    candidateTests,
    followUps,
    limits: {
      anchors: anchorLimit,
      packets: effectivePacketLimit,
      paths: maxPaths,
      blastRadiusEntries: DEFAULT_MAX_BLAST_RADIUS_ENTRIES,
      reverseDependencies: DEFAULT_MAX_REVERSE_DEPENDENCIES,
      candidateTests: DEFAULT_MAX_CANDIDATE_TESTS,
    },
    omittedCounts: {
      anchors: search.omittedCounts.results,
      packets: includeSource
        ? Math.max(0, collectPacketTargets(anchors, Number.POSITIVE_INFINITY).length - packetTargets.length)
        : 0,
      paths: pathResult.omittedCount,
      blastRadius: blastRadius.reduce((sum, entry) => sum + entry.omittedLowerBound, 0),
      blastRadiusEntries: Math.max(0, anchorFiles.length - blastRadius.length),
      candidateTests: candidateTestResult.omittedCount,
    },
  };
}

export function formatAgentExploreResponse(response: AgentExploreResponse): string {
  const lines: string[] = ["Summary"];
  if (response.summary.length) {
    lines.push(...response.summary.map((entry) => `- ${entry}`));
  } else {
    lines.push("- No summary available.");
  }

  lines.push("", "Anchors");
  if (response.anchors.length) {
    for (const anchor of response.anchors) {
      lines.push(`- ${anchor.label} [${anchor.kind}] ${anchor.file}`);
    }
  } else {
    lines.push("- No anchors found.");
  }

  if (response.fileView) {
    lines.push("", "File view", formatAgentFileViewResponse(response.fileView));
  }

  lines.push("", "Relevant source");
  if (response.packets.length) {
    for (const packet of response.packets) {
      lines.push(`- ${packet.target} [${packet.kind}]`);
      for (const summary of packetSummaryLines(packet).slice(0, 3)) {
        lines.push(`  - ${summary}`);
      }
    }
  } else if ((response.limits.packets ?? 0) <= 0) {
    lines.push("- Source packets disabled by limit or option.");
  } else if (!response.anchors.length) {
    lines.push("- No anchors found for source packets.");
  } else {
    lines.push("- No source packets found.");
  }

  lines.push("", "Paths");
  if (response.paths.length) {
    for (const entry of response.paths) {
      lines.push(`- ${entry.from} -> ${entry.to}: ${entry.path.join(" -> ")}`);
    }
  } else {
    lines.push("- No dependency paths found.");
  }

  lines.push("", "Blast radius");
  if (response.blastRadius.length) {
    for (const entry of response.blastRadius) {
      const files = entry.reverseDependencies.map((dependency) => dependency.file).join(", ");
      const suffix = entry.omittedLowerBound ? `, at least ${entry.omittedLowerBound} omitted` : "";
      lines.push(`- ${entry.file}: ${files || "no reverse dependencies"}${suffix}`);
    }
  } else {
    lines.push("- No reverse dependencies found.");
  }

  lines.push("", "Candidate tests");
  if (response.candidateTests.length) {
    lines.push(...response.candidateTests.map((file) => `- ${file}`));
  } else {
    lines.push("- None detected.");
  }

  lines.push("", "Follow-ups");
  lines.push(...response.followUps.map((entry) => `- ${entry}`));

  lines.push("", "Limits");
  for (const [name, value] of Object.entries(response.limits)) {
    lines.push(`- ${name}: ${value}`);
  }
  const recommended = response.followUps[0] ?? "codegraph orient --root . --budget small";
  lines.push("", `Recommended next: ${recommended}`);
  return lines.join("\n");
}

function packetSummaryLines(packet: AgentPacketResponse): string[] {
  const payload = packet.packet;
  if (!("summary" in payload)) return [];
  return Array.isArray(payload.summary) ? payload.summary : [];
}

function boundedNonNegativeInteger(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(value)));
}

function collectPackets(
  session: AgentSession,
  root: string,
  targets: readonly string[],
): Promise<AgentPacketResponse[]> {
  return Promise.all(
    targets.map(
      async (target) =>
        await getCodegraphPacketWithSession(session, {
          root,
          target,
        }),
    ),
  );
}

function collectPacketTargets(anchors: readonly AgentSearchResult[], limit: number): string[] {
  const targets: string[] = [];
  const seenTargets = new Set<string>();
  const seenFiles = new Set<string>();
  const append = (anchor: AgentSearchResult): void => {
    const target = anchor.kind === "file" ? anchor.file : anchor.handle;
    if (seenTargets.has(target)) return;
    seenTargets.add(target);
    targets.push(target);
  };

  for (const anchor of anchors) {
    if (seenFiles.has(anchor.file)) continue;
    seenFiles.add(anchor.file);
    append(anchor);
    if (targets.length >= limit) return targets;
  }
  for (const anchor of anchors) {
    append(anchor);
    if (targets.length >= limit) break;
  }
  return targets;
}

function collectAnchorSelection(
  snapshot: AgentProjectSnapshot,
  query: string,
  anchors: readonly AgentSearchResult[],
): AgentExploreAnchorSelection {
  const explicitFiles = extractFileMentions(snapshot, query).sort((left, right) => {
    const leftPath = toProjectDisplayPath(snapshot.root, left);
    const rightPath = toProjectDisplayPath(snapshot.root, right);
    if (leftPath < rightPath) return -1;
    if (leftPath > rightPath) return 1;
    return 0;
  });
  const files = new Set(explicitFiles);
  const symbolIds = new Set<string>();
  for (const anchor of anchors) {
    const absolute = normalizePath(path.resolve(snapshot.root, anchor.file));
    if (snapshot.fileGraph.nodes.has(absolute)) files.add(absolute);
    const symbolId = resolveAnchorSymbolId(snapshot, anchor);
    if (symbolId) symbolIds.add(symbolId);
  }
  return {
    files: [...files],
    symbolIds: [...symbolIds],
  };
}

function resolveAnchorSymbolId(snapshot: AgentProjectSnapshot, anchor: AgentSearchResult): string | undefined {
  const parsed = parseAgentSymbolHandle(anchor.handle);
  if (!parsed) return undefined;
  const absolute = normalizePath(path.resolve(snapshot.root, parsed.file));
  const symbol = snapshot.index.byFile
    .get(absolute)
    ?.locals.find(
      (candidate) =>
        candidate.localName === parsed.name &&
        candidate.range.start.line === parsed.line &&
        candidate.range.start.column === parsed.column,
    );
  return symbol ? defNodeId(symbol) : undefined;
}

function extractFileMentions(snapshot: AgentProjectSnapshot, query: string): string[] {
  const normalizedQuery = normalizeQueryPathText(query);
  const explicitFiles: string[] = [];
  const basenameMatches = new Map<string, string[]>();
  for (const file of snapshot.fileGraph.nodes) {
    const relative = toProjectDisplayPath(snapshot.root, file);
    const normalizedRelative = normalizeQueryPathText(relative);
    if (includesStandalonePathMention(normalizedQuery, normalizedRelative)) {
      explicitFiles.push(file);
      continue;
    }
    const basename = path.basename(relative).toLowerCase();
    const bucket = basenameMatches.get(basename) ?? [];
    bucket.push(file);
    basenameMatches.set(basename, bucket);
  }

  for (const token of tokenizeQuery(query)) {
    const matches = basenameMatches.get(token);
    if (matches?.length === 1) {
      explicitFiles.push(matches[0]!);
    }
  }
  return uniqueFiles(explicitFiles);
}

function resolveExactFileTarget(snapshot: AgentProjectSnapshot, query: string): string | undefined {
  const normalizedQuery = normalizeQueryPathText(query.trim());
  if (!normalizedQuery) return undefined;
  const containsWhitespace = /\s/.test(normalizedQuery);
  const basenameMatches: string[] = [];
  for (const file of snapshot.fileGraph.nodes) {
    const relative = normalizeQueryPathText(toProjectDisplayPath(snapshot.root, file));
    if (relative === normalizedQuery) return file;
    if (!containsWhitespace && path.basename(relative).toLowerCase() === normalizedQuery) basenameMatches.push(file);
  }
  return basenameMatches.length === 1 ? basenameMatches[0] : undefined;
}

function normalizeQueryPathText(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function includesStandalonePathMention(query: string, target: string): boolean {
  let start = query.indexOf(target);
  while (start !== -1) {
    const end = start + target.length;
    const before = start > 0 ? query[start - 1] : undefined;
    const after = end < query.length ? query[end] : undefined;
    if (isPathMentionBoundary(before) && isPathMentionBoundary(after)) return true;
    start = query.indexOf(target, start + 1);
  }
  return false;
}

function isPathMentionBoundary(char: string | undefined): boolean {
  if (char === undefined) return true;
  return /[\s"'`()\[\]{},.:;?!#]/.test(char);
}

function tokenizeQuery(query: string): string[] {
  return query
    .split(/\s+/)
    .map((token) => token.replace(/^["'`([{]+|["'`\])},.:;?!]+$/g, "").toLowerCase())
    .filter((token) => token.length > 0);
}

function uniqueFiles(files: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    out.push(file);
  }
  return out;
}

function collectDependencyPaths(
  snapshot: AgentProjectSnapshot,
  query: string,
  anchorFiles: readonly string[],
  maxPaths: number,
): AgentExploreCollection<AgentExploreDependencyPathSummary> {
  const paths: AgentExploreDependencyPathSummary[] = [];
  let omittedCount = 0;
  if (!shouldCollectPaths(query, anchorFiles)) return { items: paths, omittedCount };
  if (maxPaths <= 0) return { items: paths, omittedCount };
  for (let fromIndex = 0; fromIndex < anchorFiles.length; fromIndex += 1) {
    for (let toIndex = 0; toIndex < anchorFiles.length; toIndex += 1) {
      if (fromIndex === toIndex) continue;
      const from = anchorFiles[fromIndex]!;
      const to = anchorFiles[toIndex]!;
      const pathResult = getShortestPath(snapshot.fileGraph, from, to);
      if (!pathResult || pathResult.length < 2) continue;
      if (paths.length < maxPaths) {
        paths.push({
          from: toProjectDisplayPath(snapshot.root, from),
          to: toProjectDisplayPath(snapshot.root, to),
          path: pathResult.map((file) => toProjectDisplayPath(snapshot.root, file)),
        });
      } else {
        omittedCount = 1;
        return { items: paths, omittedCount };
      }
    }
  }
  return { items: paths, omittedCount };
}

function shouldCollectPaths(query: string, anchorFiles: readonly string[]): boolean {
  if (anchorFiles.length < 2) return false;
  const normalized = query.toLowerCase();
  return /\b(reach|flow|call|through|path|depend|from)\b/.test(normalized);
}

function collectBlastRadius(
  snapshot: AgentProjectSnapshot,
  anchorFiles: readonly string[],
  entryLimit: number,
  dependencyLimit: number,
): AgentExploreBlastRadiusSummary[] {
  const summaries: AgentExploreBlastRadiusSummary[] = [];
  for (const file of anchorFiles.slice(0, entryLimit)) {
    const dependencies = getReverseDependencies(snapshot.fileGraph, file, { limit: dependencyLimit + 1, depth: 2 });
    const visible = dependencies.slice(0, dependencyLimit).map((dependency) => formatDependency(snapshot, dependency));
    summaries.push({
      file: toProjectDisplayPath(snapshot.root, file),
      reverseDependencies: visible,
      omittedLowerBound: Math.max(0, dependencies.length - dependencyLimit),
    });
  }
  return summaries;
}

function formatDependency(snapshot: AgentProjectSnapshot, dependency: DependencyNode): { file: string; depth: number } {
  return {
    file: toProjectDisplayPath(snapshot.root, dependency.file),
    depth: dependency.depth,
  };
}

function collectCandidateTests(
  snapshot: AgentProjectSnapshot,
  anchorFiles: readonly string[],
  anchorSymbolIds: readonly string[],
  limit: number,
): AgentExploreCollection<string> {
  if (!anchorFiles.length && !anchorSymbolIds.length) return { items: [], omittedCount: 0 };
  const candidates = listCandidateTestFiles(snapshot.index, [...anchorFiles], [...anchorSymbolIds], {
    maxCandidates: snapshot.index.byFile.size,
    projectRoot: snapshot.root,
  });
  return {
    items: candidates.slice(0, limit).map((candidate) => toProjectDisplayPath(snapshot.root, candidate.file)),
    omittedCount: Math.max(0, candidates.length - limit),
  };
}

function collectFollowUps(
  root: string,
  query: string,
  anchors: readonly AgentSearchResult[],
  packets: readonly AgentPacketResponse[],
  anchorFiles: readonly string[],
  includeSource: boolean,
): string[] {
  const orderedFiles = [...anchorFiles];
  const followUps: string[] = [];
  for (const file of orderedFiles.slice(0, 3)) {
    const relative = toProjectDisplayPath(root, file);
    followUps.push(`codegraph file ${quoteShellArg(relative)}`);
  }
  for (const file of orderedFiles.slice(0, 3)) {
    const relative = toProjectDisplayPath(root, file);
    followUps.push(`codegraph packet get ${quoteShellArg(relative)}`);
  }
  for (const anchor of anchors) {
    followUps.push(...anchor.followUps);
  }
  for (const packet of packets) {
    followUps.push(...packet.followUps);
  }
  for (const file of orderedFiles.slice(0, 3)) {
    const relative = toProjectDisplayPath(root, file);
    followUps.push(`codegraph refs ${quoteShellArg(`${relative}:1:0`)}`);
  }
  if (!includeSource) {
    followUps.push(`codegraph explore ${quoteShellArg(query)}`);
  }
  if (!anchors.length) {
    followUps.push(`codegraph search ${quoteShellArg(query)} --json`);
    followUps.push("codegraph orient --budget small");
  }
  return dedupeStrings(followUps).slice(0, 12);
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function buildSummary(
  search: AgentSearchResponse,
  packets: readonly AgentPacketResponse[],
  paths: readonly AgentExploreDependencyPathSummary[],
  blastRadius: readonly AgentExploreBlastRadiusSummary[],
  candidateTests: readonly string[],
  fileView: AgentFileViewResponse | undefined,
): string[] {
  if (!search.results.length) {
    const summary = [
      `No anchors matched "${search.query}".`,
      "Use follow-ups to broaden the search or orient the repository.",
    ];
    if (search.analysis.mode !== "semantic") {
      summary.push(`Backend: ${search.analysis.label}. Run codegraph doctor for runtime diagnostics.`);
    }
    return summary;
  }
  const summary = [`Found ${search.results.length} anchor(s) for "${search.query}".`];
  if (search.analysis.mode !== "semantic") {
    summary.push(`Backend: ${search.analysis.label}. Run codegraph doctor for runtime diagnostics.`);
  }
  if (fileView) {
    summary.push(`Included live file view for ${fileView.file}.`);
  }
  if (packets.length) {
    summary.push(`Included ${packets.length} bounded source packet(s).`);
  }
  if (paths.length) {
    summary.push(`Found ${paths.length} dependency path(s).`);
  }
  if (blastRadius.length) {
    const reverseCount = blastRadius.reduce((sum, entry) => sum + entry.reverseDependencies.length, 0);
    summary.push(`Found ${reverseCount} reverse dependenc${reverseCount === 1 ? "y" : "ies"} across primary anchors.`);
  }
  if (candidateTests.length) {
    summary.push(`Detected ${candidateTests.length} candidate test file(s).`);
  }
  return summary;
}
