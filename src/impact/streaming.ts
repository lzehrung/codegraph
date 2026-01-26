/**
 * Streaming API for impact analysis
 * Allows incremental results to be emitted as they're discovered
 */

import type { ProjectIndex } from "../indexer.js";
import type { ImpactOptions, ChangedSymbol, ImpactItem } from "./types.js";
import { getDiff } from "./providers/base.js";
import { locateChangedSymbols } from "./map.js";
import { analyzeImpact } from "./analyzer.js";
import pm from "picomatch";
import path from "node:path";
import { discoverProjectFiles, type ProjectFileInfo } from "../util.js";

export type ImpactStreamChunk =
  | { type: "projectFiles"; files: ProjectFileInfo[] }
  | { type: "progress"; message: string; current: number; total: number }
  | { type: "changedSymbol"; symbol: ChangedSymbol }
  | { type: "impactItem"; item: ImpactItem }
  | {
      type: "complete";
      summary: { totalChanged: number; totalImpacted: number };
    }
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
    const projectFiles =
      index.projectFiles ?? (await discoverProjectFiles(projectRoot));
    yield { type: "projectFiles", files: projectFiles };

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
      const symbols = await locateChangedSymbols(
        index,
        absPath,
        fileChange.hunks,
      );

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

    const impactedItems = await analyzeImpact(
      index,
      changedSymbols,
      filteredFiles,
      options,
    );

    for (const item of impactedItems) {
      yield { type: "impactItem", item };
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
        totalImpacted: impactedItems.length,
      },
    };
  } catch (error) {
    yield {
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
