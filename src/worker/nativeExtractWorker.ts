import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  NativeQueryResults,
  CompactQueryResults,
} from "../native/treeSitterNative.js";

export type NativeExtractTask = {
  filePath: string;
  languageId: string;
  source?: string | undefined;
  importsQuery: string;
  exportsQuery: string;
  localsQuery: string;
  importBindingsQuery: string;
  compact?: boolean | undefined;
};

export type NativeExtractResult = {
  filePath: string;
  languageId: string;
  source: string;
  nativeResults: NativeQueryResults | null;
  compactResults: CompactQueryResults | null;
  fallbackReason?: "unavailable" | "unsupportedLanguage" | "queryFailure";
  error?: string;
};

type NativeBinding = {
  runLanguageQueries: (
    source: string,
    languageId: string,
    importsQuery: string,
    exportsQuery: string,
    localsQuery: string,
    importBindingsQuery: string,
  ) => NativeQueryResults;
  runImportsQueryCompact?: (
    source: string,
    languageId: string,
    importsQuery: string,
  ) => CompactQueryResults;
  supportedLanguageIds: () => string[];
};

const require = createRequire(import.meta.url);
const localNativePackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../packages/codegraph-native",
);

let binding: NativeBinding | null = null;
let supportedIds: Set<string> | null = null;
let loadError: string | undefined;

function ensureBinding(): void {
  if (binding) return;
  const candidates = [
    "@lzehrung/codegraph-native",
    localNativePackageRoot,
  ] as const;
  for (const candidate of candidates) {
    try {
      binding = require(candidate) as NativeBinding;
      supportedIds = new Set(binding.supportedLanguageIds());
      return;
    } catch {
      // try next candidate
    }
  }
  loadError = "native addon not available in worker";
}

export default async function runExtraction(
  task: NativeExtractTask,
): Promise<NativeExtractResult> {
  ensureBinding();

  const source =
    task.source ?? (await fsp.readFile(task.filePath, "utf8"));

  if (!binding || !supportedIds) {
    return {
      filePath: task.filePath,
      languageId: task.languageId,
      source,
      nativeResults: null,
      compactResults: null,
      fallbackReason: "unavailable",
      ...(loadError ? { error: loadError } : {}),
    };
  }

  if (!supportedIds.has(task.languageId)) {
    return {
      filePath: task.filePath,
      languageId: task.languageId,
      source,
      nativeResults: null,
      compactResults: null,
      fallbackReason: "unsupportedLanguage",
    };
  }

  try {
    if (task.compact && binding.runImportsQueryCompact) {
      const compactResults = binding.runImportsQueryCompact(
        source,
        task.languageId,
        task.importsQuery,
      );
      return {
        filePath: task.filePath,
        languageId: task.languageId,
        source,
        nativeResults: null,
        compactResults,
      };
    }

    const nativeResults = binding.runLanguageQueries(
      source,
      task.languageId,
      task.importsQuery,
      task.exportsQuery,
      task.localsQuery,
      task.importBindingsQuery,
    );
    return {
      filePath: task.filePath,
      languageId: task.languageId,
      source,
      nativeResults,
      compactResults: null,
    };
  } catch (err) {
    return {
      filePath: task.filePath,
      languageId: task.languageId,
      source,
      nativeResults: null,
      compactResults: null,
      fallbackReason: "queryFailure",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
