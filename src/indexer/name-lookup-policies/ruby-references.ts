import type { ReferenceHooks } from "../name-resolution-types.js";

export const rubyReferenceHooks: ReferenceHooks = {
  exportedNameSeparator: "::",
  // `def Foo.name` and `def klass.name` define a method of that object wherever they stand, so its calls go through the
  // object (`Foo.name`) and each same-named site is checked as a receiver member call.
  memberDefinition: { functionType: "singleton_method", containerTypes: { singleton_method: true } },
};
