import type { Language, SyntaxNode } from "tree-sitter";

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
  classifyDefinition?: (node: SyntaxNode) => string;

  /**
   * Helper to check if a node is a declaration name.
   */
  isDeclarationName?: (node: SyntaxNode) => boolean;

  /**
   * Helper to check if a node creates a block scope.
   */
  createsBlockScope?: (node: SyntaxNode) => boolean;

  /**
   * Helper to check if a node creates a function scope.
   */
  createsFunctionScope?: (node: SyntaxNode) => boolean;

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
}

export interface BlockDefinition {
  type: string;
  nameQuery?: string; // Optional sub-query to find the name node
  captureId?: string; // Custom capture name (defaults to type)
  parentType?: string; // Optional parent node type to anchor the capture (e.g. "program")
  isBlock?: boolean; // If false, do not capture the outer node as a block (default: true)
}
