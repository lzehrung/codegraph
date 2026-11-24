export type MemberScope = "any" | "static" | "instance";

export type MemberSelectionOptions = {
  name: string;
  argumentCount: number | null;
  scope: MemberScope;
  useFile: string;
  /** Callable names fold ASCII case; data member names keep their source spelling. */
  caseInsensitiveCallableNames?: boolean;
  separateMemberScopes?: boolean;
  classAncestorsOnly?: boolean;
  startAtAncestor?: boolean;
  keepUniqueArityMismatch?: boolean;
  /**
   * With `inheritOverloads`, a lone mismatched member stands in only when the receiver's own type declares it. This
   * moves the stand-in to the first level of the hierarchy that declares the name, as if the walk stopped there: a lone
   * declaration inherited from an ancestor stands in, and declarations further up do not compete with it.
   */
  standInAtFirstDeclaringLevel?: boolean;
  inheritOverloads?: boolean;
  /** Ruby reopening uses the first indexed declaration for a method name. */
  firstDeclarationWins?: boolean;
  /** Language-specific identifier equality; source names remain unchanged. */
  normalizeIdentifier?: ((name: string) => string) | undefined;
  /** A call prefers methods and invokable properties; a value read prefers non-method members. */
  callSite?: boolean;
  valueRead?: boolean;
};
