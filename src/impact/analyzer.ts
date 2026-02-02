import type { FileId, Edge } from "../types.js";
import type { ProjectIndex, SymbolDef, ReferenceResult } from "../indexer.js";
import pm from "picomatch";
import type {
  ChangedSymbol,
  ImpactItem,
  ImpactReason,
  ImpactOptions,
  FileChange,
  SeverityWeights,
} from "./types.js";
import { DEFAULT_SEVERITY_WEIGHTS } from "./types.js";
import { findReferences, ensureParsedContext } from "../indexer.js";
import type Parser from "tree-sitter";

/** Explain object for impact severity calculation */
type SeverityExplain = {
  reason?: ImpactReason;
  exported?: boolean;
  fanIn?: number;
  sameFile?: boolean;
  typeOnly?: boolean;
  depth?: number;
  hints?: string[];
};

/** Result of severity calculation with confidence */
type SeverityResult = {
  severity: number;
  confidence: number;
  explain: SeverityExplain;
};

export async function analyzeImpact(
  index: ProjectIndex,
  changedSymbols: ChangedSymbol[],
  changedFiles: FileChange[],
  options: Partial<ImpactOptions> = {},
): Promise<ImpactItem[]> {
  const {
    maxRefs = 1000,
    depth = 3,
    includeTests = false,
    membersOnly = false,
    testPatterns,
    ignoreGlobs = [],
    refContext,
    refContextLines,
    refBlockMaxLines,
  } = options;

  const patternMatchers = buildTestPatterns(testPatterns);
  const isIgnored = ignoreGlobs.length > 0 ? pm(ignoreGlobs) : () => false;

  const impacted = new Map<FileId, ImpactItem>();
  const processedSymbols = new Set<string>();

  // Precompute fan-in once per impact run
  const fanInByFile = new Map<FileId, number>();
  for (const edge of index.graph.edges) {
    if (edge.to.type === "file") {
      const count = fanInByFile.get(edge.to.path) || 0;
      fanInByFile.set(edge.to.path, count + 1);
    }
  }

  // Filter out changed symbols in ignored files
  const filteredChangedSymbols = changedSymbols.filter(
    (s) => !isIgnored(s.file),
  );

  // Direct impact analysis with parallelization
  const concurrency = 8;
  const tasks = [];

  for (const changedSymbol of filteredChangedSymbols) {
    if (processedSymbols.has(changedSymbol.id)) continue;
    processedSymbols.add(changedSymbol.id);

    tasks.push(async () => {
      const refs = await findReferences(
        index,
        {
          def: {
            file: changedSymbol.file,
            localName: changedSymbol.name,
            kind: changedSymbol.kind,
            range: changedSymbol.range,
          } as SymbolDef,
        },
        refContext
          ? {
              context: refContext,
              ...(refContextLines !== undefined && { lines: refContextLines }),
              ...(refBlockMaxLines !== undefined && {
                blockMaxLines: refBlockMaxLines,
              }),
            }
          : undefined,
      );

      if (refs.status === "ok") {
        for (const ref of refs.references.slice(0, maxRefs)) {
          if (!includeTests && isTestFile(ref.file, patternMatchers)) continue;
          if (isIgnored(ref.file)) continue;

          const existing = impacted.get(ref.file);
          const reasons: ImpactReason[] = existing?.reasons || [];

          // Determine the reason for this reference
          let reason: ImpactReason = "directRef";
          if (ref.via?.namespaceMember) {
            reason = "namespaceMember";
          } else if (ref.via?.import) {
            reason = "importAlias";
          }

          if (!reasons.includes(reason)) {
            reasons.push(reason);
          }

          const severityResult = await calculateSeverity(
            changedSymbol,
            ref,
            reasons,
            0,
            index,
            fanInByFile,
          );
          const symbols = existing?.symbols || [];
          if (!symbols.includes(changedSymbol.name)) {
            symbols.push(changedSymbol.name);
          }

          const refs = existing?.refs || [];
          if (refContext && ref.context !== undefined) {
            refs.push({ range: ref.range, context: ref.context });
          }

          const impactItem: ImpactItem = {
            file: ref.file,
            symbols,
            reasons,
            severity: Math.max(
              existing?.severity || 0,
              severityResult.severity,
            ),
            depth: 0,
            ...(refContext && refs.length > 0 && { refs }),
            explain: {
              ...existing?.explain,
              ...severityResult.explain,
              refsCount: (existing?.explain?.refsCount || 0) + 1,
            },
          };

          if (changedSymbol.typeOnly !== undefined) {
            impactItem.typeOnly = changedSymbol.typeOnly;
          }

          impacted.set(ref.file, impactItem);
        }
      }
    });
  }

  // Execute in batches with concurrency control
  for (let i = 0; i < tasks.length; i += concurrency) {
    await Promise.all(tasks.slice(i, i + concurrency).map((fn) => fn()));
  }

  // Seed transitive impact from changed files (especially for deleted/renamed files with no symbols)
  if (!options.membersOnly && changedSymbols.length === 0) {
    await seedTransitiveFromFiles(index, impacted, changedFiles, options);
  }

  // Transitive impact via graph traversal (skip if membersOnly)
  if (!options.membersOnly) {
    await analyzeTransitiveImpact(index, impacted, depth, options);
  }

  return Array.from(impacted.values()).sort((a, b) => b.severity - a.severity);
}

export async function seedTransitiveFromFiles(
  index: ProjectIndex,
  impacted: Map<FileId, ImpactItem>,
  changedFiles: FileChange[],
  options: Partial<ImpactOptions>,
): Promise<void> {
  const { includeTests = false, testPatterns, ignoreGlobs = [] } = options;
  const patternMatchers = buildTestPatterns(testPatterns);
  const isIgnored = ignoreGlobs.length > 0 ? pm(ignoreGlobs) : () => false;

  for (const fileChange of changedFiles) {
    // Skip if this file already has impact items or is ignored
    if (impacted.has(fileChange.path) || isIgnored(fileChange.path)) continue;

    // For deleted/renamed files, seed transitive impact from files that depended on them
    if (fileChange.kind === "deleted" || fileChange.kind === "renamed") {
      const dependents = index.graph.edges
        .filter((e) => e.to.type === "file" && e.to.path === fileChange.path)
        .map((e) => e.from);

      for (const dependent of dependents) {
        if (!includeTests && isTestFile(dependent, patternMatchers)) continue;
        if (impacted.has(dependent) || isIgnored(dependent)) continue;

        const hints = ["fileDeleted"];
        if (fileChange.kind === "renamed") {
          hints.push("fileRenamed");
        }

        const impactItem: ImpactItem = {
          file: dependent,
          symbols: [],
          reasons: ["transitive"],
          severity: 0.6, // Moderate severity for file-level changes
          depth: 1,
          explain: {
            reason: "transitive",
            depth: 1,
            hints,
          },
        };

        impacted.set(dependent, impactItem);
      }
    }
  }
}

async function analyzeTransitiveImpact(
  index: ProjectIndex,
  impacted: Map<FileId, ImpactItem>,
  maxDepth: number,
  options: Partial<ImpactOptions>,
): Promise<void> {
  const { testPatterns, ignoreGlobs = [] } = options;
  const patternMatchers = buildTestPatterns(testPatterns);
  const isIgnored = ignoreGlobs.length > 0 ? pm(ignoreGlobs) : () => false;

  // Precompute reverse dependency index for efficient traversal
  const reverseDeps = new Map<FileId, Edge[]>();
  for (const e of index.graph.edges) {
    if (e.to.type === "file") {
      const arr = reverseDeps.get(e.to.path) || [];
      arr.push(e);
      reverseDeps.set(e.to.path, arr);
    }
  }

  const visited = new Set<FileId>();
  const queue: Array<{ file: FileId; depth: number; reason: ImpactReason }> =
    [];

  // Initialize queue with directly impacted files
  for (const [file, item] of impacted) {
    if (isIgnored(file)) continue;
    visited.add(file);
    queue.push({ file, depth: 0, reason: "transitive" });
  }

  let qi = 0;
  while (qi < queue.length) {
    const { file, depth, reason } = queue[qi++]!;
    if (depth >= maxDepth) continue;

    // Find files that depend on this file using reverse index
    const edgesIn = reverseDeps.get(file) || [];
    for (const edge of edgesIn) {
      const dependentFile = edge.from;
      if (
        visited.has(dependentFile) ||
        (!options.includeTests && isTestFile(dependentFile, patternMatchers)) ||
        isIgnored(dependentFile)
      )
        continue;

      visited.add(dependentFile);

      const existing = impacted.get(dependentFile);
      const reasons = existing?.reasons || [];
      if (!reasons.includes(reason)) {
        reasons.push(reason);
      }

      const severity = calculateTransitiveSeverity(edge, depth + 1);

      // Calculate fan-in for transitive items too
      const fanIn = reverseDeps.get(dependentFile)?.length || 0;

      const transitiveItem: ImpactItem = {
        file: dependentFile,
        symbols: existing?.symbols || [],
        reasons,
        severity: Math.max(existing?.severity || 0, severity),
        depth: depth + 1,
        explain: {
          ...existing?.explain,
          reason,
          depth: depth + 1,
          ...(fanIn > 0 && { fanIn }),
        },
      };

      if (edge.typeOnly !== undefined) {
        transitiveItem.typeOnly = edge.typeOnly;
        if (transitiveItem.explain) {
          transitiveItem.explain.typeOnly = edge.typeOnly;
        }
      }

      impacted.set(dependentFile, transitiveItem);

      queue.push({
        file: dependentFile,
        depth: depth + 1,
        reason: "exportChain",
      });
    }
  }
}

export async function calculateSeverity(
  changedSymbol: ChangedSymbol,
  ref: ReferenceResult,
  reasons: ImpactReason[],
  depth: number,
  index: ProjectIndex,
  fanInByFile?: Map<FileId, number>,
  weights: SeverityWeights = DEFAULT_SEVERITY_WEIGHTS,
): Promise<SeverityResult> {
  let score = 1.0;
  let confidence = 1.0; // Start with high confidence
  const explain: SeverityExplain = {};
  const hints: string[] = [];

  // Primary reason (use configurable weights)
  if (reasons.includes("directRef")) {
    score *= weights.directRef;
    explain.reason = "directRef";
    confidence = 1.0; // Direct reference = highest confidence
  } else if (reasons.includes("namespaceMember")) {
    score *= weights.namespaceMember;
    explain.reason = "namespaceMember";
    confidence = 0.9; // Namespace access is fairly reliable
  } else if (reasons.includes("importAlias")) {
    score *= weights.importAlias;
    explain.reason = "importAlias";
    confidence = 0.85; // Import alias tracking is reliable
  } else {
    score *= weights.transitive;
    explain.reason = "transitive";
    confidence = 0.6; // Transitive impact is less certain
  }

  // Exported symbols are more important (configurable)
  if (changedSymbol.exported) {
    score *= weights.exported;
    explain.exported = true;
  }

  // Calculate fan-in (how many files depend on the impacted file)
  const fanIn = fanInByFile
    ? fanInByFile.get(ref.file) || 0
    : [...index.graph.edges].filter(
        (e) => e.to.type === "file" && e.to.path === ref.file,
      ).length;
  if (fanIn > 0) {
    const fanInFactor = 1 + Math.min(Math.log10(fanIn + 1), 1); // Cap at doubling
    score *= fanInFactor;
    explain.fanIn = fanIn;
  }

  // Same-file references are more important (configurable)
  if (ref.file === changedSymbol.file) {
    score *= weights.sameFile;
    explain.sameFile = true;
  }

  // Type-only changes are less severe (configurable)
  if (changedSymbol.typeOnly) {
    score *= weights.typeOnly;
    explain.typeOnly = true;
  }

  // Generate hints based on changed symbol characteristics
  if (changedSymbol.exported) {
    hints.push("exportChanged");
  }

  // Check if this might be a signature change (function/class with parameters)
  const mod = index.byFile.get(changedSymbol.file);
  if (mod) {
    const changedIndex = changedSymbol.range.start.index ?? 0;
    const symbolDef = mod.locals.find((l) => {
      const localIndex = l.range.start.index ?? 0;
      return l.localName === changedSymbol.name && localIndex === changedIndex;
    });
    if (symbolDef) {
      const parsed = await ensureParsedContext(
        changedSymbol.file,
        index.parsed?.get(changedSymbol.file),
      );
      if (parsed) {
        const { tree, sup } = parsed;
        const pos = {
          row: symbolDef.range.start.line - 1,
          column: symbolDef.range.start.column - 1,
        };
        const node = tree.rootNode.descendantForPosition(pos, pos);
        let declNode: Parser.SyntaxNode | null = node;
        while (
          declNode &&
          ![
            "function_declaration",
            "function_definition",
            "method_definition",
            "method_declaration",
            "class_declaration",
            "class_definition",
          ].includes(declNode.type)
        ) {
          declNode = declNode.parent;
        }

        if (declNode) {
          const params =
            declNode.childForFieldName("parameters") ||
            declNode.childForFieldName("params");
          if (params && params.namedChildCount > 0) {
            hints.push("signatureChanged");
          }
        }
      } else {
        // Fallback to simple line-span heuristic if AST is not available
        if (
          symbolDef.kind === "function" &&
          symbolDef.range.end.line - symbolDef.range.start.line > 1
        ) {
          hints.push("signatureChanged");
        }
      }
    }
  }

  if (hints.length > 0) {
    explain.hints = hints;
  }

  // Depth decay (configurable)
  score *= Math.pow(weights.depthDecay, depth);
  explain.depth = depth;

  // Reduce confidence for deeper transitive impacts
  confidence *= Math.pow(0.9, depth);

  return {
    severity: Math.min(1.0, Math.max(0.0, score)),
    confidence: Math.min(1.0, Math.max(0.0, confidence)),
    explain,
  };
}

function calculateTransitiveSeverity(edge: Edge, depth: number): number {
  let score = 0.3; // Base transitive score

  // Type-only edges are less severe
  if (edge.typeOnly) {
    score *= 0.6;
  }

  // Depth decay
  score *= Math.pow(0.7, depth);

  return score;
}

function buildTestPatterns(patterns?: string[]): RegExp[] {
  const defaults = [/test/i, /spec/i, /__tests__/, /\.test\./, /\.spec\./];
  const custom = (patterns ?? []).map((pattern) => new RegExp(pattern));
  return [...defaults, ...custom];
}

function isTestFile(file: FileId, patterns: RegExp[]): boolean {
  const lower = file.toLowerCase();
  return patterns.some((pattern) => pattern.test(lower));
}
