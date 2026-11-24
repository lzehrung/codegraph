import type { ReferenceHooks } from "../name-resolution-types.js";

export const rustReferenceHooks: ReferenceHooks = {
  memberDefinition: { functionType: "function_item", containerTypes: { impl_item: true } },
};
