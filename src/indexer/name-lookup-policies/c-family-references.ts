import type { ReferenceHooks } from "../name-resolution-types.js";
import { AMBIGUOUS_CPP_OVERLOAD_REASON } from "../ambiguous-resolution.js";

export const cReferenceHooks: ReferenceHooks = {
  callableVerification: "all",
  callableEquivalence: { links: "includes" },
};

export const cppReferenceHooks: ReferenceHooks = {
  callableVerification: "all",
  callableEquivalence: { links: "qualified-owners" },
  includedCallableMissReason: AMBIGUOUS_CPP_OVERLOAD_REASON,
  exportedNameSeparator: "::",
  memberDefinition: {
    functionType: "function_definition",
    containerTypes: { class_specifier: true, struct_specifier: true, union_specifier: true },
  },
};
