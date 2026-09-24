import type { ModuleIndex, ProjectIndex, SymbolDef } from "../../indexer/types.js";
import { cppCallableShapeForNode, type CppCallableShape } from "../../indexer/cpp-callables.js";
import { resolveCppQualifiedMemberContainer } from "../../indexer/navigation-cpp.js";
import type { LanguageSupport } from "../../languages.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../../languages/types.js";
import { sliceText, toRange } from "../../util/ast.js";
import { getMemberAccessParts } from "../../util/member-access.js";
import { foldPhpIdentifierCase } from "../../util/identifiers.js";
import {
  MEMBER_ACCESS_ROWS,
  keywordReceiverKind,
  type ReceiverAncestorClause,
  type ReceiverAncestorEmbed,
  type ReceiverAncestryRelation,
} from "../../util/member-access-tables.js";
import { fileIdentityKey } from "../../util/paths.js";
import { defNodeId, nodeForDef, type SymbolGraph } from "../symbol-graph.js";
import type { DetailedClassNode, DetailedFunctionNode } from "./ast.js";
import { collectNodesByType, declarationMemberArity, findFirstNodeByType, isIdentifierType } from "./ast.js";
import {
  CALL_ARGUMENT_NODE_TYPES,
  callArgumentCount,
  classifyReceiver,
  declarationNodeIsStatic,
  cppOutOfLineOwnerPath,
  cppOutOfLineMemberDeclarationNode,
  cppQualifiedNameSegments,
  declaresMembers,
  isUnprovenHeritageExpression,
  nearestMemberContainer,
  receiverCallAccess,
  supportsReceiverMemberOverloads,
  type ReceiverCallAccess,
  type ReceiverCallCandidate,
  type ReceiverMemberScope,
  type MemberArityRange,
  type ReceiverProof,
} from "./receiver-calls.js";

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
  resolveIdentifier: (name: string, node: SyntaxNodeLike) => SymbolDef | null;
  resolveExportFrom: (file: string, exportedName: string) => SymbolDef | null;
  resolveMemberChainTarget: (chainNode: SyntaxNodeLike) => SymbolDef | null;
  recordEdge: (fromId: string, toId: string, label?: string, site?: SymbolGraph["edges"][number]["site"]) => boolean;
  /** Receiver calls whose target needs the completed graph; resolved after every module. */
  receiverCalls: ReceiverCallCandidate[];
  /** Proven static or instance scope for callable members, keyed by graph node id. */
  receiverMemberScopes: Map<string, ReceiverMemberScope>;
  /** Accepted argument-count range for C++ members, keyed by graph node id. */
  receiverMemberArities: Map<string, MemberArityRange>;
  /** Definition-node ids that collapse into their declaration-node id. */
  nodeAliases: Map<string, string>;
  /** Registers a name the detailed pass proved callable (function-valued bindings). */
  noteCallableName: (name: string, phpCaseInsensitive?: boolean) => void;
  /** Loads syntax needed to recover declaration metadata for cross-file member definitions. */
  loadParsedFile: (file: string) => Promise<{ source: string; tree: SyntaxTreeLike } | null>;
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
  declarationSource: string,
  def: SymbolDef,
): void {
  const declaration = sliceText(declarationNode, declarationSource);
  const nameIndex = declaration.indexOf(def.localName);
  const prefix = nameIndex >= 0 ? declaration.slice(0, nameIndex) : declaration;
  if (!/\b(?:abstract|virtual|override)\b/.test(prefix)) return;
  const node = context.nodes.get(id);
  if (node) node.implementationTarget = true;
}
function markMemberArity(context: EdgePassContext, id: string, declarationNode: SyntaxNodeLike): void {
  const arity = declarationMemberArity(declarationNode, context.sup.id);
  if (arity === undefined) return;
  const node = context.nodes.get(id);
  if (node) node.memberArity = arity;
}

function cppShapeNode(node: SyntaxNodeLike): SyntaxNodeLike {
  return node.type === "function_declarator" ? node : (findFirstNodeByType(node, "function_declarator") ?? node);
}

function mergeCppCallableShapes(...shapes: Array<CppCallableShape | null | undefined>): MemberArityRange | undefined {
  const present = shapes.filter((shape): shape is CppCallableShape => !!shape);
  if (!present.length) return undefined;
  let min = present[0]!.minArity;
  let max = present[0]!.maxArity;
  for (const shape of present.slice(1)) {
    min = Math.min(min, shape.minArity);
    if (max === null || shape.maxArity === null) max = null;
    else max = Math.max(max, shape.maxArity);
  }
  return { min, max };
}

function recordMemberLookupIdentity(
  context: EdgePassContext,
  definitionId: string,
  memberId: string,
  memberScope: ReceiverMemberScope,
  arityRange: MemberArityRange | undefined,
): void {
  context.receiverMemberScopes.set(definitionId, memberScope);
  if (memberId !== definitionId) context.receiverMemberScopes.set(memberId, memberScope);
  if (!arityRange) return;
  context.receiverMemberArities.set(definitionId, arityRange);
  if (memberId !== definitionId) context.receiverMemberArities.set(memberId, arityRange);
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
  if (
    isIdentifierType(context.sup, node.type) ||
    node.type === "type_identifier" ||
    (context.sup.id === "cpp" && (node.type === "operator_name" || node.type === "destructor_name"))
  ) {
    const name = sliceText(node, context.source);
    const target = context.resolveIdentifier(name, node);
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

/** Whether a function declaration can participate in class member lookup and ownership. */
function isClassMemberFunction(fn: DetailedFunctionNode): boolean {
  return fn.node.type !== "local_function_statement";
}

export async function emitMemberOwnershipEdges(
  context: EdgePassContext,
  functionNodes: DetailedFunctionNode[],
  classNodes: DetailedClassNode[],
): Promise<void> {
  for (const fn of functionNodes) {
    const owner = await memberOwner(context, fn, classNodes);
    if (!owner) continue;
    const outOfLineDeclaration = owner.cppOutOfLine
      ? await cppOutOfLineMemberDeclaration(context, fn, owner.def)
      : null;
    const definitionId = ensureNode(context, fn.def);
    let memberDef = fn.def;
    if (outOfLineDeclaration) {
      const declarationModule = context.index.byFile.get(fileIdentityKey(owner.def.file));
      const declarationDef = declarationModule?.locals.find(
        (candidate) =>
          candidate.localName === fn.def.localName &&
          candidate.kind === fn.def.kind &&
          candidate.range.start.index === outOfLineDeclaration.nameNode.startIndex &&
          candidate.range.end.index === outOfLineDeclaration.nameNode.endIndex,
      );
      if (declarationDef) memberDef = declarationDef;
    }
    const memberId = ensureNode(context, memberDef);
    if (definitionId !== memberId) context.nodeAliases.set(definitionId, memberId);
    markImplementationTarget(
      context,
      memberId,
      outOfLineDeclaration?.node ?? fn.node,
      outOfLineDeclaration?.source ?? context.source,
      fn.def,
    );
    const arityNode = outOfLineDeclaration?.node ?? fn.node;
    markMemberArity(context, definitionId, arityNode);
    if (memberId !== definitionId) markMemberArity(context, memberId, arityNode);
    const memberScope = memberScopeForDefinition(context, fn, owner.cppOutOfLine, outOfLineDeclaration);
    const arityRange =
      context.sup.id === "cpp"
        ? mergeCppCallableShapes(
            cppCallableShapeForNode(cppShapeNode(fn.node)),
            outOfLineDeclaration ? cppCallableShapeForNode(cppShapeNode(outOfLineDeclaration.node)) : undefined,
          )
        : undefined;
    recordMemberLookupIdentity(context, definitionId, memberId, memberScope, arityRange);
    recordDefEdge(context, definitionId, owner.def, "member_of");
  }
}

function memberScopeForDefinition(
  context: EdgePassContext,
  fn: DetailedFunctionNode,
  cppOutOfLine: boolean,
  outOfLineDeclaration: MemberDeclarationSource | null,
): ReceiverMemberScope {
  if (outOfLineDeclaration) {
    return declarationNodeIsStatic(outOfLineDeclaration.node, outOfLineDeclaration.source) ? "static" : "instance";
  }
  if (cppOutOfLine) return "any";
  const declarationNode =
    fn.node.parent?.type === "public_field_definition" || fn.node.parent?.type === "field_definition"
      ? fn.node.parent
      : fn.node;
  return declarationNodeIsStatic(declarationNode, context.source) ? "static" : "instance";
}

type MemberOwner = { def: SymbolDef; cppOutOfLine: boolean };

/** Lexical type body, named Go receiver type, or named C++ out-of-line owner. */
async function memberOwner(
  context: EdgePassContext,
  fn: DetailedFunctionNode,
  classNodes: DetailedClassNode[],
): Promise<MemberOwner | null> {
  if (!isClassMemberFunction(fn)) return null;
  if (context.sup.id === "go" && fn.node.type === "method_declaration") {
    const def = goMethodReceiverTypeDef(context, fn.node);
    return def ? { def, cppOutOfLine: false } : null;
  }
  const owners = classNodes
    .filter(
      (candidate) => candidate.node.startIndex <= fn.node.startIndex && candidate.node.endIndex >= fn.node.endIndex,
    )
    .sort((left, right) => left.node.endIndex - left.node.startIndex - (right.node.endIndex - right.node.startIndex));
  if (owners[0]?.def) return { def: owners[0].def, cppOutOfLine: false };
  if (context.sup.id === "cpp") {
    const ownerPath = cppOutOfLineOwnerPath(fn.node, context.source, context.sup);
    const def = ownerPath
      ? await resolveCppQualifiedMemberContainer(context.index, context.moduleEntry, ownerPath, context.loadParsedFile)
      : null;
    return def ? { def, cppOutOfLine: true } : null;
  }
  if (context.sup.id !== "zig") return null;
  const container = nearestMemberContainer(fn.node);
  if (container?.type !== "struct_declaration") return null;
  const name = container.parent?.namedChildren.find((child) => child.type === "identifier");
  const def = name ? resolveNamedType(context, sliceText(name, context.source), name) : null;
  return def ? { def, cppOutOfLine: false } : null;
}

type MemberDeclarationSource = { node: SyntaxNodeLike; nameNode: SyntaxNodeLike; source: string };

async function cppOutOfLineMemberDeclaration(
  context: EdgePassContext,
  fn: DetailedFunctionNode,
  ownerDef: SymbolDef,
): Promise<MemberDeclarationSource | null> {
  const parsed = await context.loadParsedFile(ownerDef.file);
  const startIndex = ownerDef.range.start.index;
  const endIndex = ownerDef.range.end.index;
  if (!parsed || startIndex === undefined || endIndex === undefined) return null;
  const ownerNameNode = parsed.tree.rootNode.descendantForIndex(startIndex, endIndex);
  const declaration = cppOutOfLineMemberDeclarationNode(
    fn.node,
    fn.def.localName,
    ownerNameNode,
    parsed.source,
    context.sup,
  );
  return declaration ? { node: declaration.node, nameNode: declaration.nameNode, source: parsed.source } : null;
}

/** Receiver type of `func (b *T) M()` / `func (b T) M()`, unwrapped through pointers. */
function goMethodReceiverTypeDef(context: EdgePassContext, methodNode: SyntaxNodeLike): SymbolDef | null {
  const receiver = methodNode.childForFieldName("receiver");
  const parameter =
    receiver?.namedChildren.find((child) => child.type === "parameter_declaration") ?? receiver?.namedChildren[0];
  const typeNode = parameter?.childForFieldName("type");
  const namedType = typeNode ? unwrapGoNamedType(typeNode) : null;
  if (!namedType) return null;
  const target = context.resolveIdentifier(sliceText(namedType, context.source), namedType);
  return target && declaresMembers(target) ? target : null;
}

/** Base type identifier of a Go receiver type, or null if it is not a named type. */
function unwrapGoNamedType(node: SyntaxNodeLike): SyntaxNodeLike | null {
  let current: SyntaxNodeLike | null = node;
  while (current) {
    if (current.type === "parenthesized_type" || current.type === "pointer_type") {
      current = current.namedChildren[0] ?? null;
      continue;
    }
    if (current.type === "generic_type") {
      current = current.childForFieldName("type") ?? current.namedChildren[0] ?? null;
      continue;
    }
    break;
  }
  return current?.type === "type_identifier" ? current : null;
}

/** Type-like defs only, so a PHP `use function` alias cannot steal `Example::m()`. */
function resolveNamedType(context: EdgePassContext, name: string, node: SyntaxNodeLike): SymbolDef | null {
  const target = context.resolveIdentifier(name, node);
  if (target && declaresMembers(target)) return target;
  // A parameter/annotation type name is a closer scope binding than the class it names.
  const normalized = context.sup.normalizeIdentifier(name);
  const typed = context.moduleEntry.locals.filter(
    (local) => context.sup.normalizeIdentifier(local.localName) === normalized && declaresMembers(local),
  );
  if (typed.length === 1) return typed[0]!;
  const imported = context.aliasToTargetDef.get(name);
  return imported && declaresMembers(imported) ? imported : null;
}

/**
 * Collection can attach an arrow to any same-name local when the binding site is
 * not that local (`obj.helper = () => 1` beside `const helper = 1`). Prove that
 * this function is the value of `fn.def` itself: the declarator name is that
 * definition, or an identifier assignment resolves to it. Member and pattern
 * left-hand sides do not prove a local binding.
 */
function provesCallableBinding(context: EdgePassContext, fn: DetailedFunctionNode): boolean {
  const parent = fn.node.parent;
  if (!parent) return false;
  const start = fn.def.range.start.index;
  const end = fn.def.range.end.index;
  if (start === undefined || end === undefined) return false;

  const sameNodeRange = (candidate: SyntaxNodeLike | null): boolean =>
    !!candidate && candidate.startIndex === fn.node.startIndex && candidate.endIndex === fn.node.endIndex;
  if (
    (parent.type === "variable_declarator" ||
      parent.type === "public_field_definition" ||
      parent.type === "field_definition") &&
    sameNodeRange(parent.childForFieldName("value"))
  ) {
    const bindingName = parent.childForFieldName("name") ?? parent.childForFieldName("property");
    return (
      !!bindingName &&
      (isIdentifierType(context.sup, bindingName.type) || context.propertyIdentifierTypes.includes(bindingName.type)) &&
      bindingName.startIndex === start &&
      bindingName.endIndex === end
    );
  }

  if (parent.type === "assignment_expression" && sameNodeRange(parent.childForFieldName("right"))) {
    const left = parent.childForFieldName("left");
    if (!left || !isIdentifierType(context.sup, left.type)) return false;
    const resolved = context.resolveIdentifier(sliceText(left, context.source), left);
    return !!resolved && defNodeId(resolved) === defNodeId(fn.def);
  }

  return false;
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
  // Receiver typing and lexical member lookup are initialized only for receiver calls.
  const receiverProofs = new Map<string, ReceiverProof>();
  let membersByContainer: Map<number, DetailedFunctionNode[]> | undefined;
  const lexicalMembers = (container: SyntaxNodeLike): DetailedFunctionNode[] => {
    if (!membersByContainer) {
      membersByContainer = new Map();
      for (const candidate of functionNodes) {
        if (!isClassMemberFunction(candidate)) continue;
        const owner = nearestMemberContainer(candidate.node);
        if (!owner) continue;
        const members = membersByContainer.get(owner.startIndex);
        if (members) members.push(candidate);
        else membersByContainer.set(owner.startIndex, [candidate]);
      }
    }
    return membersByContainer.get(container.startIndex) ?? [];
  };

  for (const fn of functionNodes) {
    const phpCaseInsensitive = context.sup.id === "php";
    const fromId = ensureNode(context, fn.def);
    const provenNode = context.nodes.get(fromId);
    // Function-valued bindings (`const helper = () => 1`) keep their `variable` kind;
    // the callable metadata records that this binding was proven to hold a function.
    if (provenNode && provenNode.kind !== "function" && provesCallableBinding(context, fn)) {
      provenNode.callable = true;
      context.noteCallableName(fn.name, context.sup.id === "php");
    }
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
      if (!memberName) return;
      const binding = classifyReceiver(
        context.sup,
        access.receiver,
        context.source,
        receiverProofs,
        fn.node.startIndex,
        access.accessNode,
      );
      if (!binding) return;

      const site = { file: context.moduleEntry.file, range: toRange(access.property) };
      const argumentCount = supportsReceiverMemberOverloads(context.sup.id)
        ? callArgumentCount(node, context.source)
        : null;
      if (binding.kind === "named-type") {
        const typeDef = resolveNamedType(context, binding.typeName, access.receiver);
        if (!typeDef) return;
        context.receiverCalls.push({
          callerId: fromId,
          ownerId: ensureNode(context, typeDef),
          viaSupertypes: false,
          memberName,
          argumentCount,
          site,
          memberScope: binding.memberScope,
          caseInsensitiveMemberName: phpCaseInsensitive,
        });
        return;
      }
      if (binding.kind === "own-type") {
        const container = nearestMemberContainer(fn.node);
        const declared = container
          ? lexicalMembers(container).filter((candidate) => {
              const candidateName = candidate.def.localName;
              const nameMatches = phpCaseInsensitive
                ? foldPhpIdentifierCase(candidateName) === foldPhpIdentifierCase(memberName)
                : candidateName === memberName;
              if (!nameMatches) return false;
              if (binding.memberScope === "any") return true;
              return declarationNodeIsStatic(candidate.node, context.source) === (binding.memberScope === "static");
            })
          : [];
        if (declared.length === 1) {
          recordDefEdge(context, fromId, declared[0]!.def, "calls", access.property);
        }
      }

      const receiverContainer = nearestMemberContainer(access.accessNode);
      const receiverContainerName = receiverContainer?.childForFieldName("name");
      const receiverOwnerDef = receiverContainerName
        ? context.moduleEntry.locals.find(
            (local) => local.range.start.index === receiverContainerName.startIndex && declaresMembers(local),
          )
        : undefined;

      context.receiverCalls.push({
        callerId: fromId,
        ownerId: receiverOwnerDef ? ensureNode(context, receiverOwnerDef) : null,
        viaSupertypes: binding.kind === "supertype",
        memberName,
        argumentCount,
        site,
        memberScope: binding.memberScope,
        caseInsensitiveMemberName: phpCaseInsensitive,
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
        const receiverName = sliceText(access.receiver, context.source);
        const typeScopedCppCall =
          context.sup.id === "cpp" &&
          context.source.slice(access.receiver.endIndex, access.property.startIndex).includes("::");
        if (typeScopedCppCall) {
          const qualifiedName = cppQualifiedNameSegments(access.accessNode, context.source).join("::");
          const qualifiedTarget = context.resolveIdentifier(qualifiedName, access.property);
          if (qualifiedTarget) {
            recordDefEdge(context, fromId, qualifiedTarget, "calls", access.property);
            return;
          }
        }
        if (
          keywordReceiverKind(context.sup.id, receiverName) ||
          typeScopedCppCall ||
          !tryResolveChain(context, access.accessNode, fromId, "calls")
        ) {
          recordReceiverCall(node, access);
        }
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

/** Qualifiers name a container, not another base type. */
const QUALIFIER_NAME_FIELD: Record<string, string> = {
  qualified_name: "name", // C#: Namespace.Base, Outer.Inner
  qualified_identifier: "name", // C++: ns::Base
  scope_resolution: "name", // Ruby: Module::Base
  qualified_type: "name", // Go: pkg.Base
};

/** Generic wrappers contribute the base name, not their type arguments. */
const GENERIC_WRAPPER_TYPES: Record<string, true> = {
  generic_name: true,
  generic_type: true,
  user_type: true,
  template_type: true,
};
const GENERIC_ARGUMENT_CHILD_TYPES: Record<string, true> = {
  type_argument_list: true, // C#: generic_name
  type_arguments: true, // Java/TypeScript generic_type, Kotlin/Swift user_type
  template_argument_list: true, // C++: template_type
  type_modifiers: true, // Kotlin/Swift user_type nullability/variance modifiers
};

/** Kotlin delegation-specifier forms that wrap the base type with call syntax. */
const CALL_LIKE_WRAPPER_SKIP_TYPES: Record<string, Record<string, true>> = {
  constructor_invocation: { value_arguments: true }, // Base(args)
  explicit_delegation: { primary_expression: true }, // Interface by delegate
};

/** Python base-list entries that are never base types. */
const BASE_TYPE_IGNORED_TYPES: Record<string, true> = {
  keyword_argument: true,
  dictionary_splat: true,
  list_splat: true,
};

/** Remove type arguments and wrapper syntax before resolving a direct base. */
function narrowBaseSpecifierNode(node: SyntaxNodeLike): SyntaxNodeLike {
  let current = node;
  for (;;) {
    const qualifierField = QUALIFIER_NAME_FIELD[current.type];
    if (qualifierField) {
      const named = current.childForFieldName(qualifierField);
      if (!named || named === current) return current;
      current = named;
      continue;
    }
    if (current.type === "scoped_type_identifier") {
      let named = current.childForFieldName("name");
      if (!named) {
        const parts = current.namedChildren ?? [];
        for (let index = parts.length - 1; index >= 0; index -= 1) {
          const part = parts[index]!;
          if (part.type !== "annotation" && part.type !== "marker_annotation") {
            named = part;
            break;
          }
        }
      }
      if (!named || named === current) return current;
      current = named;
      continue;
    }
    if (GENERIC_WRAPPER_TYPES[current.type]) {
      const named =
        current.childForFieldName("name") ??
        (current.namedChildren ?? []).find((child) => !GENERIC_ARGUMENT_CHILD_TYPES[child.type]);
      if (!named || named === current) return current;
      current = named;
      continue;
    }
    if (current.type === "subscript") {
      // Python `Base[Payload]` generic base: `value` names the base type.
      const value = current.childForFieldName("value");
      if (!value) return current;
      current = value;
      continue;
    }
    const callSkipTypes = CALL_LIKE_WRAPPER_SKIP_TYPES[current.type];
    if (callSkipTypes) {
      const named = (current.namedChildren ?? []).find((child) => !callSkipTypes[child.type]);
      if (!named) return current;
      current = named;
      continue;
    }
    return current;
  }
}

/** Collect one type identifier per direct base or interface specifier. */
function collectBaseSpecifierIdentifiers(node: SyntaxNodeLike, sup: LanguageSupport, out: SyntaxNodeLike[]): void {
  if (isUnprovenHeritageExpression(node)) return;
  if (BASE_TYPE_IGNORED_TYPES[node.type]) return;
  const narrowed = narrowBaseSpecifierNode(node);
  if (isIdentifierType(sup, narrowed.type) || narrowed.type === "type_identifier") {
    out.push(narrowed);
    return;
  }
  for (const child of narrowed.namedChildren ?? []) collectBaseSpecifierIdentifiers(child, sup, out);
}

function recordIdentifierRelations(
  context: EdgePassContext,
  fromId: string,
  container: SyntaxNodeLike,
  relationForTarget: (
    target: SymbolDef,
    index: number,
    identifier: SyntaxNodeLike,
  ) => "extends" | "implements" | "trait" | "mixin",
): void {
  const identifiers: SyntaxNodeLike[] = [];
  collectBaseSpecifierIdentifiers(container, context.sup, identifiers);
  const seen = new Set<string>();
  for (const [index, identifier] of identifiers.entries()) {
    const target = context.resolveIdentifier(sliceText(identifier, context.source), identifier);
    if (!target) continue;
    const targetId = defNodeId(target);
    if (seen.has(targetId)) continue;
    seen.add(targetId);
    recordDefEdge(context, fromId, target, relationForTarget(target, index, identifier), identifier);
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

type InheritanceRelation = ReceiverAncestryRelation;

function baseClauseRelation(
  label: ReceiverAncestorClause["relation"],
  target: SymbolDef,
  index: number,
  interfaceIds: Set<string>,
  identifier: SyntaxNodeLike,
  kotlin: boolean,
): InheritanceRelation {
  if (label !== "superclass-first") return label;
  if (kotlin) {
    let current = identifier.parent;
    while (current && current.type !== "delegation_specifiers") {
      if (current.type === "constructor_invocation") return "extends";
      current = current.parent;
    }
    return "implements";
  }
  if (interfaceIds.has(defNodeId(target)) || index > 0) return "implements";
  return "extends";
}

/** Records `implements` for every embedded type of a Go interface or struct declaration. */
function recordEmbedRelations(
  context: EdgePassContext,
  fromId: string,
  declaration: SyntaxNodeLike,
  embeds: readonly ReceiverAncestorEmbed[],
): void {
  const declaredType = declaration.childForFieldName("type");
  if (!declaredType) return;
  for (const rule of embeds) {
    if (declaredType.type !== rule.body) continue;
    const list = rule.memberList ? findFirstNodeByType(declaredType, rule.memberList) : declaredType;
    if (!list) continue;
    for (const member of list.namedChildren ?? []) {
      if (member.type !== rule.member) continue;
      if (rule.nameless && member.childForFieldName("name")) continue;
      const specifier = rule.typeField ? member.childForFieldName(rule.typeField) : member;
      if (!specifier) continue;
      recordIdentifierRelations(context, fromId, specifier, () => "implements");
    }
  }
}

export function emitClassInheritanceEdges(context: EdgePassContext, classNodes: DetailedClassNode[]): void {
  const rules = MEMBER_ACCESS_ROWS[context.sup.id]?.receiverAncestry;
  if (!rules) return;

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
    markImplementationTarget(context, fromId, cls.node, context.source, cls.def);

    for (const rule of rules.clauses) {
      const clauses: SyntaxNodeLike[] = [];
      if (rule.each) {
        collectNodesByType(cls.node, rule.nodeType, clauses);
      } else {
        const found = findFirstNodeByType(cls.node, rule.nodeType);
        if (found) clauses.push(found);
      }
      for (const clause of clauses) {
        const specifiers = rule.field ? (clause.childForFieldName(rule.field) ?? clause) : clause;
        recordIdentifierRelations(context, fromId, specifiers, (target, index, identifier) =>
          baseClauseRelation(rule.relation, target, index, interfaceIds, identifier, context.sup.id === "kotlin"),
        );
      }
    }

    if (rules.mixinCalls) {
      const calls: SyntaxNodeLike[] = [];
      collectDirectCallsExcludingNestedScopes(cls.node, calls);
      for (const call of calls) {
        if (call.childForFieldName("receiver")) continue;
        const methodNode = call.childForFieldName("method");
        const methodName = methodNode ? sliceText(methodNode, context.source) : undefined;
        if (!methodName || !rules.mixinCalls.includes(methodName)) continue;
        const args = call.childForFieldName("arguments");
        if (args) recordIdentifierRelations(context, fromId, args, () => "mixin");
      }
    }

    if (rules.embeds) recordEmbedRelations(context, fromId, cls.node, rules.embeds);
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
        const typeDef = context.resolveIdentifier(typeName, typeIdentifiers[1]!);
        const traitDef = context.resolveIdentifier(traitName, typeIdentifiers[0]!);
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
