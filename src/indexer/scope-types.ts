import type { SyntaxNodeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import type { ImportBinding } from "./import-types.js";

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
  node?: SyntaxNodeLike;
  occurrences: Range[];
  import?: ScopeImportBinding;
};

export type Scope = {
  kind: "module" | "function" | "block";
  map: Map<string, Binding>;
  node: SyntaxNodeLike;
  parent: Scope | undefined;
};

export type ScopeIndex = {
  bindings: Map<string, Binding[]>;
  all: Binding[];
  allScopes: Scope[];
};
