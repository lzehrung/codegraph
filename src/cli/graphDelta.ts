import fsp from "node:fs/promises";
import { buildGraphDelta } from "../indexer/build-index.js";
import { type IncrementalBuildOptions } from "../indexer/types.js";
import { type GraphBuildOptions } from "../graphs/types.js";
import type { NativeRuntimeMode } from "../native/treeSitterNative.js";
import { normalizePath, resolveFilePathFromRoot } from "../util/paths.js";
import { parseCacheModeOption, parseNonNegativeIntegerOption } from "./options.js";
import { formatPrettyValue, writeCliOutput } from "./pretty.js";

export type GraphDeltaCommandContext = {
  projectRootFs: string;
  files: string[];
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  cwd: () => string;
  nativeMode: NativeRuntimeMode;
  workerOpts: { useNativeWorkers: true } | Record<string, never>;
  graphOptions: GraphBuildOptions | undefined;
  languageExtensions: IncrementalBuildOptions["languageExtensions"];
  gitBase: string | undefined;
  gitHead: string | undefined;
  changedSince: string | undefined;
  progressHandler: IncrementalBuildOptions["onProgress"];
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
};

export async function handleGraphDeltaCommand(context: GraphDeltaCommandContext): Promise<void> {
  const threads = parseNonNegativeIntegerOption(context.getOpt("--threads"), "--threads", 0);
  const cache = parseCacheModeOption(context.getOpt("--cache"));
  const cacheStrict = context.hasFlag("--cache-strict");
  const cacheVerify = context.hasFlag("--cache-verify");
  const incrementalStrict = context.hasFlag("--incremental-strict");
  const outputArg = context.getOpt("--output");
  const deltaOptions: IncrementalBuildOptions = {
    threads,
    ...context.workerOpts,
    cacheStrict,
    cacheVerify,
    incrementalStrict,
    files: context.files,
    ...(context.progressHandler ? { onProgress: context.progressHandler } : {}),
  };
  if (context.languageExtensions) deltaOptions.languageExtensions = context.languageExtensions;
  if (context.nativeMode !== "auto") deltaOptions.native = context.nativeMode;
  if (cache !== undefined) deltaOptions.cache = cache;
  if (context.gitBase) deltaOptions.gitBase = context.gitBase;
  if (context.gitHead) deltaOptions.gitHead = context.gitHead;
  if (context.changedSince) deltaOptions.changedSince = context.changedSince;
  if (context.graphOptions) deltaOptions.graph = context.graphOptions;

  const delta = await buildGraphDelta(context.projectRootFs, deltaOptions);
  const outputFile = outputArg ? normalizePath(resolveFilePathFromRoot(context.cwd(), outputArg)) : undefined;
  if (outputFile) {
    const output = context.hasFlag("--json") ? JSON.stringify(delta, null, 2) : formatPrettyValue(delta);
    await fsp.writeFile(outputFile, `${output}\n`, "utf8");
  } else {
    writeCliOutput(context, delta);
  }
}
