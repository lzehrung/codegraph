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
  js: THIS_SUPER_RECEIVERS,
  kotlin: THIS_SUPER_RECEIVERS,
  php: { own: ["$this", "self", "static"], supertype: ["parent"] },
  python: { own: ["self", "cls"], supertype: [] },
  ruby: { own: ["self"], supertype: [] },
  rust: { own: ["self", "Self"], supertype: [] },
  svelte: THIS_SUPER_RECEIVERS,
  swift: SELF_RECEIVERS,
  ts: THIS_SUPER_RECEIVERS,
  tsx: THIS_SUPER_RECEIVERS,
  zig: { own: ["self"], supertype: [] },
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

/**
 * Nodes that bind a value name across the supported grammars: locals, parameters,
 * and assignment targets. A receiver naming one of these is a value, not a type.
 */
const VALUE_BINDING_TYPES: Record<string, true> = {
  assignment: true,
  class_parameter: true,
  formal_parameter: true,
  init_declarator: true,
  let_declaration: true,
  optional_parameter: true,
  parameter: true,
  parameter_declaration: true,
  property_declaration: true,
  required_parameter: true,
  short_var_declaration: true,
  simple_parameter: true,
  typed_parameter: true,
  variable_declaration: true,
  variable_declarator: true,
};

/** Nodes that scope value bindings, including each grammar's file root. */
const BINDING_SCOPE_TYPES: Record<string, true> = {
  arrow_function: true,
  block: true,
  compilation_unit: true,
  function: true,
  function_body: true,
  function_declaration: true,
  function_definition: true,
  function_expression: true,
  function_item: true,
  method: true,
  method_declaration: true,
  method_definition: true,
  module: true,
  program: true,
  source_file: true,
  statement_block: true,
  translation_unit: true,
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

export type ReceiverBinding = { kind: "own-type" } | { kind: "supertype" } | { kind: "named-type"; typeName: string };

/** What one receiver expression proves, memoized per enclosing function and text. */
export type ReceiverProof = {
  /** Node naming the constructed type, when a prior constructor proves one. */
  constructed: SyntaxNodeLike | null;
  /** Whether an enclosing scope binds the receiver name as a value. */
  locallyBound: boolean;
};

/**
 * Whether a scope encloses `receiver` and binds `receiverName` as a value before it.
 * Nested scopes that do not contain the receiver are skipped, so an unrelated
 * function's local never shadows a type name.
 */
function bindsLocalValue(
  receiver: SyntaxNodeLike,
  receiverName: string,
  source: string,
  sup: LanguageSupport,
): boolean {
  const declaresName = (node: SyntaxNodeLike): boolean => {
    if (node.startIndex >= receiver.startIndex) return false;
    if (node !== receiver && BINDING_SCOPE_TYPES[node.type] && !containsIndex(node, receiver.startIndex)) return false;
    if (VALUE_BINDING_TYPES[node.type]) {
      const name = node.childForFieldName("name") ?? node.child(0);
      if (name && isIdentifierType(sup, name.type) && sliceText(name, source) === receiverName) return true;
    }
    return node.namedChildren.some(declaresName);
  };

  for (let current: SyntaxNodeLike | null = receiver.parent; current; current = current.parent) {
    if (BINDING_SCOPE_TYPES[current.type] && current.namedChildren.some(declaresName)) return true;
  }
  return false;
}

function containsIndex(node: SyntaxNodeLike, index: number): boolean {
  return node.startIndex <= index && node.endIndex >= index;
}

/**
 * Classifies a receiver as the declaring type, a supertype, or a named/constructed type.
 * Returns null when the receiver cannot be proven.
 * Named-local constructor lookup is memoized per enclosing function and receiver text.
 */
export function classifyReceiver(
  sup: LanguageSupport,
  receiver: SyntaxNodeLike,
  source: string,
  proofCache: Map<string, ReceiverProof>,
  cacheScope: number,
): ReceiverBinding | null {
  const keywords = RECEIVER_KEYWORDS[sup.id];
  const text = sliceText(receiver, source).trim();
  if (!text) return null;
  if (keywords?.own.includes(text)) return { kind: "own-type" };
  if (keywords?.supertype.includes(text)) return { kind: "supertype" };

  const receiverIsName =
    isIdentifierType(sup, receiver.type) || receiver.type === "type_identifier" || receiver.type === "constant";

  const cacheKey = `${cacheScope}\u0000${text}`;
  let proof = proofCache.get(cacheKey);
  if (!proof) {
    const constructed = receiverConstructorExpression(receiver, source, sup);
    proof = {
      constructed,
      locallyBound: !constructed && receiverIsName && bindsLocalValue(receiver, text, source, sup),
    };
    proofCache.set(cacheKey, proof);
  }
  if (proof.constructed) return { kind: "named-type", typeName: sliceText(proof.constructed, source) };
  if (!receiverIsName) return null;
  // A name bound by a local or parameter is a value, not a type. Without this guard
  // `const Lib = makeOther(); Lib.target()` is attributed to a same-named class by
  // textual collision, which invents an edge instead of proving one.
  if (proof.locallyBound) return null;
  return { kind: "named-type", typeName: text };
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
 * Records proven `calls` edges for deferred receiver invocations.
 * Ambiguous names at a level stop the walk.
 * `super`/`base`/`parent` follow class `extends` ancestors only.
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
  const classAncestorsByOwner = new Map<string, string[]>();
  const pushUnique = (map: Map<string, string[]>, from: string, to: string): void => {
    const list = map.get(from);
    if (!list) map.set(from, [to]);
    else if (!list.includes(to)) list.push(to);
  };
  for (const edge of graph.edges) {
    const label = edge.label;
    if (label === "member_of") {
      pushUnique(membersByOwner, edge.to, edge.from);
      ownerByMember.set(edge.from, edge.to);
      continue;
    }
    if (!label || !HIERARCHY_LABELS[label]) continue;
    pushUnique(supertypesByOwner, edge.from, edge.to);
    if (label === "extends") pushUnique(classAncestorsByOwner, edge.from, edge.to);
  }

  const nextOwners = (ownerId: string, viaSupertypes: boolean): string[] => {
    if (!viaSupertypes) return supertypesByOwner.get(ownerId) ?? [];
    return (classAncestorsByOwner.get(ownerId) ?? []).filter((id) => graph.nodes.get(id)?.kind === "class");
  };

  for (const candidate of candidates) {
    const owner = candidate.ownerId ?? ownerByMember.get(candidate.callerId);
    if (!owner) continue;
    let level = candidate.viaSupertypes ? nextOwners(owner, true) : [owner];
    const visited = new Set<string>(level);
    for (let depth = 0; depth < MAX_SUPERTYPE_DEPTH && level.length; depth += 1) {
      const lookup = provenMemberTarget(graph, membersByOwner, level, candidate);
      if (lookup.status === "unique") {
        recordEdge(candidate.callerId, lookup.memberId, "calls", candidate.site);
        break;
      }
      if (lookup.status === "ambiguous") break;
      const next: string[] = [];
      for (const ownerId of level) {
        for (const supertype of nextOwners(ownerId, candidate.viaSupertypes)) {
          if (visited.has(supertype)) continue;
          visited.add(supertype);
          next.push(supertype);
        }
      }
      level = next;
    }
  }
}

type MemberTargetLookup = { status: "none" } | { status: "unique"; memberId: string } | { status: "ambiguous" };

/**
 * The single callable member named by `candidate` across `owners`.
 * `none` means this depth has no name match and the walk may continue.
 * `ambiguous` means this depth matched the name but could not prove one member,
 * including arity ambiguity, and the walk must stop.
 */
function provenMemberTarget(
  graph: SymbolGraph,
  membersByOwner: ReadonlyMap<string, string[]>,
  owners: readonly string[],
  candidate: ReceiverCallCandidate,
): MemberTargetLookup {
  const matches = new Set<string>();
  for (const ownerId of owners) {
    for (const memberId of membersByOwner.get(ownerId) ?? []) {
      const node = graph.nodes.get(memberId);
      if (!node || node.kind !== "function" || node.name !== candidate.memberName) continue;
      matches.add(memberId);
    }
  }
  if (!matches.size) return { status: "none" };
  if (matches.size === 1) {
    const [memberId] = matches;
    return { status: "unique", memberId: memberId! };
  }
  const byArity = [...matches].filter((memberId) => graph.nodes.get(memberId)?.memberArity === candidate.argumentCount);
  if (byArity.length === 1) return { status: "unique", memberId: byArity[0]! };
  return { status: "ambiguous" };
}
