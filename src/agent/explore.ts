import path from "node:path";
import type { AnalysisSummary } from "../analysisSummary.js";
import { getReverseDependencies, getShortestPath, type DependencyNode } from "../graphs/traversal.js";
import type { BuildOptions } from "../indexer/types.js";
import { toProjectDisplayPath } from "../util/paths.js";
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
  const anchorFiles = collectAnchorFiles(snapshot, request.query, anchors);
  const packetTargets = includeSource ? collectPacketTargets(anchors, effectivePacketLimit) : [];
  const packets = await collectPackets(session, request.root, packetTargets);
  const pathResult = collectDependencyPaths(snapshot, request.query, anchorFiles, maxPaths);
  const paths = pathResult.items;
  const blastRadius = collectBlastRadius(
    snapshot,
    anchorFiles,
    DEFAULT_MAX_BLAST_RADIUS_ENTRIES,
    DEFAULT_MAX_REVERSE_DEPENDENCIES,
  );
  const candidateTestResult = collectCandidateTests(snapshot, anchorFiles, DEFAULT_MAX_CANDIDATE_TESTS);
  const candidateTests = candidateTestResult.items;
  const followUps = collectFollowUps(request.root, request.query, anchors, packets, anchorFiles, includeSource);

  return {
    schemaVersion: 1,
    query: request.query,
    analysis: search.analysis,
    summary: buildSummary(search, packets, paths, blastRadius, candidateTests),
    anchors,
    packets,
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
  const seen = new Set<string>();
  for (const anchor of anchors) {
    const target = anchor.kind === "file" ? anchor.file : anchor.handle;
    if (seen.has(target)) continue;
    seen.add(target);
    targets.push(target);
    if (targets.length >= limit) break;
  }
  return targets;
}

function collectAnchorFiles(
  snapshot: AgentProjectSnapshot,
  query: string,
  anchors: readonly AgentSearchResult[],
): string[] {
  const files = new Set<string>();
  for (const file of extractFileMentions(snapshot, query)) {
    files.add(file);
  }
  for (const anchor of anchors) {
    const absolute = path.resolve(snapshot.root, anchor.file);
    if (snapshot.fileGraph.nodes.has(absolute)) {
      files.add(absolute);
    }
  }
  return [...files];
}

function extractFileMentions(snapshot: AgentProjectSnapshot, query: string): string[] {
  const normalizedQuery = normalizeQueryPathText(query);
  const explicitFiles: string[] = [];
  const basenameMatches = new Map<string, string[]>();
  for (const file of snapshot.fileGraph.nodes) {
    const relative = toProjectDisplayPath(snapshot.root, file);
    const normalizedRelative = normalizeQueryPathText(relative);
    if (normalizedQuery.includes(normalizedRelative)) {
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

function normalizeQueryPathText(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
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
  limit: number,
): AgentExploreCollection<string> {
  const tests = candidateTestsForAnchors(snapshot, anchorFiles);
  return {
    items: tests.slice(0, limit),
    omittedCount: Math.max(0, tests.length - limit),
  };
}

function candidateTestsForAnchors(snapshot: AgentProjectSnapshot, anchorFiles: readonly string[]): string[] {
  const candidateNames = new Set<string>();
  for (const file of anchorFiles) {
    candidateNames.add(normalizeStem(path.basename(file)));
    for (const dependency of getReverseDependencies(snapshot.fileGraph, file, {
      depth: 2,
      limit: DEFAULT_MAX_REVERSE_DEPENDENCIES,
    })) {
      candidateNames.add(normalizeStem(path.basename(dependency.file)));
    }
  }
  const candidateNameList = [...candidateNames];
  const tests: string[] = [];
  for (const file of snapshot.fileGraph.nodes) {
    const relative = toProjectDisplayPath(snapshot.root, file);
    if (!looksLikeTestFile(relative)) continue;
    const testStem = normalizeStem(path.basename(relative));
    if (candidateNameList.some((candidateName) => testStem.includes(candidateName))) {
      tests.push(relative);
    }
  }
  return tests.sort();
}

function looksLikeTestFile(file: string): boolean {
  const normalized = file.toLowerCase();
  return /(^|[/.])(test|tests|__tests__)([/.]|$)/.test(normalized) || /\.(test|spec)\.[^.]+$/.test(normalized);
}

function normalizeStem(name: string): string {
  return name
    .replace(/\.(test|spec)\.[^.]+$/i, "")
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
}

function collectFollowUps(
  root: string,
  query: string,
  anchors: readonly AgentSearchResult[],
  packets: readonly AgentPacketResponse[],
  anchorFiles: readonly string[],
  includeSource: boolean,
): string[] {
  const followUps: string[] = [];
  for (const file of anchorFiles.slice(0, 3)) {
    const relative = toProjectDisplayPath(root, file);
    followUps.push(`codegraph packet get ${quoteShellArg(relative)} --pretty`);
  }
  for (const anchor of anchors) {
    followUps.push(...anchor.followUps);
  }
  for (const packet of packets) {
    followUps.push(...packet.followUps);
  }
  for (const file of anchorFiles.slice(0, 3)) {
    const relative = toProjectDisplayPath(root, file);
    followUps.push(`codegraph refs --file ${quoteShellArg(relative)} --line 1 --col 0 --pretty`);
  }
  if (!includeSource) {
    followUps.push(`codegraph explore ${quoteShellArg(query)} --pretty`);
  }
  if (!anchors.length) {
    followUps.push(`codegraph search ${quoteShellArg(query)} --json`);
    followUps.push("codegraph orient --budget small --pretty");
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
): string[] {
  if (!search.results.length) {
    return [`No anchors matched "${search.query}".`, "Use follow-ups to broaden the search or orient the repository."];
  }
  const summary = [`Found ${search.results.length} anchor(s) for "${search.query}".`];
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
