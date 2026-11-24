import type { GraphHooks } from "./types.js";

export const cGraphHooks: GraphHooks = {
  callableBindingGroups: "canonical-name",
  aliasExportOptions: { allowLocalFallback: false, cNamespace: "ordinary" },
};
