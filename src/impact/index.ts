import path from "node:path";
import fs from "node:fs/promises";
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
  const breakingByKey = new Map<string, ImpactSuggestion>();
  const removedLinesByFile = new Map<string, Set<number>>();
  const confidenceScore: Record<"low" | "medium" | "high", number> = {
    low: 1,
    medium: 2,
    high: 3,
  };

  const upsertBreakingSuggestion = (entry: ImpactSuggestion): void => {
    const key = `${entry.kind}::${entry.file}::${entry.symbol ?? ""}`;
    const existing = breakingByKey.get(key);
    if (!existing) {
      breakingByKey.set(key, entry);
      return;
    }
    const existingScore = confidenceScore[existing.confidence];
    const incomingScore = confidenceScore[entry.confidence];
    if (incomingScore > existingScore) {
      breakingByKey.set(key, entry);
    }
  };

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
    for (const fileChange of fileChanges) {
      const normalized = normalizeFilePath(projectRoot, fileChange.path);
      const signatureChanges = detectExportSignatureChanges(fileChange);
      for (const change of signatureChanges) {
        upsertBreakingSuggestion({
          file: normalized,
          kind: "breakingChange",
          symbol: change.name,
          details: change.details,
          confidence: change.confidence,
        });
      }
    }

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

      upsertBreakingSuggestion({
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
      const alreadyHasForFile = Array.from(breakingByKey.values()).some(
        (entry) => entry.file === normalized,
      );
      if (!hasExports || alreadyHasForFile) continue;
      upsertBreakingSuggestion({
        file: normalized,
        kind: "breakingChange",
        details:
          "Removed lines in a module with exports may indicate breaking API changes.",
        confidence: "low",
      });
    }
  }

  suggestions.push(...breakingByKey.values());
  return suggestions;
}

async function collectUntestedChangeSuggestions(
  index: ProjectIndex,
  changedSymbols: ChangedSymbol[],
  projectRoot: string,
  options?: { lcovPaths?: string[] },
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

  const coverageByFile = await loadCoverageByFile(projectRoot, options?.lcovPaths);

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

    const coverage = coverageByFile.get(symbol.file);
    const coveredLines = countCoveredLinesForRange(coverage, symbol.range);
    const totalLines = countTotalLinesForRange(coverage, symbol.range);
    const hasCoverageData = totalLines > 0;
    const hasCoveredLines = coveredLines > 0;

    const candidateNames = candidateTests
      .filter((entry) => entry.file !== symbol.file)
      .slice(0, 2)
      .map((entry) => path.basename(entry.file));
    const coverageSummary = hasCoverageData
      ? hasCoveredLines
        ? `Coverage currently exercises ${coveredLines}/${totalLines} changed line(s).`
        : `Coverage currently exercises 0/${totalLines} changed line(s).`
      : "No LCOV coverage data matched this symbol range.";
    const suggestedCommand =
      candidateNames.length > 0
        ? `Suggested command: npm run test -- ${candidateNames[0]}`
        : "Suggested command: npm run test";

    const details =
      candidateNames.length > 0
        ? `Changed symbol has no discovered references in test files. ${coverageSummary} Consider adding or updating tests such as: ${candidateNames.join(", ")}. ${suggestedCommand}`
        : `Changed symbol has no discovered references in test files. ${coverageSummary} ${suggestedCommand}`;

    const confidence = hasCoverageData
      ? hasCoveredLines
        ? "medium"
        : "high"
      : "medium";

    suggestions.push({
      file: symbol.file,
      range: symbol.range,
      kind: "untestedChange",
      symbol: symbol.name,
      details,
      confidence,
    });
  }

  return suggestions;
}

type ExportSignature = {
  name: string;
  paramCount: number;
};

type ExportSignatureWithLocation = ExportSignature & {
  hunkIndex: number;
  line: number;
};

type SignatureChange = {
  name: string;
  details: string;
  confidence: "high" | "medium";
};

function countParams(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 0;

  let count = 0;
  let sawNonWhitespaceSinceLastComma = false;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let typeAngleDepth = 0;
  let stringQuote: '"' | "'" | "`" | null = null;
  let escaped = false;
  let inTypeAnnotation = false;

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (!ch) continue;

    if (stringQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === stringQuote) {
        stringQuote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      stringQuote = ch;
      escaped = false;
      continue;
    }

    if (ch === "(") {
      parenDepth += 1;
      continue;
    }
    if (ch === ")") {
      if (parenDepth > 0) parenDepth -= 1;
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
      continue;
    }
    if (ch === "]") {
      if (bracketDepth > 0) bracketDepth -= 1;
      continue;
    }
    if (ch === "{") {
      braceDepth += 1;
      continue;
    }
    if (ch === "}") {
      if (braceDepth > 0) braceDepth -= 1;
      continue;
    }
    const atTopLevel =
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0 &&
      typeAngleDepth === 0;

    if (ch === ":") {
      if (atTopLevel) inTypeAnnotation = true;
      continue;
    }

    if (ch === "=") {
      if (atTopLevel) inTypeAnnotation = false;
      continue;
    }

    if (ch === "<") {
      if (inTypeAnnotation) typeAngleDepth += 1;
      continue;
    }

    if (ch === ">") {
      if (inTypeAnnotation && typeAngleDepth > 0) typeAngleDepth -= 1;
      continue;
    }

    if (ch === ",") {
      if (atTopLevel && sawNonWhitespaceSinceLastComma) {
        count += 1;
        sawNonWhitespaceSinceLastComma = false;
      }
      inTypeAnnotation = false;
      continue;
    }

    if (atTopLevel && !/\s/.test(ch)) {
      sawNonWhitespaceSinceLastComma = true;
    }
  }

  if (sawNonWhitespaceSinceLastComma) count += 1;
  return count;
}

function parseExportSignature(line: string): ExportSignature | null {
  const defaultFunctionMatch = line.match(
    /^\s*export\s+default\s+(?:async\s+)?function(?:\s+([A-Za-z_$][\w$]*))?(?:\s*<[^>]+>)?\s*\(([^)]*)\)/,
  );
  if (defaultFunctionMatch) {
    return {
      name: defaultFunctionMatch[1] ?? "default",
      paramCount: countParams(defaultFunctionMatch[2] ?? ""),
    };
  }

  const functionMatch = line.match(
    /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)(?:\s*<[^>]+>)?\s*\(([^)]*)\)/,
  );
  if (functionMatch) {
    const name = functionMatch[1];
    if (!name) return null;
    return {
      name,
      paramCount: countParams(functionMatch[2] ?? ""),
    };
  }

  const constArrowMatch = line.match(
    /^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:<[^>]+>\s*)?\(([^)]*)\)\s*=>/,
  );
  if (constArrowMatch) {
    const name = constArrowMatch[1];
    if (!name) return null;
    return {
      name,
      paramCount: countParams(constArrowMatch[2] ?? ""),
    };
  }

  const constArrowSingleParamMatch = line.match(
    /^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?([A-Za-z_$][\w$]*)\s*=>/,
  );
  if (constArrowSingleParamMatch) {
    const name = constArrowSingleParamMatch[1];
    if (!name) return null;
    return {
      name,
      paramCount: 1,
    };
  }

  return null;
}

function detectExportSignatureChanges(change: FileChange): SignatureChange[] {
  const removed: ExportSignatureWithLocation[] = [];
  const added: ExportSignatureWithLocation[] = [];

  for (let hunkIndex = 0; hunkIndex < change.hunks.length; hunkIndex += 1) {
    const hunk = change.hunks[hunkIndex]!;
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const rawLine of hunk.lines) {
      if (rawLine.startsWith(" ")) {
        oldLine += 1;
        newLine += 1;
        continue;
      }
      if (rawLine.startsWith("-")) {
        const parsed = parseExportSignature(rawLine.slice(1));
        if (parsed) {
          removed.push({
            ...parsed,
            line: oldLine,
            hunkIndex,
          });
        }
        oldLine += 1;
        continue;
      }
      if (rawLine.startsWith("+")) {
        const parsed = parseExportSignature(rawLine.slice(1));
        if (parsed) {
          added.push({
            ...parsed,
            line: newLine,
            hunkIndex,
          });
        }
        newLine += 1;
      }
    }
  }

  const addedByName = new Map<string, ExportSignatureWithLocation[]>();
  const addedByHunk = new Map<number, ExportSignatureWithLocation[]>();
  for (const entry of added) {
    const byName = addedByName.get(entry.name);
    if (byName) byName.push(entry);
    else addedByName.set(entry.name, [entry]);

    const byHunk = addedByHunk.get(entry.hunkIndex);
    if (byHunk) byHunk.push(entry);
    else addedByHunk.set(entry.hunkIndex, [entry]);
  }

  const output: SignatureChange[] = [];
  for (const removedSig of removed) {
    const matched = addedByName.get(removedSig.name)?.[0];
    if (matched && matched.paramCount !== removedSig.paramCount) {
      output.push({
        name: removedSig.name,
        details: `Exported function signature changed from ${removedSig.paramCount} parameter(s) to ${matched.paramCount}. This is likely a breaking API change.`,
        confidence: "high",
      });
      continue;
    }
    if (!matched && added.length > 0) {
      const candidates = addedByHunk.get(removedSig.hunkIndex) ?? [];
      const candidate = candidates.find(
        (entry) =>
          Math.abs(entry.line - removedSig.line) <= 3,
      );
      const renameDetails = candidate
        ? `Exported symbol ${removedSig.name} appears to be removed or renamed (for example ${candidate.name}). Verify backward compatibility for downstream imports.`
        : `Exported symbol ${removedSig.name} appears to be removed or renamed. Verify backward compatibility for downstream imports.`;
      output.push({
        name: removedSig.name,
        details: renameDetails,
        confidence: "medium",
      });
    }
  }

  return output;
}

type FileCoverage = {
  allLines: Set<number>;
  coveredLines: Set<number>;
};

async function loadCoverageByFile(
  projectRoot: string,
  lcovPaths?: string[],
): Promise<Map<string, FileCoverage>> {
  const coverage = new Map<string, FileCoverage>();
  if (!lcovPaths || lcovPaths.length === 0) return coverage;

  for (const lcovPath of lcovPaths) {
    const abs = path.isAbsolute(lcovPath)
      ? lcovPath
      : path.resolve(projectRoot, lcovPath);
    let text = "";
    try {
      text = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }

    let currentFile: string | null = null;
    for (const rawLine of text.split(/\r?\n/)) {
      if (rawLine.startsWith("SF:")) {
        const filePath = rawLine.slice(3).trim();
        if (!filePath) {
          currentFile = null;
          continue;
        }
        currentFile = normalizeFilePath(projectRoot, filePath);
        if (!coverage.has(currentFile)) {
          coverage.set(currentFile, {
            allLines: new Set<number>(),
            coveredLines: new Set<number>(),
          });
        }
        continue;
      }

      if (!currentFile || !rawLine.startsWith("DA:")) continue;
      const parts = rawLine.slice(3).split(",");
      const lineNo = Number(parts[0]);
      const hits = Number(parts[1]);
      if (!Number.isInteger(lineNo) || lineNo <= 0) continue;
      const fileCoverage = coverage.get(currentFile);
      if (!fileCoverage) continue;
      fileCoverage.allLines.add(lineNo);
      if (Number.isFinite(hits) && hits > 0) {
        fileCoverage.coveredLines.add(lineNo);
      }
    }
  }

  return coverage;
}

function countCoveredLinesForRange(
  coverage: FileCoverage | undefined,
  range: ChangedSymbol["range"],
): number {
  if (!coverage) return 0;
  let count = 0;
  for (let line = range.start.line; line <= range.end.line; line += 1) {
    if (coverage.coveredLines.has(line)) count += 1;
  }
  return count;
}

function countTotalLinesForRange(
  coverage: FileCoverage | undefined,
  range: ChangedSymbol["range"],
): number {
  if (!coverage) return 0;
  let count = 0;
  for (let line = range.start.line; line <= range.end.line; line += 1) {
    if (coverage.allLines.has(line)) count += 1;
  }
  return count;
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
    ? await collectUntestedChangeSuggestions(index, changedSymbols, projectRoot, {
        ...(options.lcovPaths ? { lcovPaths: options.lcovPaths } : {}),
      })
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
