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

export declare function loadTreeSitterLanguage(packageName: string): JsLanguage;
export declare function loadTypeScriptGrammars(): {
  typescript: JsLanguage;
  tsx: JsLanguage;
};
export declare function parseWithJsLanguage(
  source: string,
  language: JsLanguage,
): JsSyntaxTree;
export declare function isJsSyntaxTree(tree: unknown): tree is JsSyntaxTree;
export declare function executeJsQueryAsNativeMatches(
  source: string,
  language: JsLanguage,
  queryText: string,
  tree?: JsSyntaxTree,
): JsNativeMatch[];
