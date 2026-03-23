import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { LanguageSupport } from "../languages.js";

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

const JS_OBJECT_METHOD_EXPORT_PATTERN = `
      ;; CJS: module.exports = { helper () {} }
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (pair key: (property_identifier) @cjs_export_name value: (function_declaration) @cjs_fn))))
        (#eq? @mod "module") (#eq? @prop "exports")
`;

const TS_EXPORT_ASSIGNMENT_PATTERN =
  "    (export_assignment (identifier) @ts_export_assign)\n";
const TS_DEFAULT_EXPORT_PATTERNS = [
  '    (export_statement (function_declaration name: (identifier) @default)) @stmt (#match? @stmt "default")\n',
  '    (export_statement (class_declaration name: (identifier) @default)) @stmt (#match? @stmt "default")\n',
] as const;
const SCSS_SYMBOL_QUERY_PATTERNS = [
  "(mixin_statement (name) @name)",
  "(function_statement (name) @name)",
  "(variable_declaration (variable) @name)",
  "(class_selector (class_name) @name)",
  "(id_selector (id_name) @name)",
] as const;

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

function normalizeQueryForNative(languageId: string, queryText: string): string {
  if (languageId === "js") {
    return queryText
      .replace(/\(function\)/g, "(function_expression)")
      .replace(JS_OBJECT_METHOD_EXPORT_PATTERN, "\n");
  }
  if (languageId === "ts" || languageId === "tsx") {
    let normalized = queryText.replace(TS_EXPORT_ASSIGNMENT_PATTERN, "");
    for (const pattern of TS_DEFAULT_EXPORT_PATTERNS) {
      normalized = normalized.replace(pattern, "");
    }
    return normalized.replace(
      /\(class_declaration name: \(identifier\) @/g,
      "(class_declaration name: (type_identifier) @",
    );
  }
  if (languageId === "scss") {
    if (SCSS_SYMBOL_QUERY_PATTERNS.some((pattern) => queryText.includes(pattern))) {
      return "";
    }
    return queryText;
  }
  if (languageId === "kotlin") {
    let normalized = queryText
      .replace(/\bimport_header\b/g, "import")
      .replace(/\bsimple_identifier\b/g, "identifier")
      .replace(/\btype_identifier\b/g, "identifier");
    if (
      normalized.includes("import_alias") ||
      normalized.includes("wildcard_import")
    ) {
      normalized = "";
    }
    return normalized;
  }
  return queryText;
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

export function getNativeQueryExecution(
  source: string,
  support: LanguageSupport,
): NativeQueryExecution {
  const state = loadBinding();
  if (!state.loaded) {
    const loadError = getNativeTreeSitterLoadError();
    return {
      results: null,
      fallbackReason: "unavailable",
      ...(loadError
        ? {
            error: loadError instanceof Error ? loadError.message : String(loadError),
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
        normalizeQueryForNative(support.id, support.queries.imports),
        normalizeQueryForNative(support.id, support.queries.exports),
        normalizeQueryForNative(support.id, support.queries.locals),
        normalizeQueryForNative(support.id, support.queries.importBindings),
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
