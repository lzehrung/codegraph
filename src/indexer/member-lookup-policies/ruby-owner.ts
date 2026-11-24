import type { OwnerHooks } from "./types.js";
import type { RubyConstantReference } from "./ruby-owner-types.js";

export const rubyQualifiedOwner: NonNullable<OwnerHooks["qualified"]> = (
  index,
  mod,
  baseName,
  path,
  _normalize,
  _sup,
  _use,
  deps,
) => {
  const reference: RubyConstantReference = { names: [baseName, ...path], anchor: "lexical", namespaces: [] };
  const definition = deps.resolveRubyConstantReference(index, mod, reference);
  return definition ? (deps.memberContainerForDefinition(index, definition) ?? null) : null;
};
