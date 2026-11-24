/**
 * Per-language additions to member navigation (`../navigation-goto.ts`) and to the detailed graph's call edges for
 * resolved member calls. A rule that depends on one language belongs in its policy here, never in a branch on the
 * language id inside a consumer, so go-to-definition, references, and the graph answer the same way. A language
 * without special rules has an empty policy.
 */
import { csharpMemberLookupPolicy } from "./csharp.js";
import { phpMemberLookupPolicy } from "./php.js";
import { rubyMemberLookupPolicy } from "./ruby.js";
import { swiftMemberLookupPolicy } from "./swift.js";
import { javaImplicitReceiverRules, javaMemberUseSyntax } from "./java-receiver.js";
import { kotlinReceiverHooks } from "./kotlin-receiver.js";
import { cppQualifiedOwner } from "./cpp-receiver.js";
import { goReceiverSyntax } from "./go-receiver.js";
import { jvmCrossFileMemberHidden, jvmQualifiedOwner } from "./jvm-owner.js";
import { javascriptOwnerResolution, typescriptOwnerResolution } from "./typescript-owner.js";
import { pythonQualifiedOwner } from "./python-owner.js";
import { kotlinOwnerSyntax } from "./kotlin-owner.js";
import { javaUnprovenReferenceCandidate } from "../../util/java-designators.js";
import { fileIdentityKey } from "../../util/paths.js";
import { getCompilationUnitPeers } from "../compilation-units.js";
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

export const MEMBER_LOOKUP_POLICIES: Readonly<Record<string, MemberLookupPolicy>> = {
  csharp: csharpMemberLookupPolicy,
  cpp: {
    ownerResolution: { lookup: { hierarchy: true }, qualified: cppQualifiedOwner },
  },
  go: { receiverResolution: { syntax: goReceiverSyntax } },
  js: { separateMemberScopes: true, ownerResolution: javascriptOwnerResolution },
  ts: { separateMemberScopes: true, ownerResolution: typescriptOwnerResolution },
  tsx: { separateMemberScopes: true, ownerResolution: typescriptOwnerResolution },
  kotlin: {
    separateMemberScopes: true,
    selection: { inheritOverloads: true, callSite: true },
    receiverResolution: kotlinReceiverHooks,
    ownerResolution: {
      ...kotlinOwnerSyntax,
      lookup: { hierarchy: true },
      memberHidden: jvmCrossFileMemberHidden,
      qualified: jvmQualifiedOwner("kotlin"),
    },
  },
  java: {
    selection: { inheritOverloads: true },
    receiverResolution: { implicit: javaImplicitReceiverRules, memberUse: javaMemberUseSyntax },
    ownerResolution: {
      lookup: { hierarchy: true, directFallback: true },
      memberHidden: jvmCrossFileMemberHidden,
      qualified: jvmQualifiedOwner("java"),
      nonInheritedStaticOwners: { nodeTypes: { interface_declaration: true }, graphKinds: { interface: true } },
    },
    declaredReceiverUsesNameLookup: true,
    membersBeforeFileExports: true,
    unprovenReferenceCandidate: javaUnprovenReferenceCandidate,
    visibleThroughUnit(index, file, definitions, definitionName) {
      if (definitionName.parent?.type !== "enum_constant") return false;
      const peers = getCompilationUnitPeers(index, file).files;
      for (const definition of definitions) {
        const definitionKey = fileIdentityKey(definition.file);
        for (const peer of peers) {
          if (fileIdentityKey(peer) === definitionKey) return true;
        }
      }
      return false;
    },
  },
  php: phpMemberLookupPolicy,
  python: { ownerResolution: { qualified: pythonQualifiedOwner } },
  ruby: rubyMemberLookupPolicy,
  swift: swiftMemberLookupPolicy,
};

export function memberLookupPolicyFor(languageId: string): MemberLookupPolicy {
  return MEMBER_LOOKUP_POLICIES[languageId] ?? NO_POLICY;
}

/** The language policy's superset key for normalized member names. */
export function memberNameKeyFor(support: { readonly id: string }): MemberLookupPolicy["memberNameKey"] {
  return MEMBER_LOOKUP_POLICIES[support.id]?.memberNameKey;
}
