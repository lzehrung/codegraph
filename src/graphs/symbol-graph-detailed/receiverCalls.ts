import { receiverConstructorExpression } from "../../indexer/navigation-goto.js";
import { SymbolKind, type SymbolDef } from "../../indexer/types.js";
import type { LanguageSupport } from "../../languages.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import { sliceText } from "../../util/ast.js";
import {
  getMemberAccessParts,
  getNavigationExpressionProperty,
  isMemberAccessNode,
  isMemberReferencePropertyIdentifier,
} from "../../util/memberAccess.js";
import type { SymbolGraph } from "../symbol-graph.js";
import { isIdentifierType } from "./ast.js";

/**
 * A receiver method call whose target could not be proven from the calling module
 * alone. Resolution is deferred until every module has contributed its `member_of`
 * and type-hierarchy edges, because the declaring type may live in another file.
 */
export type ReceiverCallCandidate = {
  /** Symbol node id of the function containing the call. */
  callerId: string;
  /** Declaring type node id, or null to use the type that declares `callerId`. */
  ownerId: string | null;
  /** Resolve only through supertypes, for explicit `parent`/`super`/`base` receivers. */
  viaSupertypes: boolean;
  memberName: string;
  /** Argument count, used only to separate same-named overloads on one type. */
  argumentCount: number;
  site: NonNullable<SymbolGraph["edges"][number]["site"]>;
};

/** Receiver spellings that denote the type declaring the calling member, per language. */
type ReceiverKeywords = { own: readonly string[]; supertype: readonly string[] };

const THIS_SUPER_RECEIVERS: ReceiverKeywords = { own: ["this"], supertype: ["super"] };
const SELF_RECEIVERS: ReceiverKeywords = { own: ["self"], supertype: ["super"] };

const RECEIVER_KEYWORDS: Record<string, ReceiverKeywords> = {
  cpp: { own: ["this"], supertype: [] },
  csharp: { own: ["this"], supertype: ["base"] },
  java: THIS_SUPER_RECEIVERS,
  javascript: THIS_SUPER_RECEIVERS,
  js: THIS_SUPER_RECEIVERS,
  jsx: THIS_SUPER_RECEIVERS,
  kotlin: THIS_SUPER_RECEIVERS,
  php: { own: ["$this", "self", "static"], supertype: ["parent"] },
  python: { own: ["self", "cls"], supertype: [] },
  ruby: SELF_RECEIVERS,
  rust: { own: ["self", "Self"], supertype: [] },
  svelte: THIS_SUPER_RECEIVERS,
  swift: SELF_RECEIVERS,
  ts: THIS_SUPER_RECEIVERS,
  tsx: THIS_SUPER_RECEIVERS,
  typescript: THIS_SUPER_RECEIVERS,
};

/**
 * Call nodes that carry the receiver and the member name on the call node itself
 * instead of exposing a member-access callee.
 */
const RECEIVER_CALL_NODE_TYPES: Record<string, true> = {
  member_call_expression: true,
  method_invocation: true,
  nullsafe_member_call_expression: true,
  scoped_call_expression: true,
};

/** Declaration nodes that lexically own the methods declared inside them. */
const MEMBER_CONTAINER_TYPES: Record<string, true> = {
  abstract_class_declaration: true,
  class: true,
  class_declaration: true,
  class_definition: true,
  class_specifier: true,
  enum_declaration: true,
  extension_declaration: true,
  impl_item: true,
  interface_declaration: true,
  module: true,
  object_declaration: true,
  protocol_declaration: true,
  record_declaration: true,
  singleton_class: true,
  struct_declaration: true,
  struct_item: true,
  struct_specifier: true,
  trait_declaration: true,
  trait_item: true,
};

/** Nodes holding a call's argument list across the supported grammars. */
export const CALL_ARGUMENT_NODE_TYPES: Record<string, true> = {
  argument_list: true,
  arguments: true,
  // Swift wraps its argument list in a call suffix.
  call_suffix: true,
  value_arguments: true,
};

const HIERARCHY_LABELS: Record<string, true> = {
  extends: true,
  implements: true,
  mixin: true,
  trait: true,
};

/** Guards against a cyclic or pathological declared hierarchy. */
const MAX_SUPERTYPE_DEPTH = 16;

export type ReceiverCallAccess = {
  /** Member-access node carrying the receiver, used for import-chain resolution. */
  accessNode: SyntaxNodeLike;
  receiver: SyntaxNodeLike;
  property: SyntaxNodeLike;
};

/**
 * Resolves the receiver and member-name nodes of a call, or null when the call has no
 * receiver or its shape is not a member access. `callee` is the call's resolved callee
 * node when the grammar exposes one.
 */
export function receiverCallAccess(
  sup: LanguageSupport,
  callNode: SyntaxNodeLike,
  callee: SyntaxNodeLike | null,
): ReceiverCallAccess | null {
  let accessNode: SyntaxNodeLike | null = null;
  if (RECEIVER_CALL_NODE_TYPES[callNode.type]) {
    accessNode = callNode;
  } else if (callee && isMemberAccessNode(sup, callee)) {
    accessNode = callee;
  } else if (isMemberAccessNode(sup, callNode)) {
    accessNode = callNode;
  }
  if (!accessNode) return null;

  const parts = getMemberAccessParts(sup, accessNode);
  const receiver = parts.object;
  let property = parts.property;
  if (!property && accessNode.type === "navigation_expression") {
    // Kotlin and Swift member access sometimes exposes the member as a direct child
    // rather than through a navigation suffix node.
    property = getNavigationExpressionProperty(accessNode) ?? accessNode.namedChildren[1] ?? null;
  }
  if (!receiver || !property) return null;
  // A receiverless call whose positional fallback collapsed onto the callee itself.
  if (receiver.startIndex === property.startIndex) return null;
  if (!isMemberReferencePropertyIdentifier(sup, property.type)) return null;
  return { accessNode, receiver, property };
}

export type ReceiverBinding =
  | { kind: "own-type" }
  | { kind: "supertype" }
  | { kind: "named-type"; typeName: string };

/**
 * Classifies what a receiver expression denotes: the type declaring the call, one of
 * its supertypes, or a named type proven by a constructor or a type reference.
 * Returns null for receivers Codegraph cannot prove, so no edge is invented for them.
 *
 * Proving a named local receiver scans the enclosing binding containers, so results
 * are memoized in `constructorCache` under `cacheScope` (the enclosing function's
 * start index) plus the receiver text.
 */
export function classifyReceiver(
  sup: LanguageSupport,
  receiver: SyntaxNodeLike,
  source: string,
  constructorCache: Map<string, SyntaxNodeLike | null>,
  cacheScope: number,
): ReceiverBinding | null {
  const keywords = RECEIVER_KEYWORDS[sup.id];
  const text = sliceText(receiver, source).trim();
  if (!text) return null;
  if (keywords?.own.includes(text)) return { kind: "own-type" };
  if (keywords?.supertype.includes(text)) return { kind: "supertype" };

  const cacheKey = `${cacheScope}\u0000${text}`;
  let constructed = constructorCache.get(cacheKey);
  if (constructed === undefined) {
    constructed = receiverConstructorExpression(receiver, source, sup);
    constructorCache.set(cacheKey, constructed);
  }
  if (constructed) return { kind: "named-type", typeName: sliceText(constructed, source) };

  const receiverIsName =
    isIdentifierType(sup, receiver.type) || receiver.type === "type_identifier" || receiver.type === "constant";
  return receiverIsName ? { kind: "named-type", typeName: text } : null;
}

/** Whether a resolved definition can declare callable members. */
export function declaresMembers(def: SymbolDef): boolean {
  return def.kind === SymbolKind.Class || def.kind === SymbolKind.Interface || def.kind === SymbolKind.TypeAlias;
}

/** Nearest enclosing declaration that lexically owns `node` as a member. */
export function nearestMemberContainer(node: SyntaxNodeLike): SyntaxNodeLike | null {
  let current = node.parent;
  while (current) {
    if (MEMBER_CONTAINER_TYPES[current.type]) return current;
    current = current.parent;
  }
  return null;
}

/** Positional argument count of a call, ignoring comments. */
export function callArgumentCount(callNode: SyntaxNodeLike): number {
  const explicit = callNode.childForFieldName("arguments") ?? callNode.childForFieldName("argument_list");
  let argumentNode =
    explicit ?? (callNode.namedChildren ?? []).find((child) => CALL_ARGUMENT_NODE_TYPES[child.type]) ?? null;
  if (argumentNode?.type === "call_suffix") {
    argumentNode = (argumentNode.namedChildren ?? []).find((child) => child.type === "value_arguments") ?? null;
  }
  if (!argumentNode) return 0;
  return (argumentNode.namedChildren ?? []).filter((argument) => argument.type !== "comment").length;
}

/**
 * Records a resolved `calls` edge for every receiver call whose target is proven by
 * the completed graph: the member is declared by the receiver's type, or by exactly
 * one type in its declared supertype chain.
 *
 * Ambiguous matches are dropped rather than guessed, so call hierarchy keeps
 * reporting only proven edges.
 */
export function emitReceiverCallEdges(
  graph: SymbolGraph,
  candidates: readonly ReceiverCallCandidate[],
  recordEdge: (fromId: string, toId: string, label?: string, site?: SymbolGraph["edges"][number]["site"]) => boolean,
): void {
  if (!candidates.length) return;

  const membersByOwner = new Map<string, string[]>();
  const ownerByMember = new Map<string, string>();
  const supertypesByOwner = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const label = edge.label;
    if (label === "member_of") {
      const members = membersByOwner.get(edge.to);
      if (members) members.push(edge.from);
      else membersByOwner.set(edge.to, [edge.from]);
      ownerByMember.set(edge.from, edge.to);
      continue;
    }
    if (!label || !HIERARCHY_LABELS[label]) continue;
    const supertypes = supertypesByOwner.get(edge.from);
    if (!supertypes) {
      supertypesByOwner.set(edge.from, [edge.to]);
    } else if (!supertypes.includes(edge.to)) {
      supertypes.push(edge.to);
    }
  }

  for (const candidate of candidates) {
    const owner = candidate.ownerId ?? ownerByMember.get(candidate.callerId);
    if (!owner) continue;
    let level = candidate.viaSupertypes ? (supertypesByOwner.get(owner) ?? []) : [owner];
    const visited = new Set<string>(level);
    for (let depth = 0; depth < MAX_SUPERTYPE_DEPTH && level.length; depth += 1) {
      const target = provenMemberTarget(graph, membersByOwner, level, candidate);
      if (target) {
        recordEdge(candidate.callerId, target, "calls", candidate.site);
        break;
      }
      const next: string[] = [];
      for (const ownerId of level) {
        for (const supertype of supertypesByOwner.get(ownerId) ?? []) {
          if (visited.has(supertype)) continue;
          visited.add(supertype);
          next.push(supertype);
        }
      }
      level = next;
    }
  }
}

/** The single callable member named by `candidate` across `owners`, or null when unproven. */
function provenMemberTarget(
  graph: SymbolGraph,
  membersByOwner: ReadonlyMap<string, string[]>,
  owners: readonly string[],
  candidate: ReceiverCallCandidate,
): string | null {
  const matches: string[] = [];
  for (const ownerId of owners) {
    for (const memberId of membersByOwner.get(ownerId) ?? []) {
      const node = graph.nodes.get(memberId);
      if (!node || node.kind !== "function" || node.name !== candidate.memberName) continue;
      if (!matches.includes(memberId)) matches.push(memberId);
    }
  }
  if (matches.length === 1) return matches[0] ?? null;
  if (!matches.length) return null;
  const byArity = matches.filter((memberId) => graph.nodes.get(memberId)?.memberArity === candidate.argumentCount);
  return byArity.length === 1 ? (byArity[0] ?? null) : null;
}
