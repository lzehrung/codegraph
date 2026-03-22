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
  if (languageId !== "js") return queryText;
  return queryText
    .replace(/\(function\)/g, "(function_expression)")
    .replace(JS_OBJECT_METHOD_EXPORT_PATTERN, "\n");
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
  const state = loadBinding();
  if (!state.loaded) return null;
  if (!state.supportedLanguageIds.has(support.id)) return null;
  try {
    return state.binding.runLanguageQueries(
      source,
      support.id,
      normalizeQueryForNative(support.id, support.queries.imports),
      normalizeQueryForNative(support.id, support.queries.exports),
      normalizeQueryForNative(support.id, support.queries.locals),
      normalizeQueryForNative(support.id, support.queries.importBindings),
    );
  } catch {
    return null;
  }
}
