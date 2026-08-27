export interface SyntaxPositionLike {
  row: number;
  column: number;
}

export interface SyntaxNodeLike {
  readonly id?: number;
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: SyntaxPositionLike;
  endPosition: SyntaxPositionLike;
  parent: SyntaxNodeLike | null;
  namedChildren: SyntaxNodeLike[];
  previousSibling?: SyntaxNodeLike | null;
  previousNamedSibling?: SyntaxNodeLike | null;
  child(index: number): SyntaxNodeLike | null;
  childForFieldName(fieldName: string): SyntaxNodeLike | null;
}

export interface SyntaxTreeLike {
  rootNode: SyntaxNodeLike & {
    descendantForIndex(startIndex: number, endIndex: number): SyntaxNodeLike;
    descendantForPosition(start: SyntaxPositionLike, end: SyntaxPositionLike): SyntaxNodeLike;
  };
}

export type NativeQueryKind = "imports" | "exports" | "locals" | "importBindings";

export type NativeCompatibilityQueryKind = NativeQueryKind | "adHoc";

export interface NativeCompatibility {
  normalizeQuery?: (kind: NativeCompatibilityQueryKind, query: string) => string;
  authoritativeKinds?: NativeQueryKind[];
  notes?: string[];
}

export interface LanguageDefinition {
  id: string;
  extensions: string[];

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
   * Whether native local-definition captures are authoritative for this language.
   */
  usesQueryDrivenLocals?: boolean;

  /**
   * Helper to classify a definition node (function vs class vs var).
   */
  classifyDefinition?: (node: SyntaxNodeLike) => string;

  /**
   * Helper to check if a node is a declaration name.
   */
  isDeclarationName?: (node: SyntaxNodeLike) => boolean;

  /**
   * Names that must be registered by scope construction in addition to its
   * structural declaration handling. "all" preserves a language's established
   * declaration-name semantics; a predicate can opt in a missing node shape.
   */
  scopeDeclarationNames?: "all" | ((node: SyntaxNodeLike) => boolean);

  /**
   * Normalizes syntax-specific identifier spelling for lexical scope matching.
   */
  normalizeIdentifier?: (name: string) => string;

  /**
   * Helper to check if a node creates a block scope.
   */
  createsBlockScope?: (node: SyntaxNodeLike) => boolean;

  /**
   * Helper to check if a node creates a function scope.
   */
  createsFunctionScope?: (node: SyntaxNodeLike) => boolean;

  /**
   * Whether an unqualified call within a type can resolve to one of its members.
   */
  membersAreImplicitlyInScope?: boolean;

  /**
   * Whether the language supports cross-module symbol resolution.
   */
  supportsCrossModuleSymbols?: boolean;

  /**
   * Helper to check if a statement represents a type-only dependency.
   */
  isTypeOnly?: (stmtText: string) => boolean;

  /**
   * Whether export-from declarations can be reported as symbol references.
   */
  supportsExportFromReferences?: boolean;

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
