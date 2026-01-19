/**
 * Streaming API for impact analysis
 * Allows incremental results to be emitted as they're discovered
 */

import type { ProjectIndex } from "../indexer.js";
import type { ImpactOptions, ChangedSymbol, ImpactItem, FileChange } from "./types.js";
import { getDiff } from "./providers/base.js";
import { locateChangedSymbols } from "./map.js";
import { findReferences } from "../indexer.js";
import { calculateSeverity } from "./analyzer.js";
import pm from "picomatch";
import path from "node:path";

export type ImpactStreamChunk =
  | { type: "progress"; message: string; current: number; total: number }
  | { type: "changedSymbol"; symbol: ChangedSymbol }
  | { type: "impactItem"; item: ImpactItem }
  | { type: "complete"; summary: { totalChanged: number; totalImpacted: number } }
  | { type: "error"; error: string };

/**
 * Stream impact analysis results as they're discovered
 * This is much better for agent UX as they can start reasoning immediately
 */
export async function* analyzeImpactStreaming(
  projectRoot: string,
  index: ProjectIndex,
  options: ImpactOptions,
): AsyncGenerator<ImpactStreamChunk> {
  try {
    // Step 1: Get diff
    yield {
      type: "progress",
      message: "Fetching diff",
      current: 0,
      total: 4,
    };

    const diff = await getDiff(options);
    const { ignoreGlobs = [] } = options;
    const isIgnored = ignoreGlobs.length > 0 ? pm(ignoreGlobs) : () => false;

    // Filter out ignored files from diff
    const filteredFiles =
      ignoreGlobs.length > 0
        ? diff.files.filter((f) => !isIgnored(f.path))
        : diff.files;

    // Step 2: Map changed files to symbols
    yield {
      type: "progress",
      message: "Analyzing changed symbols",
      current: 1,
      total: 4,
    };

    let changedSymbols: ChangedSymbol[] = [];
    for (const fileChange of filteredFiles) {
      const absPath = path.isAbsolute(fileChange.path)
        ? fileChange.path.replace(/\\/g, "/")
        : path.resolve(projectRoot, fileChange.path).replace(/\\/g, "/");
      const symbols = locateChangedSymbols(index, absPath, fileChange.hunks);

      for (const symbol of symbols) {
        yield { type: "changedSymbol", symbol };
        changedSymbols.push(symbol);
      }
    }

    // Honor scope option
    if (options.scope === "imported") {
      changedSymbols = changedSymbols.filter((s) => s.exported);
    }

    // Step 3: Analyze impact (stream results)
    yield {
      type: "progress",
      message: "Finding impacted files",
      current: 2,
      total: 4,
    };

    const {
      maxRefs = 1000,
      includeTests = false,
      testPatterns,
      refContext,
      refContextLines,
      refBlockMaxLines,
    } = options;

    const patternMatchers = buildTestPatterns(testPatterns);
    const impactedMap = new Map<string, ImpactItem>();
    const processedSymbols = new Set<string>();

    // Precompute fan-in
    const fanInByFile = new Map<string, number>();
    for (const edge of index.graph.edges) {
      if (edge.to.type === "file") {
        const count = fanInByFile.get(edge.to.path) || 0;
        fanInByFile.set(edge.to.path, count + 1);
      }
    }

    // Process each changed symbol and stream results
    const concurrency = 8;
    const tasks: Array<() => Promise<void>> = [];

    for (const changedSymbol of changedSymbols) {
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
            } as any,
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

            const existing = impactedMap.get(ref.file);
            const reasons: Array<any> = existing?.reasons || [];

            let reason: any = "directRef";
            if (ref.via?.namespaceMember) {
              reason = "namespaceMember";
            } else if (ref.via?.import) {
              reason = "importAlias";
            }

            if (!reasons.includes(reason)) {
              reasons.push(reason);
            }

            const severityResult = calculateSeverity(
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

            const refs_list = existing?.refs || [];
            if (refContext && ref.context !== undefined) {
              refs_list.push({ range: ref.range, context: ref.context });
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
              ...(refContext && refs_list.length > 0 && { refs: refs_list }),
              explain: {
                ...existing?.explain,
                ...severityResult.explain,
                refsCount: (existing?.explain?.refsCount || 0) + 1,
              },
            };

            if (changedSymbol.typeOnly !== undefined) {
              impactItem.typeOnly = changedSymbol.typeOnly;
            }

            impactedMap.set(ref.file, impactItem);
          }
        }
      });
    }

    // Execute in batches with concurrency control and yield results as they arrive
    const yieldedImpactFiles = new Set<string>();
    for (let i = 0; i < tasks.length; i += concurrency) {
      await Promise.all(tasks.slice(i, i + concurrency).map((fn) => fn()));

      // Yield only impact items that have not been yielded in previous batches
      for (const [file, item] of impactedMap.entries()) {
        if (yieldedImpactFiles.has(file)) continue;
        yieldedImpactFiles.add(file);
        yield { type: "impactItem", item };
      }
    }

    // Step 4: Complete
    yield {
      type: "progress",
      message: "Analysis complete",
      current: 4,
      total: 4,
    };

    yield {
      type: "complete",
      summary: {
        totalChanged: changedSymbols.length,
        totalImpacted: impactedMap.size,
      },
    };
  } catch (error) {
    yield {
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildTestPatterns(patterns?: string[]): RegExp[] {
  const defaults = [
    /test/i,
    /spec/i,
    /__tests__/,
    /\.test\./,
    /\.spec\./,
  ];
  const custom = (patterns ?? []).map((pattern) => new RegExp(pattern));
  return [...defaults, ...custom];
}

function isTestFile(file: string, patterns: RegExp[]): boolean {
  const lower = file.toLowerCase();
  return patterns.some((pattern) => pattern.test(lower));
}
