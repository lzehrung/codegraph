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
  name: string;
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
