import type { GraphHooks } from "./types.js";

export const cppGraphHooks: GraphHooks = {
  callableBindingGroups: "equivalent-signature",
  aliasExportOptions: { allowLocalFallback: false },
  namedNodeTypes: { operator_name: true, destructor_name: true },
  preservedBaseSpecifierTypes: { qualified_identifier: true },
  scopePathType: "qualified_identifier",
  memberOwnerSyntax: "qualified-declarator",
};
