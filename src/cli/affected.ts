import pm from "picomatch";
import { buildProjectIndex } from "../indexer/build-index.js";
import type { BuildOptions, ProjectIndex } from "../indexer/types.js";
import { getReverseNeighbors, graphAdjacencyFor } from "../graphs/adjacency.js";
import { createGraphFileResolver, normalizeImpactFileChange } from "../impact/path.js";
import { getDiff } from "../impact/providers/base.js";
import { compileTestPatterns, createIndexTestFileMatcher, isTestFilePath } from "../impact/testPatterns.js";
import type { FileChange } from "../impact/types.js";
import { listDirectDeletedFileImporters } from "../review/deleted.js";
import type { FileId } from "../types.js";
import { normalizePath, resolveFilePathWithinRoot, toProjectDisplayPath } from "../util/paths.js";
import { parseNonNegativeIntegerOption } from "./options.js";

export type AffectedTestEntry = {
  file: string;
  reasons: string[];
  depth: number;
};

export type AffectedOmittedCounts = {
  changedFiles: number;
  filteredTests: number;
};

export type AffectedTestsReport = {
  schemaVersion: 1;
  root: string;
  changedFiles: string[];
  affectedTests: AffectedTestEntry[];
  omittedCounts: AffectedOmittedCounts;
};

export type AffectedCommandContext = {
  projectRootFs: string;
  buildOptions: BuildOptions;
  positionals: readonly string[];
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  parsedOptions: ReadonlyMap<string, readonly string[]>;
  readStdin: () => Promise<string>;
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
  writeStderrLine: (message: string) => void;
  exit: (code: number) => never;
};

type AffectedTestAccumulator = {
  file: string;
  reasons: Set<string>;
  depth: number;
};

type ChangedFileInputs = {
  files: string[];
  deletedFiles: string[];
};

type AffectedTraversalState = {
  index: ProjectIndex;
  projectRoot: string;
  maxDepth: number;
  matchesTestFile: (file: FileId) => boolean;
  passesFilter: (file: string) => boolean;
};

function parseStdinFiles(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeChangedFileInput(projectRoot: string, input: string): string {
  const resolved = resolveFilePathWithinRoot(projectRoot, input, "Changed file");
  if (resolved.status === "error") {
    throw new Error(resolved.error);
  }
  return normalizePath(resolved.file);
}

function createTestFilter(projectRoot: string, filters: readonly string[]): (file: string) => boolean {
  if (!filters.length) {
    return () => true;
  }
  const matchers = filters.map((filter) => pm(filter, { dot: true }));
  return (file: string): boolean => {
    const displayPath = toProjectDisplayPath(projectRoot, file);
    return matchers.some((matcher) => matcher(displayPath));
  };
}

function addAffectedTest(
  affected: Map<string, AffectedTestAccumulator>,
  file: string,
  reason: string,
  depth: number,
): void {
  const existing = affected.get(file);
  if (existing) {
    existing.reasons.add(reason);
    existing.depth = Math.min(existing.depth, depth);
    return;
  }
  affected.set(file, { file, reasons: new Set([reason]), depth });
}

function maybeAddTest(
  affected: Map<string, AffectedTestAccumulator>,
  state: AffectedTraversalState,
  file: string,
  reason: string,
  depth: number,
  omittedCounts: AffectedOmittedCounts,
): void {
  if (!state.matchesTestFile(file)) return;
  if (!state.passesFilter(file)) {
    omittedCounts.filteredTests += 1;
    return;
  }
  addAffectedTest(affected, file, reason, depth);
}

async function addDeletedImporterTests(
  affected: Map<string, AffectedTestAccumulator>,
  state: AffectedTraversalState,
  deletedFiles: readonly string[],
  omittedCounts: AffectedOmittedCounts,
): Promise<void> {
  if (!state.maxDepth) return;

  const adjacency = state.index.graphAdjacency ?? graphAdjacencyFor(state.index.graph);
  for (const deletedFile of deletedFiles) {
    const reasonSource = toProjectDisplayPath(state.projectRoot, deletedFile);
    const directImporters = await listDirectDeletedFileImporters(state.index, [deletedFile], state.projectRoot);
    const visited = new Set<string>();
    const queue: Array<{ file: string; depth: number }> = [];
    for (const importer of directImporters) {
      if (visited.has(importer.file)) continue;
      visited.add(importer.file);
      queue.push({ file: importer.file, depth: 1 });
    }

    let queueIndex = 0;
    while (queueIndex < queue.length) {
      const current = queue[queueIndex]!;
      queueIndex += 1;
      maybeAddTest(
        affected,
        state,
        current.file,
        `deleted import from ${reasonSource}, depth ${current.depth}`,
        current.depth,
        omittedCounts,
      );
      if (current.depth >= state.maxDepth) continue;
      const nextDepth = current.depth + 1;
      for (const neighbor of getReverseNeighbors(adjacency, current.file)) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push({ file: neighbor, depth: nextDepth });
      }
    }
  }
}

async function collectAffectedTests(
  changedFiles: readonly string[],
  deletedFiles: readonly string[],
  state: AffectedTraversalState,
): Promise<{ affected: Map<string, AffectedTestAccumulator>; omittedCounts: AffectedOmittedCounts }> {
  const affected = new Map<string, AffectedTestAccumulator>();
  const omittedCounts: AffectedOmittedCounts = { changedFiles: 0, filteredTests: 0 };
  const resolver = createGraphFileResolver(state.index.graph.nodes);
  const graphNodes = new Set(Array.from(state.index.graph.nodes, (node) => normalizePath(node)));
  const adjacency = state.index.graphAdjacency ?? graphAdjacencyFor(state.index.graph);
  const pathPatterns = compileTestPatterns(undefined);

  for (const changedFile of changedFiles) {
    const changedDisplayPath = toProjectDisplayPath(state.projectRoot, changedFile);
    const changedLooksLikeTest = isTestFilePath(changedDisplayPath, pathPatterns);
    if (changedLooksLikeTest) {
      maybeAddTest(affected, state, changedFile, "changed test file", 0, omittedCounts);
    }

    if (!state.maxDepth) continue;

    const startFile = resolver(changedFile);
    if (!graphNodes.has(normalizePath(startFile))) {
      omittedCounts.changedFiles += 1;
      continue;
    }

    const visited = new Set<string>([startFile]);
    const queue: Array<{ file: string; depth: number }> = [{ file: startFile, depth: 0 }];
    let queueIndex = 0;
    while (queueIndex < queue.length) {
      const current = queue[queueIndex]!;
      queueIndex += 1;
      if (current.depth >= state.maxDepth) continue;
      const nextDepth = current.depth + 1;
      for (const neighbor of getReverseNeighbors(adjacency, current.file)) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push({ file: neighbor, depth: nextDepth });
        maybeAddTest(
          affected,
          state,
          neighbor,
          `reverse dependency from ${changedDisplayPath}, depth ${nextDepth}`,
          nextDepth,
          omittedCounts,
        );
      }
    }
  }

  await addDeletedImporterTests(affected, state, deletedFiles, omittedCounts);
  return { affected, omittedCounts };
}

function formatAffectedEntry(projectRoot: string, entry: AffectedTestAccumulator): AffectedTestEntry {
  return {
    file: toProjectDisplayPath(projectRoot, entry.file),
    reasons: Array.from(entry.reasons).sort(),
    depth: entry.depth,
  };
}

function buildAffectedReport(
  projectRoot: string,
  changedFiles: readonly string[],
  affected: Map<string, AffectedTestAccumulator>,
  omittedCounts: AffectedOmittedCounts,
): AffectedTestsReport {
  const affectedTests = Array.from(affected.values())
    .map((entry) => formatAffectedEntry(projectRoot, entry))
    .sort((left, right) => left.file.localeCompare(right.file));
  return {
    schemaVersion: 1,
    root: normalizePath(projectRoot),
    changedFiles: changedFiles.map((file) => toProjectDisplayPath(projectRoot, file)).sort(),
    affectedTests,
    omittedCounts,
  };
}

function formatPrettyReport(report: AffectedTestsReport): string {
  const lines = ["Affected tests"];
  if (!report.affectedTests.length) {
    lines.push("- None detected.");
    return lines.join("\n");
  }
  for (const entry of report.affectedTests) {
    lines.push(`- ${entry.file} (${entry.reasons.join("; ")})`);
  }
  return lines.join("\n");
}

async function collectChangedFileInputs(context: AffectedCommandContext): Promise<ChangedFileInputs> {
  const inputs: string[] = [...context.positionals];
  const deletedFiles: string[] = [];
  if (context.hasFlag("--stdin")) {
    inputs.push(...parseStdinFiles(await context.readStdin()));
  }

  const base = context.getOpt("--base");
  const head = context.getOpt("--head");
  if ((base && !head) || (head && !base)) {
    throw new Error("--base and --head must be provided together for affected git diff input.");
  }
  if (base && head) {
    const diff = await getDiff({ provider: "git", base, head, cwd: context.projectRootFs });
    for (const change of diff.files) {
      const normalizedChange = normalizeImpactFileChange(context.projectRootFs, change);
      inputs.push(normalizedChange.path);
      for (const deletedFile of deletedPathsForChange(normalizedChange)) {
        deletedFiles.push(deletedFile);
      }
    }
  }

  return { files: inputs, deletedFiles };
}

function deletedPathsForChange(change: FileChange): string[] {
  if (change.kind === "deleted") {
    return [change.path];
  }
  if (change.kind === "renamed" && change.oldPath) {
    return [change.oldPath];
  }
  return [];
}

async function buildAffectedReportFromContext(context: AffectedCommandContext): Promise<AffectedTestsReport> {
  const inputs = await collectChangedFileInputs(context);
  if (!inputs.files.length) {
    throw new Error("Usage: codegraph affected <file...> [--stdin] [--base <ref> --head <ref>] [--root <path>]");
  }

  const normalizedChangedFiles = Array.from(
    new Set(inputs.files.map((input) => normalizeChangedFileInput(context.projectRootFs, input))),
  ).sort();
  const normalizedDeletedFiles = Array.from(
    new Set(inputs.deletedFiles.map((input) => normalizeChangedFileInput(context.projectRootFs, input))),
  ).sort();
  const depth = parseNonNegativeIntegerOption(context.getOpt("--depth"), "--depth", 1);
  const index = await buildProjectIndex(context.projectRootFs, context.buildOptions);
  const testPatterns = compileTestPatterns(undefined);
  const matchesTestFile = createIndexTestFileMatcher(
    index,
    testPatterns,
    context.projectRootFs,
    normalizedChangedFiles,
  );
  const passesFilter = createTestFilter(context.projectRootFs, context.parsedOptions.get("--filter") ?? []);
  const { affected, omittedCounts } = await collectAffectedTests(normalizedChangedFiles, normalizedDeletedFiles, {
    index,
    projectRoot: context.projectRootFs,
    maxDepth: depth,
    matchesTestFile,
    passesFilter,
  });
  return buildAffectedReport(context.projectRootFs, normalizedChangedFiles, affected, omittedCounts);
}

export async function handleAffectedCommand(context: AffectedCommandContext): Promise<void> {
  try {
    if (context.hasFlag("--json") && context.hasFlag("--quiet")) {
      throw new Error("Use either --json or --quiet for affected output, not both.");
    }
    const report = await buildAffectedReportFromContext(context);
    if (context.hasFlag("--json")) {
      context.writeJSONLine(report);
      return;
    }
    if (context.hasFlag("--quiet")) {
      for (const entry of report.affectedTests) {
        context.writeStdoutLine(entry.file);
      }
      return;
    }
    context.writeStdoutLine(formatPrettyReport(report));
  } catch (error) {
    context.writeStderrLine(error instanceof Error ? error.message : String(error));
    context.exit(2);
  }
}
