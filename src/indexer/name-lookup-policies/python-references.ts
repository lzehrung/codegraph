import type { ReferenceHooks } from "../name-resolution-types.js";

export const pythonReferenceHooks: ReferenceHooks = {
  namespaceBindingScope: "effective-import",
  packageSubmodules: true,
};
