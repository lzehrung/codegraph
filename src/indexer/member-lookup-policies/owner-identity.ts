import { csharpSharedOwnerRules } from "./csharp-owner.js";
import { swiftSharedOwnerRules } from "./swift-owner.js";
import type { SharedOwnerRules } from "./owner-identity-types.js";

/** Shared-owner syntax selected at the owner boundary, never inside the tree walk. */
export const SHARED_OWNER_RULES: Readonly<Record<string, SharedOwnerRules>> = {
  csharp: csharpSharedOwnerRules,
  swift: swiftSharedOwnerRules,
};
