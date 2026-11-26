import type { ImportNameHooks, ReferenceHooks } from "../name-resolution-types.js";

export const rustReferenceHooks: ReferenceHooks = {
  memberDefinition: { functionType: "function_item", containerTypes: { impl_item: true } },
};

export const rustGraphImportHooks: ImportNameHooks = { moduleNamedImports: true };
