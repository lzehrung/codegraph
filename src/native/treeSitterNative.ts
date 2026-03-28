import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { LanguageSupport } from "../languages.js";
import type { NativeQueryKind } from "../languages/types.js";
import { stringifyUnknown } from "../util.js";

export const NATIVE_QUERY_KINDS: NativeQueryKind[] = [
  "imports",
  "exports",
  "locals",
  "importBindings",
];

export type NativePoint = {
  row: number;
  column: number;
  index: number;
};

export type NativeCapture = {
  name: string;
  text: string;
  nodeType: string;
  start: NativePoint;
  end: NativePoint;
};

export type NativeMatch = {
  patternIndex: number;
  captures: NativeCapture[];
};

export type NativeQueryResults = {
  imports: NativeMatch[];
  exports: NativeMatch[];
  locals: NativeMatch[];
  importBindings: NativeMatch[];
};

export type CompactCapture = {
  name: string;
  text: string;
};

export type CompactMatch = {
  patternIndex: number;
  captures: CompactCapture[];
};

export type CompactQueryResults = {
  imports: CompactMatch[];
};

export type NativeQueryExecution = {
  results: NativeQueryResults | null;
  fallbackReason?: "unavailable" | "unsupportedLanguage" | "queryFailure";
  error?: string;
};

export type NativeRuntimeMode = "auto" | "on" | "off";

/**
 * Controls which query kinds are executed in a native call.
 * - "imports": only run the imports query (used by graph mode)
 * - "full": run all query kinds (used by full indexing)
 */
export type NativeQueryScope = "imports" | "full";

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
  runQuery?: (
    source: string,
    languageId: string,
    queryText: string,
  ) => { matches: NativeMatch[] };
  supportedLanguageIds: () => string[];
};

const require = createRequire(import.meta.url);
const localNativePackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../packages/codegraph-native",
);

let bindingState:
  | { loaded: true; binding: NativeBinding; supportedLanguageIds: Set<string> }
  | { loaded: false; error?: unknown }
  | undefined;

export function __resetNativeTreeSitterBindingForTests(): void {
  bindingState = undefined;
}

export function isNativeTreeSitterDisabledByEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const rawValue = env.CODEGRAPH_DISABLE_NATIVE;
  if (typeof rawValue !== "string") {
    return false;
  }
  const normalized = rawValue.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function normalizeNativeRuntimeMode(
  mode?: NativeRuntimeMode,
): NativeRuntimeMode {
  return mode ?? "auto";
}

function loadBinding():
  | { loaded: true; binding: NativeBinding; supportedLanguageIds: Set<string> }
  | { loaded: false; error?: unknown } {
  if (bindingState) return bindingState;
  const candidates = [
    "@lzehrung/codegraph-native",
    localNativePackageRoot,
  ] as const;
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const binding = require(candidate) as NativeBinding;
      bindingState = {
        loaded: true,
        binding,
        supportedLanguageIds: new Set(binding.supportedLanguageIds()),
      };
      return bindingState;
    } catch (error) {
      lastError = error;
    }
  }
  bindingState = { loaded: false, error: lastError };
  return bindingState;
}

function resolveNativeBindingState(
  mode?: NativeRuntimeMode,
  env: NodeJS.ProcessEnv = process.env,
): NativeBindingState {
  const normalizedMode = normalizeNativeRuntimeMode(mode);
  if (normalizedMode === "off") {
    return {
      loaded: false,
      error: new Error("native tree-sitter disabled by explicit option"),
    };
  }
  if (normalizedMode === "auto" && isNativeTreeSitterDisabledByEnv(env)) {
    return {
      loaded: false,
      error: new Error(
        "native tree-sitter disabled by CODEGRAPH_DISABLE_NATIVE",
      ),
    };
  }
  return loadBinding();
}

export function normalizeNativeQueryForSupport(
  support: LanguageSupport,
  kind: NativeQueryKind,
  queryText: string,
): string {
  return support.native?.normalizeQuery?.(kind, queryText) ?? queryText;
}

/**
 * Per-language cache of normalized query text and modification status.
 * Normalization is constant for a given (support.id, queryKind) pair,
 * so we compute it once per language per kind.
 */
const normalizedQueryCache = new Map<
  string,
  Map<NativeQueryKind, { text: string; wasModified: boolean }>
>();

function getOrComputeNormalizedEntry(
  support: LanguageSupport,
  kind: NativeQueryKind,
): { text: string; wasModified: boolean } {
  let byKind = normalizedQueryCache.get(support.id);
  if (!byKind) {
    byKind = new Map();
    normalizedQueryCache.set(support.id, byKind);
  }
  let entry = byKind.get(kind);
  if (!entry) {
    const original = support.queries[kind];
    const normalized = normalizeNativeQueryForSupport(support, kind, original);
    entry = { text: normalized, wasModified: normalized !== original };
    byKind.set(kind, entry);
  }
  return entry;
}

/**
 * Returns the normalized query text for the support's own query.
 * Cached per (support.id, kind) to avoid re-running regex normalization
 * on every file.
 */
export function getCachedNormalizedQuery(
  support: LanguageSupport,
  kind: NativeQueryKind,
): string {
  return getOrComputeNormalizedEntry(support, kind).text;
}

/**
 * Returns true when the native query for this (support, kind) differs from
 * the original JS query — meaning the language has grammar divergence and
 * empty native results should NOT be treated as authoritative.
 */
export function isNativeQueryModified(
  support: LanguageSupport,
  kind: NativeQueryKind,
): boolean {
  return getOrComputeNormalizedEntry(support, kind).wasModified;
}

export function getNativeQueryMetadataForSupport(support: LanguageSupport): {
  normalizedQueryKinds: NativeQueryKind[];
  skippedQueryKinds: NativeQueryKind[];
} {
  const normalizedQueryKinds: NativeQueryKind[] = [];
  const skippedQueryKinds: NativeQueryKind[] = [];

  for (const kind of NATIVE_QUERY_KINDS) {
    if (!isNativeQueryModified(support, kind)) {
      continue;
    }
    normalizedQueryKinds.push(kind);
    const originalQuery = support.queries[kind];
    const normalized = normalizeNativeQueryForSupport(
      support,
      kind,
      originalQuery,
    );
    if (
      originalQuery.trim().length > 0 &&
      normalized.trim().length === 0
    ) {
      skippedQueryKinds.push(kind);
    }
  }

  return {
    normalizedQueryKinds,
    skippedQueryKinds,
  };
}

export function isNativeTreeSitterAvailable(mode?: NativeRuntimeMode): boolean {
  return resolveNativeBindingState(mode).loaded;
}

export function getNativeTreeSitterLoadError(
  mode?: NativeRuntimeMode,
): unknown {
  const state = resolveNativeBindingState(mode);
  return state.loaded ? undefined : state.error;
}

export function getNativeTreeSitterSupportedLanguageIds(
  mode?: NativeRuntimeMode,
): string[] {
  const state = resolveNativeBindingState(mode);
  return state.loaded ? Array.from(state.supportedLanguageIds).sort() : [];
}

export function runNativeLanguageQueries(
  source: string,
  support: LanguageSupport,
  mode?: NativeRuntimeMode,
): NativeQueryResults | null {
  return getNativeQueryExecution(source, support, mode).results;
}

type NativeBindingState =
  | { loaded: true; binding: NativeBinding; supportedLanguageIds: Set<string> }
  | { loaded: false; error?: unknown };

export function getNativeQueryExecutionForState(
  source: string,
  support: LanguageSupport,
  state: NativeBindingState = loadBinding(),
  scope: NativeQueryScope = "full",
): NativeQueryExecution {
  if (!state.loaded) {
    return {
      results: null,
      fallbackReason: "unavailable",
      ...(state.error
        ? {
            error:
              state.error instanceof Error
                ? state.error.message
                : stringifyUnknown(state.error),
          }
        : {}),
    };
  }
  if (!state.supportedLanguageIds.has(support.id)) {
    return { results: null, fallbackReason: "unsupportedLanguage" };
  }
  const importsOnly = scope === "imports";
  try {
    return {
      results: state.binding.runLanguageQueries(
        source,
        support.id,
        getCachedNormalizedQuery(support, "imports"),
        importsOnly ? "" : getCachedNormalizedQuery(support, "exports"),
        importsOnly ? "" : getCachedNormalizedQuery(support, "locals"),
        importsOnly ? "" : getCachedNormalizedQuery(support, "importBindings"),
      ),
    };
  } catch (error) {
    return {
      results: null,
      fallbackReason: "queryFailure",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getNativeQueryExecution(
  source: string,
  support: LanguageSupport,
  mode?: NativeRuntimeMode,
  scope: NativeQueryScope = "full",
): NativeQueryExecution {
  return getNativeQueryExecutionForState(
    source,
    support,
    resolveNativeBindingState(mode),
    scope,
  );
}

export type CompactImportsExecution = {
  results: CompactQueryResults | null;
  fallbackReason?: "unavailable" | "unsupportedLanguage" | "queryFailure";
  error?: string;
};

export type NativeSingleQueryExecution = {
  matches: NativeMatch[] | null;
  fallbackReason?: "unavailable" | "unsupportedLanguage" | "queryFailure";
  error?: string;
};

/**
 * Run only the imports query with a compact payload (name + text only).
 * Falls back to the full execution path if the compact entrypoint is not
 * available in the native binding.
 */
export function getCompactImportsExecution(
  source: string,
  support: LanguageSupport,
  mode?: NativeRuntimeMode,
): CompactImportsExecution {
  const state = resolveNativeBindingState(mode);
  if (!state.loaded) {
    return {
      results: null,
      fallbackReason: "unavailable",
      ...(state.error
        ? {
            error:
              state.error instanceof Error
                ? state.error.message
                : stringifyUnknown(state.error),
          }
        : {}),
    };
  }
  if (!state.supportedLanguageIds.has(support.id)) {
    return { results: null, fallbackReason: "unsupportedLanguage" };
  }
  const importsQuery = getCachedNormalizedQuery(support, "imports");
  try {
    if (state.binding.runImportsQueryCompact) {
      return {
        results: state.binding.runImportsQueryCompact(
          source,
          support.id,
          importsQuery,
        ),
      };
    }
    // Fallback: use full execution with imports scope
    const full = getNativeQueryExecutionForState(source, support, state, "imports");
    if (!full.results) return full;
    return {
      results: {
        imports: full.results.imports.map((m) => ({
          patternIndex: m.patternIndex,
          captures: m.captures.map((c) => ({ name: c.name, text: c.text })),
        })),
      },
    };
  } catch (error) {
    return {
      results: null,
      fallbackReason: "queryFailure",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getNativeSingleQueryExecution(
  source: string,
  support: LanguageSupport,
  queryText: string,
  mode?: NativeRuntimeMode,
): NativeSingleQueryExecution {
  const state = resolveNativeBindingState(mode);
  if (!state.loaded) {
    return {
      matches: null,
      fallbackReason: "unavailable",
      ...(state.error
        ? {
            error:
              state.error instanceof Error
                ? state.error.message
                : stringifyUnknown(state.error),
          }
        : {}),
    };
  }
  if (!state.supportedLanguageIds.has(support.id)) {
    return { matches: null, fallbackReason: "unsupportedLanguage" };
  }
  if (!state.binding.runQuery) {
    return {
      matches: null,
      fallbackReason: "unavailable",
      error: "native binding does not expose runQuery",
    };
  }
  try {
    return {
      matches: state.binding.runQuery(source, support.id, queryText).matches,
    };
  } catch (error) {
    return {
      matches: null,
      fallbackReason: "queryFailure",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
