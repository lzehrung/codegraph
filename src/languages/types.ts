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

export {
  GRAPH_IMPORT_CAPTURES,
  GRAPH_IMPORT_OPTIONAL_CAPTURES,
  GRAPH_IMPORT_REQUIRED_CAPTURES,
  graphCapture,
  graphImportCaptures,
  importCapture,
  isGraphImportCapture,
} from "./graph-captures.js";
export type {
  GraphImportCapture,
  GraphImportCaptureExcludesMod,
  GraphImportCaptureMap,
  GraphImportOptionalCapture,
  GraphImportRequiredCapture,
} from "./graph-captures.js";

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
   * Defaults to false; set true only for languages whose unqualified names really
   * do resolve against enclosing members (Java, C#, Kotlin, Swift, Ruby, C++).
   */
  membersAreImplicitlyInScope?: boolean;

  /**
   * The methods one node defines without a `def`. Any other node defines none. Indexing, lexical scope, and the
   * detailed graph all read this, so a generated method resolves wherever a declared one does.
   */
  generatedMembers?: (node: SyntaxNodeLike) => readonly GeneratedMember[];

  /**
   * Text every call that generates members contains (Ruby `attr_`). A file without it generates nothing, so the walks
   * that look for generated members skip it.
   */
  generatedMembersMarker?: string;

  /**
   * Whether the class or module `owner` that declares a generated method names it at `use`. Every class of a file shares
   * the file scope, so scope alone would bind the method in unrelated classes: Ruby `attr_reader :name` is a method of
   * its own class, reached by a bare name only inside that class's instance methods.
   */
  generatedMemberVisibleAt?: (owner: SyntaxNodeLike, use: SyntaxNodeLike) => boolean;

  /**
   * Whether the receiver `self` at `use` is an instance of the enclosing class, rather than the class itself. A
   * generated method is an instance method, so `self.name` reaches it only where `self` is an instance: Ruby inside an
   * instance method, never in a singleton method, a `class << self` body, or a class body.
   */
  selfIsInstanceAt?: (use: SyntaxNodeLike) => boolean;

  /**
   * The method that a member-access property invokes, when its text does not say so: Ruby `x.name = value` invokes
   * the writer `name=`.
   */
  invokedMemberName?: (property: SyntaxNodeLike) => string;

  /**
   * How call sites spell a declared method name, for reference candidates: Ruby writes the setter `name=` as `name`.
   */
  useSiteMemberName?: (declared: string) => string;

  /**
   * Whether the name token `node` only spells a declaration, though its text equals the use-site spelling of another
   * name: the `name` of Ruby `def name=(value)` declares the writer `name=` and is no use of a reader `name`. Reference
   * candidates skip it.
   */
  isDeclarationSpelling?: (node: SyntaxNodeLike) => boolean;

  /**
   * The identifier token a Bloom filter holds for a method name that is not one itself: Ruby `empty?` is stored as
   * `empty`, because `?` is no identifier character.
   */
  bloomProbeName?: (name: string) => string;

  /**
   * Whether the language supports cross-module symbol resolution.
   */
  supportsCrossModuleSymbols?: boolean;

  /**
   * Node types whose subtree is not module scope. An `exports` capture with one of these as an
   * ancestor is dropped, so a name declared inside a function body never becomes a module export.
   * Write `parent>node` when the body node type is reused elsewhere: Python function and class
   * bodies are both `block`, so only `function_definition>block` blocks.
   *
   * Languages whose `exports` query can anchor on the file root do that instead. C and C++ cannot:
   * a header wraps its declarations in an include guard, so the anchor would have to enumerate
   * every preprocessor nesting depth.
   */
  exportScopeBlockers?: readonly string[];

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

/**
 * A method that a declaration-like call defines without a `def`, such as Ruby's `attr_reader :name`. `node` is the
 * argument token that names it, so go-to-definition lands there.
 */
export interface GeneratedMember {
  name: string;
  node: SyntaxNodeLike;
  /** Positional arguments the generated method accepts. */
  arity: number;
}

export interface BlockDefinition {
  type: string;
  nameQuery?: string; // Optional sub-query to find the name node
  captureId?: string; // Custom capture name (defaults to type)
  parentType?: string; // Optional parent node type to anchor the capture (e.g. "program")
  isBlock?: boolean; // If false, do not capture the outer node as a block (default: true)
}
