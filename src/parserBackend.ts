export interface SyntaxPoint {
  row: number;
  column: number;
}

export interface ParserSyntaxNode {
  readonly id?: number;
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: SyntaxPoint;
  endPosition: SyntaxPoint;
  parent: ParserSyntaxNode | null;
  namedChildren: ParserSyntaxNode[];
  previousSibling?: ParserSyntaxNode | null;
  previousNamedSibling?: ParserSyntaxNode | null;
  child(index: number): ParserSyntaxNode | null;
  childForFieldName(fieldName: string): ParserSyntaxNode | null;
}

export interface ParserSyntaxTree {
  rootNode: ParserSyntaxNode & {
    descendantForIndex(startIndex: number, endIndex: number): ParserSyntaxNode;
    descendantForPosition(start: SyntaxPoint, end: SyntaxPoint): ParserSyntaxNode;
  };
  walk(): unknown;
}

export interface ParserLanguage {
  readonly name?: string;
}

export interface QueryPoint {
  row: number;
  column: number;
  index: number;
}

export interface QueryCapture {
  name: string;
  text: string;
  nodeType: string;
  start: QueryPoint;
  end: QueryPoint;
}

export interface QueryMatch {
  patternIndex: number;
  captures: QueryCapture[];
}

const NON_NATIVE_PARSER_UNAVAILABLE_MESSAGE =
  "Non-native Tree-sitter parser is unavailable; native parser is the only grammar backend";

function createUnavailableError(feature: string): Error {
  return new Error(`${NON_NATIVE_PARSER_UNAVAILABLE_MESSAGE} for ${feature}`);
}

export function __resetParserBackendModuleForTests(): void {
  // Kept for tests that reset parser backends between cases.
}

export function isNonNativeParserAvailable(): boolean {
  return false;
}

export function isNonNativeParserUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(NON_NATIVE_PARSER_UNAVAILABLE_MESSAGE);
}

export function loadTreeSitterLanguage(packageName: string): ParserLanguage {
  return { name: packageName };
}

export function loadTypeScriptGrammars(): {
  typescript: ParserLanguage;
  tsx: ParserLanguage;
} {
  return {
    typescript: { name: "tree-sitter-typescript/typescript" },
    tsx: { name: "tree-sitter-typescript/tsx" },
  };
}

export function parseWithLanguage(_source: string, _language: ParserLanguage): ParserSyntaxTree {
  throw createUnavailableError("syntax-tree parsing");
}

export function isParserSyntaxTree(tree: unknown): tree is ParserSyntaxTree {
  return typeof tree === "object" && tree !== null && "rootNode" in tree && "walk" in tree;
}

export function executeQueryAsNativeMatches(
  _source: string,
  _language: ParserLanguage,
  _queryText: string,
  _tree?: ParserSyntaxTree,
): QueryMatch[] {
  throw createUnavailableError("query execution");
}
