import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { LanguageSupport } from "../languages.js";
import type { NativeQueryKind } from "../languages/types.js";

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

export type NativeQueryExecution = {
  results: NativeQueryResults | null;
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

export function normalizeNativeQueryForSupport(
  support: LanguageSupport,
  kind: NativeQueryKind,
  queryText: string,
): string {
  return support.native?.normalizeQuery?.(kind, queryText) ?? queryText;
}

export function isNativeTreeSitterAvailable(): boolean {
  return loadBinding().loaded;
}

export function getNativeTreeSitterLoadError(): unknown {
  const state = loadBinding();
  return state.loaded ? undefined : state.error;
}

export function getNativeTreeSitterSupportedLanguageIds(): string[] {
  const state = loadBinding();
  return state.loaded ? Array.from(state.supportedLanguageIds).sort() : [];
}

export function runNativeLanguageQueries(
  source: string,
  support: LanguageSupport,
): NativeQueryResults | null {
  return getNativeQueryExecution(source, support).results;
}

type NativeBindingState =
  | { loaded: true; binding: NativeBinding; supportedLanguageIds: Set<string> }
  | { loaded: false; error?: unknown };

export function getNativeQueryExecutionForState(
  source: string,
  support: LanguageSupport,
  state: NativeBindingState = loadBinding(),
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
                : String(state.error),
          }
        : {}),
    };
  }
  if (!state.supportedLanguageIds.has(support.id)) {
    return { results: null, fallbackReason: "unsupportedLanguage" };
  }
  try {
    return {
      results: state.binding.runLanguageQueries(
        source,
        support.id,
        normalizeNativeQueryForSupport(
          support,
          "imports",
          support.queries.imports,
        ),
        normalizeNativeQueryForSupport(
          support,
          "exports",
          support.queries.exports,
        ),
        normalizeNativeQueryForSupport(
          support,
          "locals",
          support.queries.locals,
        ),
        normalizeNativeQueryForSupport(
          support,
          "importBindings",
          support.queries.importBindings,
        ),
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
): NativeQueryExecution {
  return getNativeQueryExecutionForState(source, support, loadBinding());
}
