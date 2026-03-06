import path from "node:path";
import fs from "node:fs/promises";
import pm from "picomatch";
import { SymbolKind, type ProjectIndex, findReferences } from "../indexer.js";
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
import { mapLimit } from "../util.js";
import { normalizeImpactFilePath } from "./path.js";

export * from "./types.js";
export { analyzeImpactStreaming, type ImpactStreamChunk } from "./streaming.js";

const CONFIG_FILE_RE =
  /(^|\/)(?:tsconfig(?:\.[^./]+)?\.json|jsconfig\.json|vite\.config\.[cm]?[jt]s|webpack\.config\.[cm]?[jt]s|rollup\.config\.[cm]?[jt]s|esbuild\.config\.[cm]?[jt]s|babel\.config\.[cm]?[jt]s|\.eslintrc(?:\.[^./]+)?|prettier\.config\.[cm]?[jt]s|package\.json|pnpm-workspace\.ya?ml|lerna\.json|turbo\.json|nx\.json|\.env(?:\.[^/]*)?)$/i;

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

function collectRemovedAndAddedLines(change: FileChange): string[] {
  const lines: string[] = [];
  for (const hunk of change.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+") || line.startsWith("-")) {
        lines.push(line.slice(1));
      }
    }
  }
  return lines;
}

function collectTsconfigPathAliases(change: FileChange): string[] {
  const aliases = new Set<string>();
  const keyRe = /"([^"\n]+)"\s*:\s*/;
  for (const line of collectRemovedAndAddedLines(change)) {
    const match = keyRe.exec(line);
    const key = match?.[1]?.trim();
    if (!key) continue;
    if (key.startsWith("@") || key.includes("/*") || key.includes("/")) {
      aliases.add(key);
    }
  }
  return [...aliases];
}

function aliasMatchesImport(alias: string, rawSpecifier: string): boolean {
  if (alias.endsWith("/*")) {
    const prefix = alias.slice(0, -1);
    return rawSpecifier.startsWith(prefix);
  }
  return rawSpecifier === alias;
}

function collectTsconfigBlastRadius(
  index: ProjectIndex,
  aliases: string[],
): { aliases: string[]; importers: string[] } {
  if (aliases.length === 0) {
    return { aliases: [], importers: [] };
  }
  const aliasSet = new Set(aliases);
  const importers = new Set<string>();
  for (const edge of index.graph.edges) {
    const raw = edge.raw?.trim();
    if (!raw || edge.to.type !== "file") continue;
    for (const alias of aliasSet) {
      if (!aliasMatchesImport(alias, raw)) continue;
      importers.add(edge.from);
      break;
    }
  }
  return {
    aliases: [...aliasSet],
    importers: [...importers],
  };
}

function collectWorkspaceManifestPaths(index: ProjectIndex): string[] {
  const out = new Set<string>();
  for (const node of index.graph.nodes) {
    if (!node.endsWith("/package.json")) continue;
    out.add(node);
  }
  return [...out];
}

function classifyConfigImpact(
  index: ProjectIndex,
  projectRoot: string,
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

  const isTsconfig =
    lowerPath.endsWith("tsconfig.json") || lowerPath.endsWith("jsconfig.json");
  if (isTsconfig) {
    const aliases = collectTsconfigPathAliases(change);
    const blastRadius = collectTsconfigBlastRadius(index, aliases);
    if (blastRadius.aliases.length > 0) {
      const relImporters = blastRadius.importers
        .slice(0, 5)
        .map((file) => path.relative(projectRoot, file).replace(/\\/g, "/"));
      const importerSummary =
        blastRadius.importers.length > 0
          ? `Likely impacted importer files: ${relImporters.join(", ")}${
              blastRadius.importers.length > relImporters.length ? ", ..." : ""
            }.`
          : "No existing imports currently match these aliases.";
      return {
        details: `TypeScript/JavaScript path aliases changed (${blastRadius.aliases.join(", ")}). ${importerSummary}`,
        confidence: "high",
      };
    }
    return {
      details:
        "TypeScript/JavaScript compiler config changed; type-checking and module resolution can shift project-wide.",
      confidence: "high",
    };
  }

  const isBuildToolConfig =
    lowerPath.includes("vite.config") ||
    lowerPath.includes("webpack.config") ||
    lowerPath.includes("rollup.config") ||
    lowerPath.includes("esbuild.config");
  if (isBuildToolConfig) {
    const signalParts: string[] = [];
    if (addedLines.includes("alias"))
      signalParts.push("module alias resolution");
    if (addedLines.includes("input") || addedLines.includes("entry")) {
      signalParts.push("entrypoint selection");
    }
    if (addedLines.includes("output") || addedLines.includes("outdir")) {
      signalParts.push("bundle output targets");
    }
    if (addedLines.includes("plugin"))
      signalParts.push("plugin execution order");
    if (addedLines.includes("define"))
      signalParts.push("compile-time constants");
    const detailsSuffix =
      signalParts.length > 0
        ? ` Detected changes touch ${signalParts.join(", ")}.`
        : "";
    return {
      details: `Build tool configuration changed (${path.basename(change.path)}); bundling and runtime artifact behavior may change.${detailsSuffix}`,
      confidence: "high",
    };
  }

  if (lowerPath.endsWith("turbo.json") || lowerPath.endsWith("nx.json")) {
    const workspaceManifests = collectWorkspaceManifestPaths(index);
    const affectsTasks =
      addedLines.includes("pipeline") ||
      addedLines.includes("tasks") ||
      addedLines.includes("dependsOn") ||
      addedLines.includes("cache") ||
      addedLines.includes("outputs");
    const scopeSummary =
      workspaceManifests.length > 0
        ? `${workspaceManifests.length} workspace package manifest(s) discovered.`
        : "Workspace package manifests were not discovered.";
    return {
      details: affectsTasks
        ? `Monorepo task orchestration config changed (${path.basename(change.path)}); task dependency graph, caching, or outputs may shift across packages. ${scopeSummary}`
        : `Monorepo config changed (${path.basename(change.path)}); cross-package task behavior may shift. ${scopeSummary}`,
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

function collectConfigAndBreakingSuggestions(
  index: ProjectIndex,
  projectRoot: string,
  fileChanges: FileChange[],
  changedSymbols: ChangedSymbol[],
  opts: { configImpactRules: boolean; detectBreakingChanges: boolean },
): ImpactSuggestion[] {
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
    const normalized = normalizeImpactFilePath(projectRoot, fileChange.path);
    removedLinesByFile.set(normalized, collectRemovedLines(fileChange));
    if (!opts.configImpactRules || !matchesConfigSemantics(fileChange.path))
      continue;

    const configSemantics = classifyConfigImpact(
      index,
      projectRoot,
      fileChange,
    );
    suggestions.push({
      file: normalized,
      kind: "configImpact",
      details: configSemantics.details,
      confidence: configSemantics.confidence,
    });
  }

  if (opts.detectBreakingChanges) {
    for (const fileChange of fileChanges) {
      const normalized = normalizeImpactFilePath(projectRoot, fileChange.path);
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
      const normalized = normalizeImpactFilePath(projectRoot, fileChange.path);
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

function isLikelyTestFile(filePath: string, extraPatterns?: string[]): boolean {
  const defaultPatterns = [
    /(^|\/)__tests__\//i,
    /\.(?:test|spec)\./i,
    /_test\.py$/i,
    /_test\.go$/i,
    /tests?\.py$/i,
  ];
  for (const pattern of defaultPatterns) {
    if (pattern.test(filePath)) return true;
  }
  if (!extraPatterns || extraPatterns.length === 0) return false;
  for (const raw of extraPatterns) {
    if (!raw.trim()) continue;
    try {
      const re = new RegExp(raw, "i");
      if (re.test(filePath)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function collectUntestedChangeSuggestions(
  index: ProjectIndex,
  changedSymbols: ChangedSymbol[],
  projectRoot: string,
  options?: {
    lcovPaths?: string[];
    coveragePaths?: string[];
    testCommandTemplate?: string;
    testPatterns?: string[];
  },
): Promise<ImpactSuggestion[]> {
  const suggestions: ImpactSuggestion[] = [];
  const testFiles = new Set<string>();
  for (const file of index.byFile.keys()) {
    if (isLikelyTestFile(file, options?.testPatterns)) {
      testFiles.add(file);
    }
  }

  const fanInByFile = new Map<string, number>();
  for (const edge of index.graph.edges) {
    if (edge.to.type !== "file") continue;
    const current = fanInByFile.get(edge.to.path) ?? 0;
    fanInByFile.set(edge.to.path, current + 1);
  }

  const candidateTests = listCandidateTestFiles(
    index,
    Array.from(new Set(changedSymbols.map((entry) => entry.file))),
    changedSymbols.map((entry) => entry.id),
    { maxCandidates: 3 },
  );

  const coverageOptions: { lcovPaths?: string[]; coveragePaths?: string[] } =
    {};
  if (options?.lcovPaths) coverageOptions.lcovPaths = options.lcovPaths;
  if (options?.coveragePaths)
    coverageOptions.coveragePaths = options.coveragePaths;
  const coverageByFile = await loadCoverageByFile(projectRoot, coverageOptions);

  const inferTestCommand = (candidateNames: string[]): string => {
    const template = options?.testCommandTemplate?.trim();
    if (template) {
      if (template.includes("{files}")) {
        const fileArg =
          candidateNames.length > 0 ? candidateNames.join(" ") : "";
        return template.replace("{files}", fileArg).trim();
      }
      return template;
    }
    const hasPnpm = index.graph.nodes.has(
      path.resolve(projectRoot, "pnpm-lock.yaml").replace(/\\/g, "/"),
    );
    const hasYarn = index.graph.nodes.has(
      path.resolve(projectRoot, "yarn.lock").replace(/\\/g, "/"),
    );
    const hasPackage = index.graph.nodes.has(
      path.resolve(projectRoot, "package.json").replace(/\\/g, "/"),
    );
    const runner = hasPnpm
      ? "pnpm"
      : hasYarn
        ? "yarn"
        : hasPackage
          ? "npm run"
          : "npm run";
    if (candidateNames.length === 0) {
      return runner === "npm run" ? "npm run test" : `${runner} test`;
    }
    const target = candidateNames[0]!;
    if (runner === "pnpm") return `pnpm test ${target}`;
    if (runner === "yarn") return `yarn test ${target}`;
    return `npm run test -- ${target}`;
  };

  const confidenceFromSignals = (signals: {
    hasCoverageData: boolean;
    coveredLines: number;
    totalLines: number;
    exported: boolean;
    fanIn: number;
    kind: ChangedSymbol["kind"];
  }): "low" | "medium" | "high" => {
    let score = 2;
    if (
      signals.hasCoverageData &&
      signals.coveredLines === 0 &&
      signals.totalLines > 0
    ) {
      score += 2;
    }
    if (!signals.hasCoverageData) score += 1;
    if (signals.exported) score += 1;
    if (signals.fanIn >= 3) score += 1;
    if (signals.kind === SymbolKind.Function) score += 1;
    if (signals.coveredLines > 0) score -= 1;
    if (score >= 5) return "high";
    if (score <= 2) return "low";
    return "medium";
  };

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

    const candidateNames = candidateTests
      .filter((entry) => entry.file !== symbol.file)
      .slice(0, 2)
      .map((entry) => path.basename(entry.file));
    const coverageSummary = hasCoverageData
      ? `Coverage currently exercises ${coveredLines}/${totalLines} changed line(s).`
      : "No LCOV or Istanbul coverage data matched this symbol range.";

    const fanIn = fanInByFile.get(symbol.file) ?? 0;
    const confidence = confidenceFromSignals({
      hasCoverageData,
      coveredLines,
      totalLines,
      exported: symbol.exported,
      fanIn,
      kind: symbol.kind,
    });
    const suggestedCommand = inferTestCommand(candidateNames);

    const details =
      candidateNames.length > 0
        ? `Changed symbol has no discovered references in test files. ${coverageSummary} Candidate tests: ${candidateNames.join(", ")}. Fan-in for this file is ${fanIn}. Suggested command: ${suggestedCommand}`
        : `Changed symbol has no discovered references in test files. ${coverageSummary} Fan-in for this file is ${fanIn}. Suggested command: ${suggestedCommand}`;

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
        (entry) => Math.abs(entry.line - removedSig.line) <= 3,
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
  options?: { lcovPaths?: string[]; coveragePaths?: string[] },
): Promise<Map<string, FileCoverage>> {
  const coverage = new Map<string, FileCoverage>();
  const allPaths = [
    ...(options?.lcovPaths ?? []),
    ...(options?.coveragePaths ?? []),
  ];
  if (allPaths.length === 0) return coverage;

  const ensureFileCoverage = (filePath: string): FileCoverage => {
    const existing = coverage.get(filePath);
    if (existing) return existing;
    const next: FileCoverage = {
      allLines: new Set<number>(),
      coveredLines: new Set<number>(),
    };
    coverage.set(filePath, next);
    return next;
  };

  const parseLcovText = (text: string) => {
    let currentFile: string | null = null;
    for (const rawLine of text.split(/\r?\n/)) {
      if (rawLine.startsWith("SF:")) {
        const filePath = rawLine.slice(3).trim();
        currentFile = filePath
          ? normalizeImpactFilePath(projectRoot, filePath)
          : null;
        continue;
      }
      if (!currentFile || !rawLine.startsWith("DA:")) continue;
      const parts = rawLine.slice(3).split(",");
      const lineNo = Number(parts[0]);
      const hits = Number(parts[1]);
      if (!Number.isInteger(lineNo) || lineNo <= 0) continue;
      const fileCoverage = ensureFileCoverage(currentFile);
      fileCoverage.allLines.add(lineNo);
      if (Number.isFinite(hits) && hits > 0) {
        fileCoverage.coveredLines.add(lineNo);
      }
    }
  };

  const parseIstanbulJson = (text: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;

    const entries = Object.entries(parsed as Record<string, unknown>);
    for (const [fileKey, value] of entries) {
      if (!value || typeof value !== "object") continue;
      const statementMap = (value as { statementMap?: unknown }).statementMap;
      const statements = (value as { s?: unknown }).s;
      if (!statementMap || !statements) continue;
      if (typeof statementMap !== "object" || typeof statements !== "object") {
        continue;
      }
      const normalizedFile = normalizeImpactFilePath(projectRoot, fileKey);
      const fileCoverage = ensureFileCoverage(normalizedFile);
      const mapEntries = Object.entries(
        statementMap as Record<string, unknown>,
      );
      for (const [statementId, rangeValue] of mapEntries) {
        if (!rangeValue || typeof rangeValue !== "object") continue;
        const start = (rangeValue as { start?: { line?: number } }).start;
        const end = (rangeValue as { end?: { line?: number } }).end;
        const startLineRaw = start?.line;
        const endLineRaw = end?.line;
        if (!Number.isInteger(startLineRaw) || !Number.isInteger(endLineRaw)) {
          continue;
        }
        const startLine = Number(startLineRaw);
        const endLine = Number(endLineRaw);
        const hitsRaw = (statements as Record<string, unknown>)[statementId];
        const hits = typeof hitsRaw === "number" ? hitsRaw : 0;
        for (let line = startLine; line <= endLine; line += 1) {
          fileCoverage.allLines.add(line);
          if (hits > 0) fileCoverage.coveredLines.add(line);
        }
      }
    }
  };

  for (const coveragePath of allPaths) {
    const abs = path.isAbsolute(coveragePath)
      ? coveragePath
      : path.resolve(projectRoot, coveragePath);
    let text = "";
    try {
      text = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    const isJson = abs.toLowerCase().endsWith(".json");
    if (isJson) parseIstanbulJson(text);
    else parseLcovText(text);
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
  const isIgnored: (p: string) => boolean =
    ignoreGlobs.length > 0
      ? (pm as (g: string[]) => (s: string) => boolean)(ignoreGlobs)
      : () => false;

  // Filter out ignored files from diff
  const filteredFiles =
    ignoreGlobs.length > 0
      ? diff.files.filter((f) => !isIgnored(f.path))
      : diff.files;

  // Map all changed files to changed symbols
  const changedByFile = await mapLimit(
    filteredFiles.map((fileChange, idx) => ({ fileChange, idx })),
    8,
    async ({ fileChange, idx }) => {
      const absPath = normalizeImpactFilePath(projectRoot, fileChange.path);
      const symbols = await locateChangedSymbols(index, absPath, fileChange.hunks);
      return { idx, path: absPath, symbols };
    },
  );

  changedByFile.sort((a, b) => a.idx - b.idx);
  let changedSymbols: ChangedSymbol[] = [];
  const filesWithSymbols = new Set<string>();
  for (const entry of changedByFile) {
    if (entry.symbols.length > 0) filesWithSymbols.add(entry.path);
    changedSymbols.push(...entry.symbols);
  }

  // Honor scope option: only consider exported symbols if scope=imported
  if (options.scope === "imported") {
    changedSymbols = changedSymbols.filter((s) => s.exported);
  }

  const normalizedChanges = filteredFiles.map((change) => ({
    ...change,
    path: normalizeImpactFilePath(projectRoot, change.path),
  }));
  const fileLevelFallback = options.fileLevelFallback ?? true;
  const fileLevelFallbackPaths = normalizedChanges
    .filter((change) => change.kind === "modified" && !filesWithSymbols.has(change.path))
    .map((change) => change.path);

  // Analyze impact
  const impactedItems = await analyzeImpact(index, changedSymbols, normalizedChanges, {
    ...options,
    fileLevelFallback,
    fileLevelFallbackPaths,
  });

  const suggestions = options.verifyReferences
    ? await collectImpactSuggestions(index, projectRoot, filteredFiles, options)
    : [];

  const configAndBreaking =
    options.configImpactRules || options.detectBreakingChanges
      ? collectConfigAndBreakingSuggestions(
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
    ? await collectUntestedChangeSuggestions(
        index,
        changedSymbols,
        projectRoot,
        {
          ...(options.lcovPaths ? { lcovPaths: options.lcovPaths } : {}),
          ...(options.coveragePaths
            ? { coveragePaths: options.coveragePaths }
            : {}),
          ...(options.testCommandTemplate
            ? { testCommandTemplate: options.testCommandTemplate }
            : {}),
          ...(options.testPatterns
            ? { testPatterns: options.testPatterns }
            : {}),
        },
      )
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
