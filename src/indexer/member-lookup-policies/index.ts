/**
 * Per-language additions to member navigation (`../navigation-goto.ts`) and to the detailed graph's call edges for
 * resolved member calls. A rule that depends on one language belongs in its policy here, never in a branch on the
 * language id inside a consumer, so go-to-definition, references, and the graph answer the same way. A language
 * without special rules has an empty policy.
 */
import { swiftMemberLookupPolicy } from "./swift.js";
import type { MemberLookupPolicy } from "./types.js";

export type {
  MemberCallEdge,
  MemberOwnerRef,
  RenameLinkageGraph,
  MemberUse,
  MemberLookupDeps,
  MemberWalkOwner,
  MemberWalkRules,
  MemberAccessRules,
  MemberLookupPolicy,
} from "./types.js";

const NO_POLICY: MemberLookupPolicy = {};

const POLICIES: Readonly<Record<string, MemberLookupPolicy>> = {
  swift: swiftMemberLookupPolicy,
};

export function memberLookupPolicyFor(languageId: string): MemberLookupPolicy {
  return POLICIES[languageId] ?? NO_POLICY;
}
