import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export interface JsPoint {
  row: number;
  column: number;
}

export interface JsSyntaxNode {
  id?: number;
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: JsPoint;
  endPosition: JsPoint;
  parent: JsSyntaxNode | null;
  namedChildren: JsSyntaxNode[];
  previousSibling?: JsSyntaxNode | null;
  previousNamedSibling?: JsSyntaxNode | null;
  child(index: number): JsSyntaxNode | null;
  childForFieldName(fieldName: string): JsSyntaxNode | null;
}

export interface JsSyntaxTree {
  rootNode: JsSyntaxNode & {
    descendantForIndex(startIndex: number, endIndex: number): JsSyntaxNode;
    descendantForPosition(start: JsPoint, end: JsPoint): JsSyntaxNode;
  };
  walk(): unknown;
}

export interface JsLanguage {
  readonly name?: string;
}

export interface JsNativePoint {
  row: number;
  column: number;
  index: number;
}

export interface JsNativeCapture {
  name: string;
  text: string;
  nodeType: string;
  start: JsNativePoint;
  end: JsNativePoint;
}

export interface JsNativeMatch {
  patternIndex: number;
  captures: JsNativeCapture[];
}

type JsFallbackModule = {
  loadTreeSitterLanguage: (packageName: string) => JsLanguage;
  loadTypeScriptGrammars: () => {
    typescript: JsLanguage;
    tsx: JsLanguage;
  };
  parseWithJsLanguage: (source: string, language: JsLanguage) => JsSyntaxTree;
  executeJsQueryAsNativeMatches: (
    source: string,
    language: JsLanguage,
    queryText: string,
    tree?: JsSyntaxTree,
  ) => JsNativeMatch[];
};

const require = createRequire(import.meta.url);
const localJsFallbackPackageRoots = [
  path.resolve(process.cwd(), "optional-packages/codegraph-js-fallback"),
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../optional-packages/codegraph-js-fallback",
  ),
];

let jsFallbackState:
  | { loaded: true; module: JsFallbackModule }
  | { loaded: false; error?: unknown }
  | undefined;

function loadJsFallbackModule():
  | { loaded: true; module: JsFallbackModule }
  | { loaded: false; error?: unknown } {
  if (jsFallbackState) return jsFallbackState;

  const candidates = [
    "@lzehrung/codegraph-js-fallback",
    ...localJsFallbackPackageRoots.flatMap((packageRoot) => [
      packageRoot,
      path.join(packageRoot, "js-fallback.cjs"),
    ]),
  ] as const;
  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      const loaded = require(candidate) as JsFallbackModule;
      jsFallbackState = { loaded: true, module: loaded };
      return jsFallbackState;
    } catch (error) {
      lastError = error;
    }
  }

  jsFallbackState = { loaded: false, error: lastError };
  return jsFallbackState;
}

function requireJsFallback(feature: string): JsFallbackModule {
  const state = loadJsFallbackModule();
  if (state.loaded) return state.module;

  const suffix =
    state.error instanceof Error && state.error.message
      ? ` (${state.error.message})`
      : "";
  throw new Error(
    `JS Tree-sitter fallback is unavailable for ${feature}. Install @lzehrung/codegraph-js-fallback to enable it${suffix}`,
  );
}

export function __resetJsFallbackModuleForTests(): void {
  jsFallbackState = undefined;
}

export function isJsFallbackAvailable(): boolean {
  return loadJsFallbackModule().loaded;
}

export function isJsFallbackUnavailableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("JS Tree-sitter fallback is unavailable")
  );
}

export function loadTreeSitterLanguage(packageName: string): JsLanguage {
  return requireJsFallback("grammar loading").loadTreeSitterLanguage(
    packageName,
  );
}

export function loadTypeScriptGrammars(): {
  typescript: JsLanguage;
  tsx: JsLanguage;
} {
  return requireJsFallback(
    "TypeScript grammar loading",
  ).loadTypeScriptGrammars();
}

export function parseWithJsLanguage(
  source: string,
  language: JsLanguage,
): JsSyntaxTree {
  return requireJsFallback("JS syntax-tree parsing").parseWithJsLanguage(
    source,
    language,
  );
}

export function isJsSyntaxTree(tree: unknown): tree is JsSyntaxTree {
  return (
    typeof tree === "object" &&
    tree !== null &&
    "rootNode" in tree &&
    "walk" in tree
  );
}

export function executeJsQueryAsNativeMatches(
  source: string,
  language: JsLanguage,
  queryText: string,
  tree?: JsSyntaxTree,
): JsNativeMatch[] {
  return requireJsFallback(
    "JS query execution",
  ).executeJsQueryAsNativeMatches(source, language, queryText, tree);
}
