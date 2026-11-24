import type { SyntaxNodeLike } from "../../languages/types.js";

/**
 * Syntax-proven identity of shared type parts. C# retains kind, generic arity and file scope;
 * a constrained Swift extension donates members only to a receiver with those same constraints.
 */
export type SharedOwnerIdentity = {
  languageId: string;
  fullPath: string;
  declarationKind?: string;
  genericArity?: number;
  swiftConstraint?: string;
  fileLocalTo?: string;
};

export type SharedOwnerRules = Readonly<{
  containerTypes: ReadonlySet<string>;
  identity(container: SyntaxNodeLike, source: string, file: string): SharedOwnerIdentity | null;
  peerNameKey?: (name: string) => string;
  declarationsAreEquivalent?: boolean;
  unitOptions?: { csharpQualifiedName: true };
  isExtension?: (container: SyntaxNodeLike, source: string) => boolean;
  memberVisible?: (ownerFile: string, peerFile: string, name: SyntaxNodeLike | null) => boolean;
}>;
