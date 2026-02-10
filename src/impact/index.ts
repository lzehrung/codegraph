import path from "node:path";
import pm from "picomatch";
import type { ProjectIndex } from "../indexer.js";
import { findReferences } from "../indexer.js";
import type {
  ImpactReport,
  CompactImpactReport,
  ImpactOptions,
  ChangedSymbol,
  FileChange,
  ImpactSuggestion,
} from "./types.js";
import { getDiff } from "./providers/base.js";
import { locateChangedSymbols } from "./map.js";
import { analyzeImpact } from "./analyzer.js";
import { buildImpactReport } from "./report.js";
import { collectImpactSuggestions } from "./suggestions.js";
import { listCandidateTestFiles } from "./context.js";

export * from "./types.js";
export { analyzeImpactStreaming, type ImpactStreamChunk } from "./streaming.js";

const CONFIG_FILE_RE =
  /(^|\/)(?:tsconfig(?:\.[^.\/]+)?\.json|jsconfig\.json|vite\.config\.[cm]?[jt]s|webpack\.config\.[cm]?[jt]s|rollup\.config\.[cm]?[jt]s|esbuild\.config\.[cm]?[jt]s|babel\.config\.[cm]?[jt]s|\.eslintrc(?:\.[^.\/]+)?|prettier\.config\.[cm]?[jt]s|package\.json|pnpm-workspace\.ya?ml|lerna\.json|turbo\.json|nx\.json|\.env(?:\.[^\/]*)?)$/i;

function normalizeFilePath(projectRoot: string, filePath: string): string {
  return path.isAbsolute(filePath)
    ? filePath.replace(/\\/g, "/")
    : path.resolve(projectRoot, filePath).replace(/\\/g, "/");
}

function collectRemovedLines(change: FileChange): Set<number> {
  const removed = new Set<number>();
  for (const hunk of change.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith(" ")) {
        oldLine += 1;
        newLine += 1;
        continue;
      }
      if (line.startsWith("-")) {
        const mapped = newLine > 0 ? newLine : oldLine;
        removed.add(mapped);
        oldLine += 1;
        continue;
      }
      if (line.startsWith("+")) {
        newLine += 1;
      }
    }
  }
  return removed;
}

function matchesConfigSemantics(filePath: string): boolean {
  return CONFIG_FILE_RE.test(filePath);
}

function collectAddedLines(change: FileChange): string[] {
  const added: string[] = [];
  for (const hunk of change.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added.push(line.slice(1));
    }
  }
  return added;
}

function classifyConfigImpact(
  change: FileChange,
): { details: string; confidence: "high" | "medium" } {
  const lowerPath = change.path.toLowerCase();
  const addedLines = collectAddedLines(change).join("\n").toLowerCase();
  if (lowerPath.endsWith("package.json")) {
    if (addedLines.includes('"scripts"')) {
      return {
        details:
          "package.json scripts changed; CI/build workflows may be affected across packages.",
        confidence: "medium",
      };
    }
    if (
      addedLines.includes('"dependencies"') ||
      addedLines.includes('"devdependencies"')
    ) {
      return {
        details:
          "package.json dependency graph changed; dependency resolution can affect multiple workspaces.",
        confidence: "high",
      };
    }
  }
  if (lowerPath.endsWith("tsconfig.json") || lowerPath.endsWith("jsconfig.json")) {
    return {
      details:
        "TypeScript/JavaScript compiler config changed; type-checking and module resolution can shift project-wide.",
      confidence: "high",
    };
  }
  if (lowerPath.includes(".env")) {
    return {
      details:
        "Environment configuration changed; runtime behavior may differ across services and deploy environments.",
      confidence: "medium",
    };
  }
  return {
    details:
      "Configuration change detected; impact can be broad and may require full-project validation.",
    confidence: "high",
  };
}

async function collectConfigAndBreakingSuggestions(
  index: ProjectIndex,
  projectRoot: string,
  fileChanges: FileChange[],
  changedSymbols: ChangedSymbol[],
  opts: { configImpactRules: boolean; detectBreakingChanges: boolean },
): Promise<ImpactSuggestion[]> {
  const suggestions: ImpactSuggestion[] = [];
  const removedLinesByFile = new Map<string, Set<number>>();

  for (const fileChange of fileChanges) {
    const normalized = normalizeFilePath(projectRoot, fileChange.path);
    removedLinesByFile.set(normalized, collectRemovedLines(fileChange));
    if (!opts.configImpactRules || !matchesConfigSemantics(fileChange.path))
      continue;

    const configSemantics = classifyConfigImpact(fileChange);
    suggestions.push({
      file: normalized,
      kind: "configImpact",
      details: configSemantics.details,
      confidence: configSemantics.confidence,
    });
  }

  if (opts.detectBreakingChanges) {
    for (const symbol of changedSymbols) {
      if (!symbol.exported) continue;
      const removedLines = removedLinesByFile.get(symbol.file);
      if (!removedLines || removedLines.size === 0) continue;
      const symbolStart = symbol.range.start.line;
      const symbolEnd = symbol.range.end.line;
      let overlapsRemoval = false;
      for (const line of removedLines) {
        if (line < symbolStart || line > symbolEnd) continue;
        overlapsRemoval = true;
        break;
      }
      if (!overlapsRemoval) continue;

      suggestions.push({
        file: symbol.file,
        range: symbol.range,
        kind: "breakingChange",
        symbol: symbol.name,
        details:
          "Exported symbol overlaps removed lines; verify call sites for potential breaking changes.",
        confidence: "medium",
      });
    }

    for (const fileChange of fileChanges) {
      const normalized = normalizeFilePath(projectRoot, fileChange.path);
      const removedLines = removedLinesByFile.get(normalized);
      if (!removedLines || removedLines.size === 0) continue;
      const mod = index.byFile.get(normalized);
      const hasExports = (mod?.exports.length ?? 0) > 0;
      const alreadyHasForFile = suggestions.some(
        (entry) => entry.kind === "breakingChange" && entry.file === normalized,
      );
      if (!hasExports || alreadyHasForFile) continue;
      suggestions.push({
        file: normalized,
        kind: "breakingChange",
        details:
          "Removed lines in a module with exports may indicate breaking API changes.",
        confidence: "low",
      });
    }
  }

  return suggestions;
}

async function collectUntestedChangeSuggestions(
  index: ProjectIndex,
  changedSymbols: ChangedSymbol[],
): Promise<ImpactSuggestion[]> {
  const suggestions: ImpactSuggestion[] = [];
  const testFiles = new Set<string>();
  for (const file of index.byFile.keys()) {
    if (/(^|\/)__tests__\//i.test(file) || /\.(?:test|spec)\./i.test(file)) {
      testFiles.add(file);
    }
  }

  const candidateTests = listCandidateTestFiles(
    index,
    Array.from(new Set(changedSymbols.map((entry) => entry.file))),
    changedSymbols.map((entry) => entry.id),
    { maxCandidates: 3 },
  );

  for (const symbol of changedSymbols) {
    const refs = await findReferences(index, {
      def: {
        file: symbol.file,
        localName: symbol.name,
        kind: symbol.kind,
        range: symbol.range,
      },
    });
    if (refs.status !== "ok") continue;

    const hasTestRef = refs.references.some((entry) =>
      testFiles.has(entry.file),
    );
    if (hasTestRef) continue;

    const candidateNames = candidateTests
      .filter((entry) => entry.file !== symbol.file)
      .slice(0, 2)
      .map((entry) => path.basename(entry.file));
    const details =
      candidateNames.length > 0
        ? `Changed symbol has no discovered references in test files. Consider adding or updating tests such as: ${candidateNames.join(", ")}.`
        : "Changed symbol has no discovered references in test files.";

    suggestions.push({
      file: symbol.file,
      range: symbol.range,
      kind: "untestedChange",
      symbol: symbol.name,
      details,
      confidence: "medium",
    });
  }

  return suggestions;
}

export async function analyzeImpactFromDiff(
  projectRoot: string,
  index: ProjectIndex,
  options: ImpactOptions,
): Promise<ImpactReport | CompactImpactReport> {
  // Get the diff
  const diff = await getDiff(options);

  const { ignoreGlobs = [] } = options;
  const isIgnored = ignoreGlobs.length > 0 ? pm(ignoreGlobs) : () => false;

  // Filter out ignored files from diff
  const filteredFiles =
    ignoreGlobs.length > 0
      ? diff.files.filter((f) => !isIgnored(f.path))
      : diff.files;

  // Map all changed files to changed symbols
  let changedSymbols: ChangedSymbol[] = [];
  for (const fileChange of filteredFiles) {
    const absPath = normalizeFilePath(projectRoot, fileChange.path);
    const symbols = await locateChangedSymbols(
      index,
      absPath,
      fileChange.hunks,
    );
    changedSymbols.push(...symbols);
  }

  // Honor scope option: only consider exported symbols if scope=imported
  if (options.scope === "imported") {
    changedSymbols = changedSymbols.filter((s) => s.exported);
  }

  // Analyze impact
  const impactedItems = await analyzeImpact(
    index,
    changedSymbols,
    filteredFiles,
    options,
  );

  const suggestions = options.verifyReferences
    ? await collectImpactSuggestions(index, projectRoot, filteredFiles, options)
    : [];

  const configAndBreaking =
    options.configImpactRules || options.detectBreakingChanges
      ? await collectConfigAndBreakingSuggestions(
          index,
          projectRoot,
          filteredFiles,
          changedSymbols,
          {
            configImpactRules: !!options.configImpactRules,
            detectBreakingChanges: !!options.detectBreakingChanges,
          },
        )
      : [];

  const coverageSuggestions = options.testCoverageSuggestions
    ? await collectUntestedChangeSuggestions(index, changedSymbols)
    : [];

  const mergedSuggestions = [
    ...suggestions,
    ...configAndBreaking,
    ...coverageSuggestions,
  ];

  // Build report
  return await buildImpactReport(
    projectRoot,
    index,
    filteredFiles,
    changedSymbols,
    impactedItems,
    mergedSuggestions,
    { ...options, warning: diff.warning },
  );
}

// Re-export functions for testing and advanced usage
export { seedTransitiveFromFiles, calculateSeverity } from "./analyzer.js";
export {
  collectImpactContext,
  listCandidateTestFiles,
  type ImpactContext,
  type CandidateTestFile,
} from "./context.js";
