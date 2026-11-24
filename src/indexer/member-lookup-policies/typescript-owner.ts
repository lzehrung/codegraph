import type { OwnerHooks } from "./types.js";

export const javascriptOwnerResolution: OwnerHooks = { lookup: { hierarchy: true } };
export const typescriptOwnerResolution: OwnerHooks = {
  lookup: { hierarchy: true, namespaceContainers: { internal_module: true, module: true } },
};
