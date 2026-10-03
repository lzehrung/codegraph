import type { SyntaxNodeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import type { ImportBinding } from "./import-types.js";
import type { CallableIdentity } from "../languages/callable-arity.js";

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
};

export type ScopeIndex = {
  bindings: Map<string, Binding[]>;
  all: Binding[];
  allScopes: Scope[];
  cppQualifiedFunctionBindings: Map<string, Binding[]>;
};
