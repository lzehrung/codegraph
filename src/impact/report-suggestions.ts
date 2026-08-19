import fs from "node:fs/promises";
import path from "node:path";
import { SymbolKind, type ProjectIndex } from "../indexer/types.js";
import { findReferences } from "../indexer/navigation.js";
import { fileIdentityKey, resolveFilePathFromRoot, toProjectDisplayPath } from "../util/paths.js";
import { mapLimit } from "../util/concurrency.js";
import { maskJsLikeCommentsAndStrings } from "../util/comments.js";
import {
  findBalancedAngleBrackets,
  findBalancedBraces,
  findBalancedParentheses,
} from "./call-compatibility/textScanner.js";
import type { Range } from "../types.js";
import { listCandidateTestFiles } from "./context.js";
import { collectHunkLineText, collectRemovedLines } from "./hunks.js";
import { normalizeImpactFilePath } from "./path.js";
import { collectImpactSuggestions } from "./suggestions.js";
import { compileTestPatterns, createIndexTestFileMatcher } from "./testPatterns.js";
import type { ChangedSymbol, FileChange, ImpactOptions, ImpactSuggestion } from "./types.js";
import { ECMASCRIPT_IDENTIFIER_SOURCE } from "../util/identifiers.js";

const JAVASCRIPT_IDENTIFIER_PATTERN = new RegExp(ECMASCRIPT_IDENTIFIER_SOURCE, "uy");
const JAVASCRIPT_IDENTIFIER_PART_PATTERN = new RegExp(
  String.raw`(?:${ECMASCRIPT_IDENTIFIER_SOURCE})|[$_\p{ID_Continue}\u200c\u200d]`,
  "u",
);
const CONFIG_FILE_RE =
  /(^|\/)(?:tsconfig(?:\.[^./]+)?\.json|jsconfig\.json|vite\.config\.[cm]?[jt]s|webpack\.config\.[cm]?[jt]s|rollup\.config\.[cm]?[jt]s|esbuild\.config\.[cm]?[jt]s|babel\.config\.[cm]?[jt]s|\.eslintrc(?:\.[^./]+)?|prettier\.config\.[cm]?[jt]s|package\.json|pnpm-workspace\.ya?ml|lerna\.json|turbo\.json|nx\.json|\.env(?:\.[^/]*)?)$/i;
const UNTESTED_CHANGE_REFERENCE_SCAN_LIMIT = 500;

function matchesConfigSemantics(filePath: string): boolean {
  return CONFIG_FILE_RE.test(filePath);
}

function collectAddedLines(change: FileChange): string[] {
  return collectHunkLineText(change).added;
}

function collectRemovedLinesText(change: FileChange): string[] {
  return collectHunkLineText(change).removed;
}

function collectRemovedAndAddedLines(change: FileChange): string[] {
  return collectHunkLineText(change).changed;
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
  if (!aliases.length) {
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
  const removedLines = collectRemovedLinesText(change).join("\n").toLowerCase();
  const lineSignals = `${addedLines}\n${removedLines}`;

  if (lowerPath.endsWith("package.json")) {
    if (lineSignals.includes('"scripts"')) {
      return {
        details: "package.json scripts changed; CI/build workflows may be affected across packages.",
        confidence: "medium",
      };
    }
    if (lineSignals.includes('"dependencies"') || lineSignals.includes('"devdependencies"')) {
      return {
        details: "package.json dependency graph changed; dependency resolution can affect multiple workspaces.",
        confidence: "high",
      };
    }
  }

  const isTsconfig = lowerPath.endsWith("tsconfig.json") || lowerPath.endsWith("jsconfig.json");
  if (isTsconfig) {
    const aliases = collectTsconfigPathAliases(change);
    const blastRadius = collectTsconfigBlastRadius(index, aliases);
    if (blastRadius.aliases.length) {
      const relImporters = blastRadius.importers.slice(0, 5).map((file) => toProjectDisplayPath(projectRoot, file));
      const importerSummary = blastRadius.importers.length
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
    if (lineSignals.includes("alias")) signalParts.push("module alias resolution");
    if (lineSignals.includes("input") || lineSignals.includes("entry")) {
      signalParts.push("entrypoint selection");
    }
    if (lineSignals.includes("output") || lineSignals.includes("outdir")) {
      signalParts.push("bundle output targets");
    }
    if (lineSignals.includes("plugin")) signalParts.push("plugin execution order");
    if (lineSignals.includes("define")) signalParts.push("compile-time constants");
    const detailsSuffix = signalParts.length ? ` Detected changes touch ${signalParts.join(", ")}.` : "";
    return {
      details: `Build tool configuration changed (${path.basename(change.path)}); bundling and runtime artifact behavior may change.${detailsSuffix}`,
      confidence: "high",
    };
  }

  if (lowerPath.endsWith("turbo.json") || lowerPath.endsWith("nx.json")) {
    const workspaceManifests = collectWorkspaceManifestPaths(index);
    const affectsTasks =
      lineSignals.includes("pipeline") ||
      lineSignals.includes("tasks") ||
      lineSignals.includes("dependson") ||
      lineSignals.includes("cache") ||
      lineSignals.includes("outputs");
    const scopeSummary = workspaceManifests.length
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
    details: "Configuration change detected; impact can be broad and may require full-project validation.",
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
    if (!opts.configImpactRules || !matchesConfigSemantics(fileChange.path)) continue;

    const configSemantics = classifyConfigImpact(index, projectRoot, fileChange);
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
          ...(change.range ? { range: change.range } : {}),
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
        details: "Exported symbol overlaps removed lines; verify call sites for potential breaking changes.",
        confidence: "medium",
      });
    }

    for (const fileChange of fileChanges) {
      const normalized = normalizeImpactFilePath(projectRoot, fileChange.path);
      const removedLines = removedLinesByFile.get(normalized);
      if (!removedLines || removedLines.size === 0) continue;
      const mod = index.byFile.get(fileIdentityKey(normalized));
      const hasExports = !!mod?.exports.length;
      const alreadyHasForFile = Array.from(breakingByKey.values()).some(
        (entry) => fileIdentityKey(entry.file) === fileIdentityKey(normalized),
      );
      if (!hasExports || alreadyHasForFile) continue;
      upsertBreakingSuggestion({
        file: normalized,
        kind: "breakingChange",
        details: "Removed lines in a module with exports may indicate breaking API changes.",
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
  fanInByFileInput?: Map<string, number>,
  options?: {
    lcovPaths?: string[];
    coveragePaths?: string[];
    testCommandTemplate?: string;
    testPatterns?: string[];
  },
): Promise<ImpactSuggestion[]> {
  const suggestions: ImpactSuggestion[] = [];
  const testPatterns = compileTestPatterns(options?.testPatterns);
  const isIndexTestFile = createIndexTestFileMatcher(index, testPatterns, projectRoot);
  const testFiles = new Set<string>();
  for (const module of index.byFile.values()) {
    const file = module.file;
    if (isIndexTestFile(file)) {
      testFiles.add(fileIdentityKey(file));
    }
  }

  const fanInByFile = fanInByFileInput ?? new Map<string, number>();
  if (!fanInByFileInput) {
    for (const edge of index.graph.edges) {
      if (edge.to.type !== "file") continue;
      const key = fileIdentityKey(edge.to.path);
      const current = fanInByFile.get(key) ?? 0;
      fanInByFile.set(key, current + 1);
    }
  }

  const candidateTestsByFile = new Map<string, ReturnType<typeof listCandidateTestFiles>>();
  const changedSymbolIdsByFile = new Map<string, string[]>();
  for (const symbol of changedSymbols) {
    const existing = changedSymbolIdsByFile.get(symbol.file);
    if (existing) {
      existing.push(symbol.id);
    } else {
      changedSymbolIdsByFile.set(symbol.file, [symbol.id]);
    }
  }
  for (const [file, symbolIds] of changedSymbolIdsByFile) {
    candidateTestsByFile.set(
      file,
      listCandidateTestFiles(index, [file], symbolIds, {
        ...(options?.testPatterns ? { testPatterns: options.testPatterns } : {}),
        maxCandidates: 3,
        projectRoot,
      }).filter((entry) => entry.file !== file),
    );
  }

  const coverageOptions: { lcovPaths?: string[]; coveragePaths?: string[] } = {};
  if (options?.lcovPaths) coverageOptions.lcovPaths = options.lcovPaths;
  if (options?.coveragePaths) coverageOptions.coveragePaths = options.coveragePaths;
  const coverageByFile = await loadCoverageByFile(projectRoot, coverageOptions);

  const inferTestCommand = (candidateNames: string[]): string => {
    const template = options?.testCommandTemplate?.trim();
    if (template) {
      if (template.includes("{files}")) {
        const fileArg = candidateNames.length ? candidateNames.join(" ") : "";
        return template.replace("{files}", fileArg).trim();
      }
      return template;
    }
    const graphNodeKeys = new Set(Array.from(index.graph.nodes, fileIdentityKey));
    const hasPnpm = graphNodeKeys.has(fileIdentityKey(path.resolve(projectRoot, "pnpm-lock.yaml").replace(/\\/g, "/")));
    const hasYarn = graphNodeKeys.has(fileIdentityKey(path.resolve(projectRoot, "yarn.lock").replace(/\\/g, "/")));
    const hasPackage = graphNodeKeys.has(
      fileIdentityKey(path.resolve(projectRoot, "package.json").replace(/\\/g, "/")),
    );
    let runner = "npm run";
    if (hasPnpm) {
      runner = "pnpm";
    } else if (hasYarn) {
      runner = "yarn";
    } else if (hasPackage) {
      runner = "npm run";
    }
    if (!candidateNames.length) {
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
    if (signals.hasCoverageData && signals.coveredLines === 0 && signals.totalLines > 0) {
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

  const suggestionEntries = await mapLimit(changedSymbols, 8, async (symbol) => {
    const refs = await findReferences(
      index,
      {
        def: {
          file: symbol.file,
          localName: symbol.name,
          kind: symbol.kind,
          range: symbol.range,
        },
      },
      {
        maxReferences: UNTESTED_CHANGE_REFERENCE_SCAN_LIMIT,
      },
    );
    if (refs.status !== "ok") return undefined;

    const scanMayBeTruncated = refs.references.length >= UNTESTED_CHANGE_REFERENCE_SCAN_LIMIT;
    const hasTestRef = refs.references.some((entry) => testFiles.has(fileIdentityKey(entry.file)));
    if (hasTestRef && !scanMayBeTruncated) return undefined;
    const coverage = coverageByFile.get(symbol.file);
    const coveredLines = countCoveredLinesForRange(coverage, symbol.range);
    const totalLines = countTotalLinesForRange(coverage, symbol.range);
    const hasCoverageData = totalLines > 0;

    const candidateNames = (candidateTestsByFile.get(symbol.file) ?? [])
      .filter((entry) => entry.confidence !== "low")
      .slice(0, 2)
      .map((entry) => path.basename(entry.file));
    const coverageSummary = hasCoverageData
      ? `Coverage currently exercises ${coveredLines}/${totalLines} changed line(s).`
      : "No LCOV or Istanbul coverage data matched this symbol range.";

    const fanIn = fanInByFile.get(fileIdentityKey(symbol.file)) ?? 0;
    const confidence = scanMayBeTruncated
      ? "low"
      : confidenceFromSignals({
          hasCoverageData,
          coveredLines,
          totalLines,
          exported: symbol.exported,
          fanIn,
          kind: symbol.kind,
        });
    const suggestedCommand = inferTestCommand(candidateNames);
    const referenceScanNote = scanMayBeTruncated
      ? `Reference scan reached the ${UNTESTED_CHANGE_REFERENCE_SCAN_LIMIT}-reference cap; test coverage may be under-counted. `
      : "";

    const details = candidateNames.length
      ? `${referenceScanNote}Changed symbol has no discovered references in test files. ${coverageSummary} Candidate tests: ${candidateNames.join(", ")}. Fan-in for this file is ${fanIn}. Suggested command: ${suggestedCommand}`
      : `${referenceScanNote}Changed symbol has no discovered references in test files. ${coverageSummary} Fan-in for this file is ${fanIn}. Suggested command: ${suggestedCommand}`;

    return {
      file: symbol.file,
      range: symbol.range,
      kind: "untestedChange",
      symbol: symbol.name,
      details,
      confidence,
    } satisfies ImpactSuggestion;
  });

  for (const suggestion of suggestionEntries) {
    if (suggestion) suggestions.push(suggestion);
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
  range?: Range;
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
    const atTopLevel = parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && typeAngleDepth === 0;

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

function countNewlines(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

function skipWhitespaceAndComments(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length) {
    const ch = text[cursor];
    if (!ch) break;
    if (/\s/.test(ch)) {
      cursor += 1;
      continue;
    }
    if (ch === "/" && text[cursor + 1] === "/") {
      const newline = text.indexOf("\n", cursor + 2);
      cursor = newline < 0 ? text.length : newline + 1;
      continue;
    }
    if (ch === "/" && text[cursor + 1] === "*") {
      const close = text.indexOf("*/", cursor + 2);
      cursor = close < 0 ? text.length : close + 2;
      continue;
    }
    break;
  }
  return cursor;
}
function readIdentifier(text: string, index: number): { name: string; end: number } | null {
  const ch = text[index];
  if (!ch) return null;
  JAVASCRIPT_IDENTIFIER_PATTERN.lastIndex = index;
  const identifierMatch = JAVASCRIPT_IDENTIFIER_PATTERN.exec(text);
  if (!identifierMatch) return null;
  const end = JAVASCRIPT_IDENTIFIER_PATTERN.lastIndex;
  return { name: text.slice(index, end), end };
}

function skipDecorator(text: string, index: number): number | null {
  if (text[index] !== "@") return null;
  let cursor = skipWhitespaceAndComments(text, index + 1);
  let segment = readIdentifier(text, cursor);
  if (!segment) return null;
  cursor = skipWhitespaceAndComments(text, segment.end);
  while (text[cursor] === ".") {
    cursor = skipWhitespaceAndComments(text, cursor + 1);
    segment = readIdentifier(text, cursor);
    if (!segment) return null;
    cursor = skipWhitespaceAndComments(text, segment.end);
  }
  if (text[cursor] === "(") {
    const args = findBalancedParentheses(text, cursor);
    if (!args) return null;
    return args.end;
  }
  return cursor;
}

function skipOptionalGenerics(text: string, index: number): number {
  const cursor = skipWhitespaceAndComments(text, index);
  if (text[cursor] !== "<") return cursor;
  const close = findBalancedAngleBrackets(text, cursor);
  return close < 0 ? cursor : close + 1;
}

function skipHeritageClause(text: string, index: number): number {
  let cursor = skipWhitespaceAndComments(text, index);
  while (true) {
    const keyword = readIdentifier(text, cursor);
    if (!keyword || (keyword.name !== "extends" && keyword.name !== "implements")) {
      return cursor;
    }
    cursor = skipWhitespaceAndComments(text, keyword.end);
    while (cursor < text.length) {
      const ch = text[cursor];
      if (!ch) break;
      if (ch === "{") return cursor;
      if (ch === "<") {
        const close = findBalancedAngleBrackets(text, cursor);
        if (close < 0) return cursor;
        cursor = close + 1;
        continue;
      }
      if (ch === "(") {
        const balanced = findBalancedParentheses(text, cursor);
        if (!balanced) return cursor;
        cursor = balanced.end;
        continue;
      }
      if (ch === ",") {
        cursor = skipWhitespaceAndComments(text, cursor + 1);
        continue;
      }
      if (/\s/.test(ch)) {
        cursor = skipWhitespaceAndComments(text, cursor);
        const next = readIdentifier(text, cursor);
        if (next && (next.name === "extends" || next.name === "implements")) break;
        continue;
      }
      cursor += 1;
    }
  }
}

function functionSuffixStartsAfterParams(text: string, closeParenIndex: number): boolean {
  return /^\s*(?::|[{;])/.test(text.slice(closeParenIndex + 1));
}

function arrowSuffixStartsAfterParams(text: string, closeParenIndex: number): boolean {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let angleDepth = 0;
  let sawReturnTypeAnnotation = false;
  for (let index = closeParenIndex + 1; index < text.length; index += 1) {
    const ch = text[index];
    if (!ch) continue;
    const atTopLevel = !parenDepth && !bracketDepth && !braceDepth && !angleDepth;
    if (atTopLevel && ch === "=" && text[index + 1] === ">") return true;
    if (atTopLevel && (ch === ";" || ch === "\n" || ch === "\r")) return false;
    if (atTopLevel && ch === ":") {
      sawReturnTypeAnnotation = true;
      continue;
    }
    if (atTopLevel && !sawReturnTypeAnnotation && !/\s/.test(ch)) return false;
    if (ch === "(") {
      parenDepth += 1;
      continue;
    }
    if (ch === ")") {
      if (parenDepth) parenDepth -= 1;
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
      continue;
    }
    if (ch === "]") {
      if (bracketDepth) bracketDepth -= 1;
      continue;
    }
    if (ch === "{") {
      braceDepth += 1;
      continue;
    }
    if (ch === "}") {
      if (braceDepth) braceDepth -= 1;
      continue;
    }
    if (ch === "<") {
      angleDepth += 1;
      continue;
    }
    if (ch === ">") {
      if (angleDepth) angleDepth -= 1;
    }
  }
  return false;
}

function lineRangeAt(text: string, index: number, startLine: number): Range {
  const line = startLine + countNewlines(text.slice(0, index));
  return {
    start: { line, column: 1 },
    end: { line, column: 1 },
  };
}

function findConstructorParamCount(classBodyInner: string): number | null {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < classBodyInner.length; index += 1) {
    const ch = classBodyInner[index];
    if (!ch) continue;
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      if (depth) depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (
      classBodyInner.startsWith("constructor", index) &&
      !JAVASCRIPT_IDENTIFIER_PART_PATTERN.test(classBodyInner[index - 1] ?? "")
    ) {
      const cursor = skipWhitespaceAndComments(classBodyInner, index + "constructor".length);
      if (classBodyInner[cursor] !== "(") continue;
      const params = findBalancedParentheses(classBodyInner, cursor);
      if (!params) return null;
      return countParams(params.inner);
    }
  }
  return 0;
}

function tryParseExportedFunction(
  text: string,
  index: number,
  hunkIndex: number,
  startLine: number,
  isDefault: boolean,
): { signature: ExportSignatureWithLocation; end: number } | null {
  let cursor = skipWhitespaceAndComments(text, index);
  const maybeAsync = readIdentifier(text, cursor);
  if (maybeAsync?.name === "async") {
    cursor = skipWhitespaceAndComments(text, maybeAsync.end);
  }
  const keyword = readIdentifier(text, cursor);
  if (keyword?.name !== "function") return null;
  cursor = skipWhitespaceAndComments(text, keyword.end);
  if (text[cursor] === "*") cursor = skipWhitespaceAndComments(text, cursor + 1);
  const name = readIdentifier(text, cursor);
  if (name) {
    cursor = name.end;
  } else if (!isDefault) {
    return null;
  }
  const exportName = name?.name ?? "default";
  cursor = skipOptionalGenerics(text, cursor);
  cursor = skipWhitespaceAndComments(text, cursor);
  if (text[cursor] !== "(") return null;
  const params = findBalancedParentheses(text, cursor);
  if (!params || !functionSuffixStartsAfterParams(text, params.end - 1)) return null;
  return {
    signature: {
      name: exportName,
      paramCount: countParams(params.inner),
      hunkIndex,
      line: lineRangeAt(text, index, startLine).start.line,
    },
    end: params.end,
  };
}

function tryParseExportedArrow(
  text: string,
  index: number,
  hunkIndex: number,
  startLine: number,
): { signature: ExportSignatureWithLocation; end: number } | null {
  let cursor = skipWhitespaceAndComments(text, index);
  const binding = readIdentifier(text, cursor);
  if (binding?.name !== "const" && binding?.name !== "let" && binding?.name !== "var") return null;
  cursor = skipWhitespaceAndComments(text, binding.end);
  const name = readIdentifier(text, cursor);
  if (!name) return null;
  cursor = skipWhitespaceAndComments(text, name.end);
  if (text[cursor] !== "=") return null;
  cursor = skipWhitespaceAndComments(text, cursor + 1);
  const maybeAsync = readIdentifier(text, cursor);
  if (maybeAsync?.name === "async") {
    cursor = skipWhitespaceAndComments(text, maybeAsync.end);
  }
  cursor = skipOptionalGenerics(text, cursor);
  cursor = skipWhitespaceAndComments(text, cursor);
  if (text[cursor] === "(") {
    const params = findBalancedParentheses(text, cursor);
    if (!params || !arrowSuffixStartsAfterParams(text, params.end - 1)) return null;
    return {
      signature: {
        name: name.name,
        paramCount: countParams(params.inner),
        hunkIndex,
        line: lineRangeAt(text, index, startLine).start.line,
      },
      end: params.end,
    };
  }
  const single = readIdentifier(text, cursor);
  if (!single) return null;
  cursor = skipWhitespaceAndComments(text, single.end);
  if (!(text[cursor] === "=" && text[cursor + 1] === ">")) return null;
  return {
    signature: {
      name: name.name,
      paramCount: 1,
      hunkIndex,
      line: lineRangeAt(text, index, startLine).start.line,
    },
    end: cursor + 2,
  };
}

function tryParseExportedClass(
  text: string,
  index: number,
  hunkIndex: number,
  startLine: number,
  isDefault: boolean,
): { signature: ExportSignatureWithLocation; end: number } | null {
  let cursor = skipWhitespaceAndComments(text, index);
  const maybeAbstract = readIdentifier(text, cursor);
  if (maybeAbstract?.name === "abstract") {
    cursor = skipWhitespaceAndComments(text, maybeAbstract.end);
  }
  const keyword = readIdentifier(text, cursor);
  if (keyword?.name !== "class") return null;
  cursor = skipWhitespaceAndComments(text, keyword.end);
  const name = readIdentifier(text, cursor);
  let exportName = isDefault ? "default" : name?.name;
  if (name) {
    exportName = isDefault ? name.name : name.name;
    cursor = name.end;
  } else if (!isDefault) {
    return null;
  }
  cursor = skipOptionalGenerics(text, cursor);
  cursor = skipHeritageClause(text, cursor);
  cursor = skipWhitespaceAndComments(text, cursor);
  if (text[cursor] !== "{") return null;
  const body = findBalancedBraces(text, cursor);
  if (!body) return null;
  const paramCount = findConstructorParamCount(body.inner);
  if (paramCount === null) return null;
  return {
    signature: {
      name: exportName ?? "default",
      paramCount,
      hunkIndex,
      line: lineRangeAt(text, index, startLine).start.line,
    },
    end: body.end,
  };
}

function collectExportSignaturesFromText(
  text: string,
  hunkIndex: number,
  startLine: number,
): ExportSignatureWithLocation[] {
  const output: ExportSignatureWithLocation[] = [];
  const scanText = maskJsLikeCommentsAndStrings(text);
  let index = 0;
  while (index < scanText.length) {
    const exportAt = scanText.indexOf("export", index);
    if (exportAt < 0) break;
    const before = exportAt === 0 ? "" : (scanText[exportAt - 1] ?? "");
    const after = scanText[exportAt + "export".length] ?? "";
    if (
      (before && JAVASCRIPT_IDENTIFIER_PART_PATTERN.test(before)) ||
      (after && JAVASCRIPT_IDENTIFIER_PART_PATTERN.test(after))
    ) {
      index = exportAt + "export".length;
      continue;
    }

    let cursor = skipWhitespaceAndComments(scanText, exportAt + "export".length);
    while (true) {
      const nextDecorator = skipDecorator(scanText, cursor);
      if (nextDecorator === null) break;
      cursor = skipWhitespaceAndComments(scanText, nextDecorator);
    }

    let isDefault = false;
    const maybeDefault = readIdentifier(scanText, cursor);
    if (maybeDefault?.name === "default") {
      isDefault = true;
      cursor = skipWhitespaceAndComments(scanText, maybeDefault.end);
      while (true) {
        const nextDecorator = skipDecorator(scanText, cursor);
        if (nextDecorator === null) break;
        cursor = skipWhitespaceAndComments(scanText, nextDecorator);
      }
    }

    const parsed =
      tryParseExportedFunction(scanText, cursor, hunkIndex, startLine, isDefault) ??
      tryParseExportedClass(scanText, cursor, hunkIndex, startLine, isDefault) ??
      (!isDefault ? tryParseExportedArrow(scanText, cursor, hunkIndex, startLine) : null);

    if (parsed) {
      output.push(parsed.signature);
      index = parsed.end;
      continue;
    }
    index = exportAt + "export".length;
  }

  return output;
}

function detectExportSignatureChanges(change: FileChange): SignatureChange[] {
  const removed: ExportSignatureWithLocation[] = [];
  const added: ExportSignatureWithLocation[] = [];
  for (let hunkIndex = 0; hunkIndex < change.hunks.length; hunkIndex += 1) {
    const hunk = change.hunks[hunkIndex]!;
    const oldSideLines: string[] = [];
    const newSideLines: string[] = [];
    for (const rawLine of hunk.lines) {
      if (rawLine.startsWith(" ")) {
        const line = rawLine.slice(1);
        oldSideLines.push(line);
        newSideLines.push(line);
        continue;
      }
      if (rawLine.startsWith("-")) {
        oldSideLines.push(rawLine.slice(1));
        continue;
      }
      if (rawLine.startsWith("+")) {
        newSideLines.push(rawLine.slice(1));
      }
    }
    removed.push(...collectExportSignaturesFromText(oldSideLines.join("\n"), hunkIndex, hunk.oldStart));
    added.push(...collectExportSignaturesFromText(newSideLines.join("\n"), hunkIndex, hunk.newStart));
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

  const bestAddedMatchForRemoved = (
    removedSig: ExportSignatureWithLocation,
  ): ExportSignatureWithLocation | undefined => {
    const sameName = addedByName.get(removedSig.name);
    if (!sameName?.length) return undefined;
    let best = sameName[0]!;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of sameName) {
      const hunkPenalty = candidate.hunkIndex === removedSig.hunkIndex ? 0 : 100_000;
      const distance = hunkPenalty + Math.abs(candidate.line - removedSig.line);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  };

  const output: SignatureChange[] = [];
  for (const removedSig of removed) {
    const matched = bestAddedMatchForRemoved(removedSig);
    const range: Range = {
      start: { line: removedSig.line, column: 1 },
      end: { line: removedSig.line, column: 1 },
    };
    if (matched && matched.paramCount !== removedSig.paramCount) {
      output.push({
        name: removedSig.name,
        details: `Exported function signature changed from ${removedSig.paramCount} parameter(s) to ${matched.paramCount}. This is likely a breaking API change.`,
        confidence: "high",
        range,
      });
      continue;
    }
    if (!matched && added.length) {
      const candidates = addedByHunk.get(removedSig.hunkIndex) ?? [];
      const candidate = candidates.find((entry) => Math.abs(entry.line - removedSig.line) <= 3);
      const renameDetails = candidate
        ? `Exported symbol ${removedSig.name} appears to be removed or renamed (for example ${candidate.name}). Verify backward compatibility for downstream imports.`
        : `Exported symbol ${removedSig.name} appears to be removed or renamed. Verify backward compatibility for downstream imports.`;
      output.push({
        name: removedSig.name,
        details: renameDetails,
        confidence: "medium",
        range,
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
  const allPaths = [...(options?.lcovPaths ?? []), ...(options?.coveragePaths ?? [])];
  if (!allPaths.length) return coverage;

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
        currentFile = filePath ? normalizeImpactFilePath(projectRoot, filePath) : null;
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
      const mapEntries = Object.entries(statementMap as Record<string, unknown>);
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
    const abs = resolveFilePathFromRoot(projectRoot, coveragePath);
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

function countLinesForRange(
  coverage: FileCoverage | undefined,
  range: ChangedSymbol["range"],
  linesForCoverage: (coverage: FileCoverage) => ReadonlySet<number>,
): number {
  if (!coverage) return 0;
  let count = 0;
  const lines = linesForCoverage(coverage);
  for (let line = range.start.line; line <= range.end.line; line += 1) {
    if (lines.has(line)) count += 1;
  }
  return count;
}

function countCoveredLinesForRange(coverage: FileCoverage | undefined, range: ChangedSymbol["range"]): number {
  return countLinesForRange(coverage, range, (entry) => entry.coveredLines);
}

function countTotalLinesForRange(coverage: FileCoverage | undefined, range: ChangedSymbol["range"]): number {
  return countLinesForRange(coverage, range, (entry) => entry.allLines);
}

export async function collectImpactReportSuggestions(
  projectRoot: string,
  index: ProjectIndex,
  options: ImpactOptions,
  normalizedChanges: FileChange[],
  changedSymbols: ChangedSymbol[],
): Promise<ImpactSuggestion[]> {
  const suggestions = options.verifyReferences
    ? await collectImpactSuggestions(index, projectRoot, normalizedChanges, options)
    : [];

  const configAndBreaking =
    options.configImpactRules || options.detectBreakingChanges
      ? collectConfigAndBreakingSuggestions(index, projectRoot, normalizedChanges, changedSymbols, {
          configImpactRules: !!options.configImpactRules,
          detectBreakingChanges: !!options.detectBreakingChanges,
        })
      : [];

  const coverageSuggestions = options.testCoverageSuggestions
    ? await collectUntestedChangeSuggestions(index, changedSymbols, projectRoot, undefined, {
        ...(options.lcovPaths ? { lcovPaths: options.lcovPaths } : {}),
        ...(options.coveragePaths ? { coveragePaths: options.coveragePaths } : {}),
        ...(options.testCommandTemplate ? { testCommandTemplate: options.testCommandTemplate } : {}),
        ...(options.testPatterns ? { testPatterns: options.testPatterns } : {}),
      })
    : [];

  return [...suggestions, ...configAndBreaking, ...coverageSuggestions];
}
