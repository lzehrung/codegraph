import { buildProjectIndexFromFiles } from "../indexer/build-index.js";
import { findDuplicates, type DuplicateConfidence, type DuplicateDetectionOptions } from "../duplicates.js";
import type { BuildOptions } from "../indexer/types.js";
import { parseNonNegativeIntegerOption, parsePositiveIntegerOption } from "./options.js";

export type DuplicatesCommandContext = {
  projectRootFs: string;
  files: string[];
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  indexOptions?: BuildOptions;
  writeJSONLine: (value: unknown) => void;
  writeStderrLine: (message: string) => void;
  exit: (code: number) => never;
};

function parseConfidenceOption(rawValue: string | undefined): DuplicateConfidence | undefined {
  if (rawValue === undefined) return undefined;
  if (rawValue === "high" || rawValue === "medium" || rawValue === "low") return rawValue;
  throw new Error(`Invalid --min-confidence value "${rawValue}". Expected high|medium|low.`);
}

function parseDuplicateDetectionOptions(context: DuplicatesCommandContext): DuplicateDetectionOptions {
  const minConfidence = parseConfidenceOption(context.getOpt("--min-confidence"));
  const options: DuplicateDetectionOptions = {
    projectRoot: context.projectRootFs,
    files: context.files,
    ...(minConfidence !== undefined ? { minConfidence } : {}),
    limit: parseNonNegativeIntegerOption(context.getOpt("--limit"), "--limit", 50),
    minTokens: parsePositiveIntegerOption(context.getOpt("--min-tokens"), "--min-tokens", 40),
    maxTokens: parsePositiveIntegerOption(context.getOpt("--max-tokens"), "--max-tokens", 800),
    maxBucketSize: parsePositiveIntegerOption(context.getOpt("--max-bucket-size"), "--max-bucket-size", 200),
    ...(context.hasFlag("--include-same-file") ? { includeSameFile: true } : {}),
    ...(context.hasFlag("--include-small") ? { includeSmall: true } : {}),
  };

  if (options.maxTokens !== undefined && options.minTokens !== undefined && options.maxTokens < options.minTokens) {
    throw new Error(
      `Invalid --max-tokens value "${options.maxTokens}". Expected a value greater than or equal to --min-tokens.`,
    );
  }
  return options;
}

export async function handleDuplicatesCommand(context: DuplicatesCommandContext): Promise<void> {
  try {
    const index = await buildProjectIndexFromFiles(context.projectRootFs, context.files, context.indexOptions);
    const result = await findDuplicates(index, parseDuplicateDetectionOptions(context));
    context.writeJSONLine(result);
  } catch (error) {
    context.writeStderrLine(`Duplicate detection failed: ${error instanceof Error ? error.message : String(error)}`);
    context.exit(1);
  }
}
