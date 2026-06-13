export interface JsPoint {
  row: number;
  column: number;
}

export interface JsSyntaxNode {
  readonly id?: number;
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

const JS_GRAMMAR_FALLBACK_UNAVAILABLE_MESSAGE =
  "JS Tree-sitter fallback is unavailable; native parser is the only grammar backend";

function createUnavailableError(feature: string): Error {
  return new Error(`${JS_GRAMMAR_FALLBACK_UNAVAILABLE_MESSAGE} for ${feature}`);
}

export function __resetJsFallbackModuleForTests(): void {
  // Kept for tests that reset parser backends between cases.
}

export function isJsFallbackAvailable(): boolean {
  return false;
}

export function isJsFallbackUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("JS Tree-sitter fallback is unavailable");
}

export function loadTreeSitterLanguage(packageName: string): JsLanguage {
  return { name: packageName };
}

export function loadTypeScriptGrammars(): {
  typescript: JsLanguage;
  tsx: JsLanguage;
} {
  return {
    typescript: { name: "tree-sitter-typescript/typescript" },
    tsx: { name: "tree-sitter-typescript/tsx" },
  };
}

export function parseWithJsLanguage(_source: string, _language: JsLanguage): JsSyntaxTree {
  throw createUnavailableError("syntax-tree parsing");
}

export function isJsSyntaxTree(tree: unknown): tree is JsSyntaxTree {
  return typeof tree === "object" && tree !== null && "rootNode" in tree && "walk" in tree;
}

export function executeJsQueryAsNativeMatches(
  _source: string,
  _language: JsLanguage,
  _queryText: string,
  _tree?: JsSyntaxTree,
): JsNativeMatch[] {
  throw createUnavailableError("query execution");
}
