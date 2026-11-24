import type { LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import type { ImportBinding } from "./import-types.js";
import type { CallableIdentity } from "../languages/callable-arity.js";

/** Special same-scope binding behavior; absent fields preserve the generic scope walk. */
export type ScopeBindingRules = Readonly<{
  functionRedeclarations?: "latest" | "shared-occurrences" | "overload-group" | "signature-group";
  usesTagNamespace?: boolean;
  qualifiedFunctionNames?: boolean;
  variablePrefix?: string;
  implicitReceiverName?: string;
  /** Pattern nodes whose name alone binds, while all other children are reads. */
  nameOnlyPatternTypes?: ReadonlySet<string>;
  /** Function declarations under these parents bind outside the type-parameter scope. */
  functionOutsideTypeScopeParents?: ReadonlySet<string>;
  /** Nested type scopes keyed by node type and constrained by their parent's node type. */
  nestedTypeScopeParents?: Readonly<Record<string, string>>;
  /** A declaration-shaped name that is instead a use. */
  declarationNameIsUse?: (node: SyntaxNodeLike) => boolean;
  /** Member-access property names do not bind lexically. */
  nonLexicalMemberAccess?: true;
  /** A special use that bypasses lexical lookup. */
  nonLexicalUse?: (node: SyntaxNodeLike) => boolean;
  /** Class declarations carrying this keyword do not declare a new class binding. */
  classNameExclusion?: { field: string; keyword: string };
  /** Syntax of an implicit receiver's property name. */
  receiverProperty?: {
    accessType: string;
    nameField: string;
    fallbackNameType: string;
    receiverField: string;
  };
  /** Extra names promoted to bindings in a containing declaration. */
  promotedBindings?: {
    containerTypes: ReadonlySet<string>;
    collect: (container: SyntaxNodeLike, source: string) => readonly SyntaxNodeLike[];
  };
  /** Resolve a qualified lexical name through nested owner scopes. */
  qualifiedNameBinding?: (
    index: ScopeIndex,
    name: string,
    node: SyntaxNodeLike,
    support: LanguageSupport,
    resolve: (index: ScopeIndex, name: string, node: SyntaxNodeLike, support: LanguageSupport) => Binding | null,
    qualifiedNameNode: (node: SyntaxNodeLike) => SyntaxNodeLike | null,
  ) => Binding | null;
  /** Type-argument arity and a specialized binding rejection for the current use. */
  typeArgumentArity?: (node: SyntaxNodeLike) => number;
  rejectsTypeArity?: (binding: Binding, use: SyntaxNodeLike, arity: number) => boolean;
  /** Choose the effective module binding after lexical and import candidates are collected. */
  effectiveModuleBinding?: (
    binding: Binding,
    use: SyntaxNodeLike,
    runtime: boolean,
    pendingInDefault: (start: number | undefined, use: SyntaxNodeLike) => boolean,
    selectExplicitOrLocal: (
      imports: readonly ImportBinding[],
      languageId: string,
      matches: (binding: ImportBinding) => boolean,
      localStartIndex?: number,
      referenceIndex?: number,
      includeLaterModuleBindings?: boolean,
    ) => { kind: "explicit"; binding: ImportBinding } | { kind: "local" } | undefined,
  ) => Binding | null;
  /** Return true when the specialized operation handled the binding, or undefined to continue. */
  specialBinding?: (scope: Scope, binding: Binding, node: SyntaxNodeLike) => true | undefined;
}>;

export type BindingKind =
  | "local"
  | "param"
  | "function"
  | "class"
  | "type"
  | "importDefault"
  | "importNamed"
  | "namespace";

export type ScopeImportBinding = ImportBinding;

export type Binding = {
  /** Exact identifier spelling from source, for display and persisted identities. */
  name: string;
  /** Per-language canonical identifier spelling, for lexical scope lookup only. */
  canonicalName: string;
  kind: BindingKind;
  def?: Range;
  callable?: CallableIdentity;
  node?: SyntaxNodeLike;
  /** This binding needs the language's conditional-visibility check. */
  conditionalVisibility?: true;
  occurrences: Range[];
  /** False when same-scope overloads or redeclarations prevent exact occurrence ownership. */
  occurrencesComplete?: boolean;
  /** Same-scope function declarations that collide by name and need semantic disambiguation. */
  sameScopeFunctionBindings?: Binding[];
  /**
   * The binding this declaration replaced in the same scope. Point-of-declaration
   * lookup walks the chain so an earlier same-scope binding stays addressable.
   */
  earlierSameScope?: Binding;
  /**
   * The binding covers every use in its scope, including text that precedes the
   * declaration. Recorded when the binding is registered so a later lookup can
   * compare source indexes instead of walking the declaration's ancestors.
   */
  coversEnclosingScope?: boolean;
  /**
   * The class or module that declares a generated member (Ruby `attr_reader :name`). Every class of a file shares the
   * file scope, so the language decides which uses the member names.
   */
  generatedOwner?: SyntaxNodeLike;
  /** Same-file module specifier proven by a JS/TS local declaration or its assignments; null if invalidated. */
  heldModuleSpecifier?: string | null;
  import?: ScopeImportBinding;
};

export type Scope = {
  kind: "module" | "function" | "block" | "member" | "type";
  map: Map<string, Binding>;
  node: SyntaxNodeLike;
  parent: Scope | undefined;
  /**
   * Names this scope will still bind with a declaration that covers earlier uses.
   * Removed as each of those declarations is registered, so a use defers only while
   * a later declaration in this scope may shadow what eager lookup already found.
   */
  pendingCoveringNames?: Set<string>;
  /** Syntax-node ids of uses resolved when this scope closes. Absent when nothing is waiting. */
  queuedUseIds?: number[];
  /**
   * Set when the scope's node is a gate the locals of the outer scopes do not reach through: a Ruby `def`, or the body
   * of a `class`, `module`, or `class << self`. A body holds only its own locals (its methods, classes, and constants
   * bind in the scope outside it), so it never gains a binding that covers an earlier use. Reading it here keeps a
   * lookup from reading the node's type at every scope it climbs.
   */
  gate?: "def" | "body";
};

export type ScopeIndex = {
  bindings: Map<string, Binding[]>;
  all: Binding[];
  allScopes: Scope[];
  cppQualifiedFunctionBindings: Map<string, Binding[]>;
  /**
   * Whether a call in this file may generate methods (Ruby `attr_reader :name`), so uses of the generated names must
   * check `Binding.generatedOwner`. Absent means unknown; a file without the generating text costs nothing.
   */
  hasGeneratedMembers?: boolean;
};
