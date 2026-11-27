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
import { selectGoReceiverMember } from "./go-owner.js";
import { jvmCrossFileMemberHidden, jvmQualifiedOwner } from "./jvm-owner.js";
import { javascriptOwnerResolution, typescriptOwnerResolution } from "./typescript-owner.js";
import { pythonQualifiedOwner } from "./python-owner.js";
import { kotlinExtensionMember, kotlinOwnerSyntax } from "./kotlin-owner.js";
import { selectRustReceiverMember } from "./rust-owner.js";
import { graphRulesFor } from "./graph-rules.js";
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
  c: { graph: graphRulesFor("c") },
  csharp: { ...csharpMemberLookupPolicy, graph: graphRulesFor("csharp") },
  cpp: {
    receiverResolution: {
      construction: { scopePathTypes: true },
      access: { scopedMemberType: "qualified_identifier" },
    },
    ownerResolution: { lookup: { hierarchy: true }, qualified: cppQualifiedOwner, heritage: { scopePaths: true } },
    graph: graphRulesFor("cpp"),
  },
  go: {
    receiverResolution: {
      syntax: goReceiverSyntax,
      construction: { namedPeerTypes: true },
      access: { embeddedFieldTypes: true },
    },
    ownerResolution: { receiverMembers: selectGoReceiverMember },
  },
  js: { separateMemberScopes: true, ownerResolution: javascriptOwnerResolution },
  ts: { separateMemberScopes: true, ownerResolution: typescriptOwnerResolution, graph: graphRulesFor("ts") },
  tsx: { separateMemberScopes: true, ownerResolution: typescriptOwnerResolution, graph: graphRulesFor("tsx") },
  kotlin: {
    separateMemberScopes: true,
    selection: { inheritOverloads: true, callSite: true },
    receiverResolution: kotlinReceiverHooks,
    ownerResolution: {
      ...kotlinOwnerSyntax,
      lookup: { hierarchy: true },
      memberHidden: jvmCrossFileMemberHidden,
      qualified: jvmQualifiedOwner("kotlin"),
      receiverMembers: kotlinExtensionMember,
    },
    graph: graphRulesFor("kotlin"),
  },
  java: {
    selection: { inheritOverloads: true },
    receiverResolution: {
      implicit: javaImplicitReceiverRules,
      memberUse: javaMemberUseSyntax,
      access: {
        qualifiedTypeNames: true,
        unitPeerNames: true,
        scopedNameTypes: { scoped_identifier: true, scoped_type_identifier: true },
      },
    },
    ownerResolution: {
      lookup: { hierarchy: true, directFallback: true },
      memberHidden: jvmCrossFileMemberHidden,
      qualified: jvmQualifiedOwner("java"),
      nonInheritedStaticOwners: { nodeTypes: { interface_declaration: true }, graphKinds: { interface: true } },
    },
    graph: graphRulesFor("java"),
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
  php: { ...phpMemberLookupPolicy, graph: graphRulesFor("php") },
  python: {
    receiverResolution: {
      access: { annotationTypes: true, positionedImports: true, dottedImports: true, classAttributeMembers: true },
    },
    ownerResolution: { qualified: pythonQualifiedOwner, scopedBaseNames: true },
  },
  ruby: { ...rubyMemberLookupPolicy, graph: graphRulesFor("ruby") },
  rust: {
    receiverResolution: { access: { moduleNamedImports: true } },
    ownerResolution: { receiverMembers: selectRustReceiverMember },
  },
  swift: { ...swiftMemberLookupPolicy, graph: graphRulesFor("swift") },
  zig: { receiverResolution: { access: { innermostNamespaceImports: true } } },
};

export function memberLookupPolicyFor(languageId: string): MemberLookupPolicy {
  return MEMBER_LOOKUP_POLICIES[languageId] ?? NO_POLICY;
}

/** The language policy's superset key for normalized member names. */
export function memberNameKeyFor(support: { readonly id: string }): MemberLookupPolicy["memberNameKey"] {
  return MEMBER_LOOKUP_POLICIES[support.id]?.memberNameKey;
}
