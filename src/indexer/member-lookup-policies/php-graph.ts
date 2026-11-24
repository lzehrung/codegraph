import type { GraphHooks } from "./types.js";

export const phpGraphHooks: GraphHooks = {
  callableNameForm: "case-folded",
  namedNodeTypes: { qualified_name: true, relative_name: true },
  abstractMemberOwnerType: "trait_declaration",
  ignoredBaseSpecifierTypes: { use_list: true },
};
