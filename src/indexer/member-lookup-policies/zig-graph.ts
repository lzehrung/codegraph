import type { GraphHooks } from "./types.js";

export const zigGraphHooks: GraphHooks = {
  memberOwnerSyntax: "assigned-struct",
  qualifiedTypeChains: true,
  membersNeedReceiver: true,
};
