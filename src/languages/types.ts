import type { Language } from "tree-sitter";

export interface SyntaxPositionLike {
  row: number;
  column: number;
}

export interface SyntaxNodeLike {
  id?: number;
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: SyntaxPositionLike;
  endPosition: SyntaxPositionLike;
  parent: SyntaxNodeLike | null;
  namedChildren: SyntaxNodeLike[];
  previousNamedSibling?: SyntaxNodeLike | null;
  child(index: number): SyntaxNodeLike | null;
  childForFieldName(fieldName: string): SyntaxNodeLike | null;
}

export interface SyntaxTreeLike {
  rootNode: SyntaxNodeLike & {
    descendantForIndex(startIndex: number, endIndex: number): SyntaxNodeLike;
    descendantForPosition(
      start: SyntaxPositionLike,
      end: SyntaxPositionLike,
    ): SyntaxNodeLike;
  };
}

export type NativeQueryKind =
  | "imports"
  | "exports"
  | "locals"
  | "importBindings";

export interface NativeCompatibility {
  normalizeQuery?: (kind: NativeQueryKind, query: string) => string;
  notes?: string[];
}

export interface LanguageDefinition {
  id: string;
  extensions: string[];
  grammar: (filename?: string) => Language;

  /**
   * Configuration for semantic chunking.
   * Defines how to split code into meaningful blocks.
   */
  structure: {
    /** Node types that represent cohesive units (functions, classes) */
    blocks: BlockDefinition[];
    /** Node types that represent inner control flow to split on (if, loops) */
    splitPoints: string[];
    /** Node types for comments */
    comments: string[];
  };

  /**
   * Configuration for dependency graphing and symbol indexing.
   */
  graph: {
    /** Tree-sitter query string for imports */
    imports: string;
    /** Tree-sitter query string for exports */
    exports: string;
    /** Tree-sitter query string for local definitions */
    locals: string;
    /** Tree-sitter query string for import bindings */
    importBindings: string;
  };

  /**
   * Helper to classify a definition node (function vs class vs var).
   */
  classifyDefinition?: (node: SyntaxNodeLike) => string;

  /**
   * Helper to check if a node is a declaration name.
   */
  isDeclarationName?: (node: SyntaxNodeLike) => boolean;

  /**
   * Helper to check if a node creates a block scope.
   */
  createsBlockScope?: (node: SyntaxNodeLike) => boolean;

  /**
   * Helper to check if a node creates a function scope.
   */
  createsFunctionScope?: (node: SyntaxNodeLike) => boolean;

  /**
   * Whether the language supports cross-module symbol resolution.
   */
  supportsCrossModuleSymbols?: boolean;

  /**
   * Helper to check if a statement represents a type-only dependency.
   */
  isTypeOnly?: (stmtText: string) => boolean;

  /**
   * Specific node types used for symbol resolution
   */
  nodeTypes?: {
    identifier: string[];
    propertyIdentifier?: string[];
    shorthandPropertyIdentifier?: string[];
    memberExpression?: string;
  };

  /**
   * Optional native-runtime compatibility hooks for grammar/query differences.
   */
  native?: NativeCompatibility;
}

export interface BlockDefinition {
  type: string;
  nameQuery?: string; // Optional sub-query to find the name node
  captureId?: string; // Custom capture name (defaults to type)
  parentType?: string; // Optional parent node type to anchor the capture (e.g. "program")
  isBlock?: boolean; // If false, do not capture the outer node as a block (default: true)
}
