import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  executeJsQueryAsNativeMatches as executeJsQueryAsNativeMatchesViaPackage,
  type JsLanguage,
  type JsNativeMatch,
  type JsSyntaxTree,
} from "../jsFallback.js";
import type { LanguageSupport } from "../languages.js";
import type {
  NativeCompatibilityQueryKind,
  NativeQueryKind,
} from "../languages/types.js";
import { stringifyUnknown } from "../util.js";
import { loadNativeBinding } from "./bindingLoader.js";

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

export type NativeSyntaxNode = {
  id: number;
  parentId: number;
  nodeType: string;
  named: boolean;
  start: NativePoint;
  end: NativePoint;
  childIds: number[];
  namedChildIds: number[];
  childFieldNames: string[];
};

export type NativeSyntaxTree = {
  rootId: number;
  nodes: NativeSyntaxNode[];
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
  parseSyntaxTree?: (source: string, languageId: string) => NativeSyntaxTree;
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
  const loaded = loadNativeBinding<NativeBinding>({
    packageName: "@lzehrung/codegraph-native",
    localPackageRoot: localNativePackageRoot,
    requireFn: require,
    resolveFn: require.resolve,
  });
  if (loaded.binding) {
    bindingState = {
      loaded: true,
      binding: loaded.binding,
      supportedLanguageIds: new Set(loaded.binding.supportedLanguageIds()),
    };
    return bindingState;
  }
  bindingState = { loaded: false, error: loaded.error };
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
  kind: NativeCompatibilityQueryKind,
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
 * the original JS query - meaning the language has grammar divergence and
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
    if (originalQuery.trim().length > 0 && normalized.trim().length === 0) {
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

const NATIVE_REQUIRED_ERROR_PREFIX =
  "native tree-sitter required by explicit option but unavailable";

export function isNativeRequiredUnavailableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith(NATIVE_REQUIRED_ERROR_PREFIX)
  );
}

function throwIfNativeRequiredUnavailable(
  mode: NativeRuntimeMode | undefined,
  state: NativeBindingState,
): void {
  if (normalizeNativeRuntimeMode(mode) !== "on" || state.loaded) return;
  const suffix = state.error ? `: ${stringifyUnknown(state.error)}` : "";
  throw new Error(`${NATIVE_REQUIRED_ERROR_PREFIX}${suffix}`);
}

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
  const state = resolveNativeBindingState(mode);
  throwIfNativeRequiredUnavailable(mode, state);
  return getNativeQueryExecutionForState(source, support, state, scope);
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

export type UnifiedQueryExecution = {
  matches: NativeMatch[] | null;
  backend: "native" | "js";
  fallbackReason?: "unavailable" | "unsupportedLanguage" | "queryFailure";
  error?: string;
};

export type NativeSyntaxTreeExecution = {
  tree: NativeSyntaxTree | null;
  fallbackReason?: "unavailable" | "unsupportedLanguage" | "queryFailure";
  error?: string;
};

const NATIVE_ONLY_JS_FAMILY_LANGUAGE_IDS = new Set(["js", "ts", "tsx"]);

export function shouldAvoidJsFallbackForLanguage(languageId: string): boolean {
  return NATIVE_ONLY_JS_FAMILY_LANGUAGE_IDS.has(languageId);
}

export function isNativeBindingLoadedForLanguage(
  languageId: string,
  mode?: NativeRuntimeMode,
): boolean {
  const state = resolveNativeBindingState(mode);
  return state.loaded && state.supportedLanguageIds.has(languageId);
}

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
  throwIfNativeRequiredUnavailable(mode, state);
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
    const full = getNativeQueryExecutionForState(
      source,
      support,
      state,
      "imports",
    );
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
  throwIfNativeRequiredUnavailable(mode, state);
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
  const normalizedQuery = normalizeNativeQueryForSupport(
    support,
    "adHoc",
    queryText,
  );
  try {
    return {
      matches: state.binding.runQuery(source, support.id, normalizedQuery)
        .matches,
    };
  } catch (error) {
    return {
      matches: null,
      fallbackReason: "queryFailure",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function executeJsQueryAsNativeMatches(
  source: string,
  support: LanguageSupport,
  lang: JsLanguage,
  queryText: string,
  tree?: JsSyntaxTree,
): NativeMatch[] {
  return executeJsQueryAsNativeMatchesViaPackage(
    source,
    lang,
    queryText,
    tree,
  ) as NativeMatch[] & JsNativeMatch[];
}

export function getUnifiedQueryExecution(
  source: string,
  support: LanguageSupport,
  queryText: string,
  opts?: {
    tree?: JsSyntaxTree;
    mode?: NativeRuntimeMode;
    lang?: JsLanguage;
    getLanguage?: () => JsLanguage;
  },
): UnifiedQueryExecution {
  const nativeExecution = getNativeSingleQueryExecution(
    source,
    support,
    queryText,
    opts?.mode,
  );
  if (nativeExecution.matches) {
    return {
      matches: nativeExecution.matches,
      backend: "native",
    };
  }
  if (
    shouldAvoidJsFallbackForLanguage(support.id) &&
    isNativeBindingLoadedForLanguage(support.id, opts?.mode)
  ) {
    return {
      matches: null,
      backend: "native",
      ...(nativeExecution.fallbackReason
        ? { fallbackReason: nativeExecution.fallbackReason }
        : {}),
      ...(nativeExecution.error ? { error: nativeExecution.error } : {}),
    };
  }
  try {
    const resolvedLang = opts?.lang ?? opts?.getLanguage?.();
    if (!resolvedLang) {
      throw new Error("JS query fallback requires a language");
    }
    const matches = executeJsQueryAsNativeMatches(
      source,
      support,
      resolvedLang,
      queryText,
      opts?.tree,
    );
    return {
      matches,
      backend: "js",
      ...(nativeExecution.fallbackReason
        ? { fallbackReason: nativeExecution.fallbackReason }
        : {}),
      ...(nativeExecution.error ? { error: nativeExecution.error } : {}),
    };
  } catch (error) {
    return {
      matches: null,
      backend: "js",
      fallbackReason: nativeExecution.fallbackReason ?? "queryFailure",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getNativeSyntaxTreeExecution(
  source: string,
  support: LanguageSupport,
  mode?: NativeRuntimeMode,
): NativeSyntaxTreeExecution {
  const state = resolveNativeBindingState(mode);
  throwIfNativeRequiredUnavailable(mode, state);
  if (!state.loaded) {
    return {
      tree: null,
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
    return { tree: null, fallbackReason: "unsupportedLanguage" };
  }
  if (!state.binding.parseSyntaxTree) {
    return {
      tree: null,
      fallbackReason: "unavailable",
      error: "native binding does not expose parseSyntaxTree",
    };
  }
  try {
    return {
      tree: state.binding.parseSyntaxTree(source, support.id),
    };
  } catch (error) {
    return {
      tree: null,
      fallbackReason: "queryFailure",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
