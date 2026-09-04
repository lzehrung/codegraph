import type { ModuleIndex, ProjectIndex, SymbolDef } from "../../indexer/types.js";
import type { LanguageSupport } from "../../languages.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import { sliceText, toRange } from "../../util/ast.js";
import { getMemberAccessParts } from "../../util/memberAccess.js";
import { fileIdentityKey } from "../../util/paths.js";
import { defNodeId, nodeForDef, type SymbolGraph } from "../symbol-graph.js";
import type { DetailedClassNode, DetailedFunctionNode } from "./ast.js";
import { collectIdentifiers, collectNodesByType, findFirstNodeByType, isIdentifierType } from "./ast.js";
import {
  CALL_ARGUMENT_NODE_TYPES,
  callArgumentCount,
  classifyReceiver,
  declaresMembers,
  nearestMemberContainer,
  receiverCallAccess,
  type ReceiverCallAccess,
  type ReceiverCallCandidate,
} from "./receiverCalls.js";

type EdgePassContext = {
  index: ProjectIndex;
  sup: LanguageSupport;
  source: string;
  moduleEntry: ModuleIndex;
  nodes: SymbolGraph["nodes"];
  membersOnly: boolean;
  memberExpressionType: string;
  propertyIdentifierTypes: string[];
  optionalMemberTypes: Set<string>;
  aliasToTargetDef: Map<string, SymbolDef>;
  aliasToTargetModule: Map<string, string>;
  resolveIdentifier: (name: string) => SymbolDef | null;
  resolveExportFrom: (file: string, exportedName: string) => SymbolDef | null;
  resolveMemberChainTarget: (chainNode: SyntaxNodeLike) => SymbolDef | null;
  recordEdge: (fromId: string, toId: string, label?: string, site?: SymbolGraph["edges"][number]["site"]) => boolean;
  /** Receiver calls whose target needs the completed graph; resolved after every module. */
  receiverCalls: ReceiverCallCandidate[];
  /** Whether any indexed project file declares a callable with this name. */
  hasCallableNamed: (name: string) => boolean;
};

function ensureNode(context: EdgePassContext, def: SymbolDef): string {
  const id = defNodeId(def);
  if (!context.nodes.has(id)) context.nodes.set(id, nodeForDef(def));
  return id;
}
function markImplementationTarget(
  context: EdgePassContext,
  id: string,
  declarationNode: SyntaxNodeLike,
  def: SymbolDef,
): void {
  const declaration = sliceText(declarationNode, context.source);
  const nameIndex = declaration.indexOf(def.localName);
  const prefix = nameIndex >= 0 ? declaration.slice(0, nameIndex) : declaration;
  if (!/\b(?:abstract|virtual|override)\b/.test(prefix)) return;
  const node = context.nodes.get(id);
  if (node) node.implementationTarget = true;
}
function markMemberArity(context: EdgePassContext, id: string, declarationNode: SyntaxNodeLike): void {
  let parameters = declarationNode.childForFieldName("parameters");
  if (!parameters) {
    for (const type of [
      "formal_parameters",
      "parameter_list",
      "parameters",
      "method_parameters",
      "function_parameter_clause",
    ]) {
      parameters = findFirstNodeByType(declarationNode, type);
      if (parameters) break;
    }
  }
  if (!parameters) return;
  const arity = (parameters.namedChildren ?? []).filter((child) => child.type !== "comment").length;
  const node = context.nodes.get(id);
  if (node) node.memberArity = arity;
}

function recordDefEdge(
  context: EdgePassContext,
  fromId: string,
  target: SymbolDef,
  label: string,
  siteNode?: SyntaxNodeLike,
): boolean {
  const toId = ensureNode(context, target);
  return context.recordEdge(
    fromId,
    toId,
    label,
    siteNode ? { file: context.moduleEntry.file, range: toRange(siteNode) } : undefined,
  );
}

function tryResolveChain(context: EdgePassContext, node: SyntaxNodeLike, fromId?: string, label = "uses"): boolean {
  const targetDef = context.resolveMemberChainTarget(node);
  if (targetDef && fromId) {
    recordDefEdge(context, fromId, targetDef, label, node);
    return true;
  }
  return !!targetDef;
}

/** Records an edge for a resolvable target node. Returns whether a target was resolved. */
function tryResolveNode(context: EdgePassContext, node: SyntaxNodeLike, fromId: string, label: string): boolean {
  if (isIdentifierType(context.sup, node.type) || node.type === "type_identifier") {
    const name = sliceText(node, context.source);
    const target = context.resolveIdentifier(name);
    if (target) {
      recordDefEdge(context, fromId, target, label, node);
      return true;
    }
  }
  if (context.optionalMemberTypes.has(node.type)) {
    return tryResolveChain(context, node, fromId, label);
  }
  return false;
}

function getCallTarget(node: SyntaxNodeLike): SyntaxNodeLike | null {
  const explicitTarget =
    node.childForFieldName("function") ??
    node.childForFieldName("callee") ??
    node.childForFieldName("name") ??
    node.childForFieldName("method") ??
    node.childForFieldName("member") ??
    node.childForFieldName("expression");
  if (explicitTarget) return explicitTarget;
  // Kotlin and Swift calls name no callee field, so the sole non-argument child is it.
  const nonArgumentChildren = node.namedChildren.filter((child) => !CALL_ARGUMENT_NODE_TYPES[child.type]);
  return nonArgumentChildren.length === 1 ? (nonArgumentChildren[0] ?? null) : null;
}

function getNewTarget(node: SyntaxNodeLike): SyntaxNodeLike | null {
  return (
    node.childForFieldName("constructor") ??
    node.childForFieldName("type") ??
    node.childForFieldName("name") ??
    node.namedChildren.find((child) => child.type === "type_identifier") ??
    node.child(0)
  );
}

export function emitPythonDecoratorEdges(context: EdgePassContext, rootNode: SyntaxNodeLike): void {
  if (context.sup.id !== "python") return;

  const addDecoratorUses = (node: SyntaxNodeLike): void => {
    if (node.type === "decorated_definition") {
      const fn = node.namedChildren.find((child) => child.type === "function_definition");
      if (fn) addDecoratorUses(fn);
      for (const decoratorChild of node.namedChildren) {
        if (decoratorChild.type !== "decorator") continue;
        const nameNode = fn?.childForFieldName("name");
        if (!nameNode) continue;
        const name = sliceText(nameNode, context.source);
        const def = context.moduleEntry.locals.find((local) => local.localName === name);
        if (!def) continue;
        const fromId = ensureNode(context, def);
        const expr =
          decoratorChild.childForFieldName?.("name") ?? decoratorChild.namedChildren?.[0] ?? decoratorChild.child(1);
        if (expr) tryResolveNode(context, expr, fromId, "decorates");
      }
    } else if (node.type === "function_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const name = sliceText(nameNode, context.source);
        const def = context.moduleEntry.locals.find((local) => local.localName === name);
        if (def) {
          const fromId = ensureNode(context, def);
          let prev = node.previousSibling;
          while (prev) {
            if (prev.type === "decorated_definition") {
              for (const decoratorChild of prev.namedChildren) {
                if (decoratorChild.type === "decorator") {
                  const expr =
                    decoratorChild.childForFieldName?.("name") ??
                    decoratorChild.namedChildren?.[0] ??
                    decoratorChild.child(1);
                  if (expr) tryResolveNode(context, expr, fromId, "decorates");
                } else if (decoratorChild.type === "attribute") {
                  tryResolveNode(context, decoratorChild, fromId, "decorates");
                }
              }
            } else if (prev.type === "decorator") {
              const expr = prev.childForFieldName?.("name") ?? prev.namedChildren?.[0] ?? prev.child(1);
              if (expr) tryResolveNode(context, expr, fromId, "decorates");
            }
            prev = prev.previousSibling;
          }
        }
      }
    }
    for (const child of node.namedChildren) addDecoratorUses(child);
  };

  addDecoratorUses(rootNode);
}

export function emitMemberOwnershipEdges(
  context: EdgePassContext,
  functionNodes: DetailedFunctionNode[],
  classNodes: DetailedClassNode[],
): void {
  for (const fn of functionNodes) {
    const owners = classNodes
      .filter(
        (candidate) => candidate.node.startIndex <= fn.node.startIndex && candidate.node.endIndex >= fn.node.endIndex,
      )
      .sort((left, right) => left.node.endIndex - left.node.startIndex - (right.node.endIndex - right.node.startIndex));
    const owner = owners[0];
    if (!owner) continue;
    const memberId = ensureNode(context, fn.def);
    markImplementationTarget(context, memberId, fn.node, fn.def);
    markMemberArity(context, memberId, fn.node);
    recordDefEdge(context, memberId, owner.def, "member_of");
  }
}

export function emitFunctionBodyEdges(context: EdgePassContext, functionNodes: DetailedFunctionNode[]): void {
  const callNodeTypes = new Set<string>([
    "call_expression",
    "call",
    "method_invocation",
    "invocation_expression",
    // PHP models plain calls and receiver calls as three distinct call nodes.
    "function_call_expression",
    "member_call_expression",
    "nullsafe_member_call_expression",
    "scoped_call_expression",
  ]);
  const newNodeTypes = new Set<string>([
    "new_expression",
    "object_creation_expression",
    "struct_expression",
    "composite_literal",
  ]);
  // Receiver typing and lexical member lookup are only needed once a receiver call
  // fails the cheaper identifier and import-chain resolution, so both are lazy.
  let membersByContainer: Map<number, DetailedFunctionNode[]> | undefined;
  const lexicalMembers = (container: SyntaxNodeLike): DetailedFunctionNode[] => {
    if (!membersByContainer) {
      membersByContainer = new Map();
      for (const candidate of functionNodes) {
        const owner = nearestMemberContainer(candidate.node);
        if (!owner) continue;
        const members = membersByContainer.get(owner.startIndex);
        if (members) members.push(candidate);
        else membersByContainer.set(owner.startIndex, [candidate]);
      }
    }
    return membersByContainer.get(container.startIndex) ?? [];
  };
  const constructorTypeNames = new Map<string, SyntaxNodeLike | null>();

  for (const fn of functionNodes) {
    const fromId = ensureNode(context, fn.def);
    const seenAliases = new Set<string>();
    const nestedFunctions = new Set(
      functionNodes
        .filter(
          (candidate) =>
            candidate.node !== fn.node &&
            candidate.node.startIndex >= fn.node.startIndex &&
            candidate.node.endIndex <= fn.node.endIndex,
        )
        .map((candidate) => candidate.node),
    );

    const recordAliasUse = (node: SyntaxNodeLike): void => {
      if (context.membersOnly || !isIdentifierType(context.sup, node.type)) return;
      const name = sliceText(node, context.source);
      if (seenAliases.has(name)) return;
      let target: SymbolDef | null = context.aliasToTargetDef.get(name) ?? null;
      if (!target) {
        const modFile = context.aliasToTargetModule.get(name);
        if (modFile) {
          let exportedName: string | null = null;
          const parent = node.parent;
          if (
            parent &&
            (parent.type === context.memberExpressionType || parent.type === "optional_member_expression")
          ) {
            const { property: prop } = getMemberAccessParts(context.sup, parent);
            if (prop && context.propertyIdentifierTypes.includes(prop.type)) {
              exportedName = sliceText(prop, context.source);
            }
          }
          if (exportedName) {
            target = context.resolveExportFrom(modFile, exportedName);
            if (!target) {
              const targetModule = context.index.byFile.get(fileIdentityKey(modFile));
              target = (targetModule?.locals ?? []).find((local) => local.localName === exportedName) ?? null;
            }
          }
        }
      }
      if (!target) return;
      seenAliases.add(name);
      recordDefEdge(context, fromId, target, "uses");
    };

    const recordMemberUse = (node: SyntaxNodeLike): void => {
      if (!context.optionalMemberTypes.has(node.type)) return;
      const targetDef = context.resolveMemberChainTarget(node);
      if (targetDef) {
        recordDefEdge(context, fromId, targetDef, "uses");
      }
    };

    /**
     * Resolves a receiver method call against the receiver's type. Members declared
     * alongside the caller resolve here; anything needing another module's members
     * becomes a deferred candidate.
     */
    const recordReceiverCall = (node: SyntaxNodeLike, access: ReceiverCallAccess): void => {
      const memberName = sliceText(access.property, context.source);
      if (!memberName || !context.hasCallableNamed(memberName)) return;
      const binding = classifyReceiver(
        context.sup,
        access.receiver,
        context.source,
        constructorTypeNames,
        fn.node.startIndex,
      );
      if (!binding) return;

      const site = { file: context.moduleEntry.file, range: toRange(access.property) };
      const argumentCount = callArgumentCount(node);
      if (binding.kind === "named-type") {
        const typeDef = context.resolveIdentifier(binding.typeName);
        if (!typeDef || !declaresMembers(typeDef)) return;
        context.receiverCalls.push({
          callerId: fromId,
          ownerId: ensureNode(context, typeDef),
          viaSupertypes: false,
          memberName,
          argumentCount,
          site,
        });
        return;
      }

      if (binding.kind === "own-type") {
        const container = nearestMemberContainer(fn.node);
        const declared = container
          ? lexicalMembers(container).filter((candidate) => candidate.def.localName === memberName)
          : [];
        if (declared.length === 1) {
          recordDefEdge(context, fromId, declared[0]!.def, "calls", access.property);
          return;
        }
      }
      context.receiverCalls.push({
        callerId: fromId,
        ownerId: null,
        viaSupertypes: binding.kind === "supertype",
        memberName,
        argumentCount,
        site,
      });
    };

    /**
     * Records the `calls` edge for one call node. A call with a receiver is resolved
     * only through its import chain or its receiver's type: matching the bare member
     * name against module locals and import aliases would attribute `$this->helper()`
     * to an unrelated imported `helper`.
     */
    const resolveCallTarget = (node: SyntaxNodeLike, callee: SyntaxNodeLike | null): void => {
      const access = receiverCallAccess(context.sup, node, callee);
      if (access) {
        if (!tryResolveChain(context, access.accessNode, fromId, "calls")) recordReceiverCall(node, access);
        return;
      }
      if (callee) tryResolveNode(context, callee, fromId, "calls");
    };

    const recordCallOrInstantiation = (node: SyntaxNodeLike): boolean => {
      if (callNodeTypes.has(node.type)) {
        if (context.sup.id === "go") {
          const callTarget = getCallTarget(node);
          const calleeName =
            callTarget && isIdentifierType(context.sup, callTarget.type) ? sliceText(callTarget, context.source) : null;
          if (calleeName === "new" || calleeName === "make") {
            const argList = node.childForFieldName("arguments") ?? node.childForFieldName("argument_list");
            const typeNode = argList?.namedChildren?.find((child) => child.type === "type_identifier") ?? null;
            if (typeNode) {
              tryResolveNode(context, typeNode, fromId, "instantiates");
            }
            return false;
          }
        }
        if (context.sup.id === "ruby" && node.type === "call") {
          const methodNode = node.childForFieldName("method");
          const receiverNode = node.childForFieldName("receiver");
          const methodName = methodNode ? sliceText(methodNode, context.source) : null;
          if (methodName === "new" && receiverNode) {
            tryResolveNode(context, receiverNode, fromId, "instantiates");
            return false;
          }
          if (methodNode) {
            resolveCallTarget(node, methodNode);
            return false;
          }
        }
        resolveCallTarget(node, getCallTarget(node));
      }
      if (newNodeTypes.has(node.type)) {
        const target = getNewTarget(node);
        if (target) tryResolveNode(context, target, fromId, "instantiates");
      }
      return true;
    };

    const walkFunctionBody = (node: SyntaxNodeLike, allowCallProcessing: boolean): void => {
      if (node !== fn.node && nestedFunctions.has(node)) return;
      recordAliasUse(node);
      recordMemberUse(node);
      const allowChildCallProcessing = allowCallProcessing ? recordCallOrInstantiation(node) : false;
      for (const child of node.namedChildren ?? []) walkFunctionBody(child, allowChildCallProcessing);
    };

    walkFunctionBody(fn.node, true);
  }
}

function recordIdentifierRelations(
  context: EdgePassContext,
  fromId: string,
  container: SyntaxNodeLike,
  relationForTarget: (target: SymbolDef, index: number) => "extends" | "implements" | "trait" | "mixin",
): void {
  const identifiers: SyntaxNodeLike[] = [];
  const collect = (node: SyntaxNodeLike): void => {
    if (isIdentifierType(context.sup, node.type) || node.type === "type_identifier") {
      identifiers.push(node);
      return;
    }
    for (const child of node.namedChildren ?? []) collect(child);
  };
  collect(container);
  const seen = new Set<string>();
  for (const [index, identifier] of identifiers.entries()) {
    const target = context.resolveIdentifier(sliceText(identifier, context.source));
    if (!target) continue;
    const targetId = defNodeId(target);
    if (seen.has(targetId)) continue;
    seen.add(targetId);
    recordDefEdge(context, fromId, target, relationForTarget(target, index), identifier);
  }
}

const RUBY_NESTED_SCOPE_TYPES = new Set(["class", "module", "method", "singleton_method", "block", "do_block"]);

/** Collects `call` nodes directly in a Ruby class/module body, not inside a nested class, module, method, or block. */
function collectDirectCallsExcludingNestedScopes(node: SyntaxNodeLike, out: SyntaxNodeLike[]): void {
  for (const child of node.namedChildren ?? []) {
    if (child.type === "call") out.push(child);
    if (RUBY_NESTED_SCOPE_TYPES.has(child.type)) continue;
    collectDirectCallsExcludingNestedScopes(child, out);
  }
}

export function emitClassInheritanceEdges(context: EdgePassContext, classNodes: DetailedClassNode[]): void {
  const interfaceIds = new Set(
    classNodes
      .filter(
        (candidate) =>
          candidate.node.type === "interface_declaration" ||
          candidate.node.type === "protocol_declaration" ||
          candidate.node.type === "trait_item" ||
          /^(?:interface|protocol|trait)\b/.test(sliceText(candidate.node, context.source).trimStart()),
      )
      .map((candidate) => defNodeId(candidate.def)),
  );

  for (const cls of classNodes) {
    const fromId = ensureNode(context, cls.def);
    markImplementationTarget(context, fromId, cls.node, cls.def);
    if (context.sup.id === "java") {
      const superClass = findFirstNodeByType(cls.node, "superclass");
      const superNode = superClass?.childForFieldName("name") ?? superClass?.namedChildren?.[0] ?? null;
      if (superNode) tryResolveNode(context, superNode, fromId, "extends");

      const interfaces = findFirstNodeByType(cls.node, "super_interfaces");
      if (interfaces) {
        const names: string[] = [];
        collectIdentifiers(interfaces, context.sup, context.source, names);
        for (const name of names) {
          const target = context.resolveIdentifier(name);
          if (target) recordDefEdge(context, fromId, target, "implements", interfaces);
        }
      }
      continue;
    }

    if (context.sup.id === "csharp") {
      const baseList = findFirstNodeByType(cls.node, "base_list");
      if (baseList) {
        recordIdentifierRelations(context, fromId, baseList, (target, index) =>
          interfaceIds.has(defNodeId(target)) || index > 0 ? "implements" : "extends",
        );
      }
      continue;
    }

    if (context.sup.id === "python") {
      const bases = cls.node.childForFieldName("superclasses") ?? findFirstNodeByType(cls.node, "argument_list");
      if (bases) recordIdentifierRelations(context, fromId, bases, () => "extends");
      continue;
    }

    if (context.sup.id === "php") {
      const base = findFirstNodeByType(cls.node, "base_clause");
      if (base) recordIdentifierRelations(context, fromId, base, () => "extends");

      const interfaces = findFirstNodeByType(cls.node, "class_interface_clause");
      if (interfaces) recordIdentifierRelations(context, fromId, interfaces, () => "implements");

      const traitUses: SyntaxNodeLike[] = [];
      collectNodesByType(cls.node, "use_declaration", traitUses);
      for (const traitUse of traitUses) recordIdentifierRelations(context, fromId, traitUse, () => "trait");
      continue;
    }

    if (context.sup.id === "ruby") {
      const superclass = findFirstNodeByType(cls.node, "superclass");
      if (superclass) recordIdentifierRelations(context, fromId, superclass, () => "extends");

      const calls: SyntaxNodeLike[] = [];
      collectDirectCallsExcludingNestedScopes(cls.node, calls);
      for (const call of calls) {
        if (call.childForFieldName("receiver")) continue;
        const methodNode = call.childForFieldName("method");
        const methodName = methodNode ? sliceText(methodNode, context.source) : undefined;
        if (methodName !== "include" && methodName !== "extend" && methodName !== "prepend") continue;
        const args = call.childForFieldName("arguments");
        if (args) recordIdentifierRelations(context, fromId, args, () => "mixin");
      }
      continue;
    }

    if (context.sup.id === "cpp") {
      const bases = findFirstNodeByType(cls.node, "base_class_clause");
      if (bases) recordIdentifierRelations(context, fromId, bases, () => "extends");
      continue;
    }

    if (context.sup.id === "kotlin") {
      const bases = findFirstNodeByType(cls.node, "delegation_specifiers");
      if (bases) {
        recordIdentifierRelations(context, fromId, bases, (target, index) =>
          interfaceIds.has(defNodeId(target)) || index > 0 ? "implements" : "extends",
        );
      }
      continue;
    }

    if (context.sup.id === "swift") {
      const bases: SyntaxNodeLike[] = [];
      collectNodesByType(cls.node, "inheritance_specifier", bases);
      for (const [index, base] of bases.entries()) {
        recordIdentifierRelations(context, fromId, base, (target) =>
          interfaceIds.has(defNodeId(target)) || index > 0 ? "implements" : "extends",
        );
      }
      continue;
    }

    const superClause = findFirstNodeByType(cls.node, "extends_clause");
    const superNode = superClause?.namedChildren?.[0] ?? superClause?.child(1);
    if (superNode) tryResolveNode(context, superNode, fromId, "extends");

    const implementsClauses: SyntaxNodeLike[] = [];
    collectNodesByType(cls.node, "implements_clause", implementsClauses);
    for (const clause of implementsClauses) {
      const names: string[] = [];
      collectIdentifiers(clause, context.sup, context.source, names);
      for (const name of names) {
        const target = context.resolveIdentifier(name);
        if (target) recordDefEdge(context, fromId, target, "implements", clause);
      }
    }
  }
}

export function emitRustImplEdges(context: EdgePassContext, rootNode: SyntaxNodeLike): void {
  if (context.sup.id !== "rust") return;

  const walkImpls = (node: SyntaxNodeLike): void => {
    if (node.type === "impl_item") {
      const typeIdentifiers = node.namedChildren?.filter((child) => child.type === "type_identifier") ?? [];
      if (typeIdentifiers.length >= 2) {
        const traitName = sliceText(typeIdentifiers[0], context.source);
        const typeName = sliceText(typeIdentifiers[1], context.source);
        const typeDef = context.resolveIdentifier(typeName);
        const traitDef = context.resolveIdentifier(traitName);
        if (typeDef && traitDef) {
          const fromId = ensureNode(context, typeDef);
          recordDefEdge(context, fromId, traitDef, "implements", node);
        }
      }
    }
    for (const child of node.namedChildren ?? []) walkImpls(child);
  };
  walkImpls(rootNode);
}

export function emitMemberImplementationEdges(
  graph: SymbolGraph,
  recordEdge: (fromId: string, toId: string, label?: string, site?: SymbolGraph["edges"][number]["site"]) => boolean,
): void {
  const membersByOwner = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.label !== "member_of") continue;
    const members = membersByOwner.get(edge.to) ?? [];
    members.push(edge.from);
    membersByOwner.set(edge.to, members);
  }
  const hierarchyByKey = new Map<string, SymbolGraph["edges"][number]>();
  for (const edge of graph.edges) {
    if (edge.label !== "extends" && edge.label !== "implements" && edge.label !== "trait" && edge.label !== "mixin")
      continue;
    const key = `${edge.from}->${edge.to}::${edge.label}`;
    const existing = hierarchyByKey.get(key);
    if (!existing || (!existing.site && edge.site)) hierarchyByKey.set(key, edge);
  }
  const hierarchyEdges = [...hierarchyByKey.values()];
  for (const hierarchyEdge of hierarchyEdges) {
    const parentMembers = membersByOwner.get(hierarchyEdge.to) ?? [];
    const childMembers = membersByOwner.get(hierarchyEdge.from) ?? [];
    for (const parentMemberId of parentMembers) {
      const parentMember = graph.nodes.get(parentMemberId);
      if (!parentMember) continue;
      if (parentMember.memberArity === undefined) continue;
      const parentIdentityMatches = parentMembers.filter((memberId) => {
        const candidate = graph.nodes.get(memberId);
        return candidate?.name === parentMember.name && candidate.memberArity === parentMember.memberArity;
      });
      if (parentIdentityMatches.length !== 1) continue;
      const isContractMember = hierarchyEdge.label !== "extends" || parentMember.implementationTarget;
      if (!isContractMember) continue;
      const compatibleMembers = childMembers.filter((memberId) => {
        const childMember = graph.nodes.get(memberId);
        return childMember?.name === parentMember.name && childMember.memberArity === parentMember.memberArity;
      });
      if (compatibleMembers.length !== 1) continue;
      recordEdge(
        compatibleMembers[0]!,
        parentMemberId,
        hierarchyEdge.label === "extends" ? "overrides" : "implements_member",
        hierarchyEdge.site,
      );
    }
  }
}
