import type { ModuleIndex, ProjectIndex, SymbolDef } from "../../indexer/types.js";
import type { LanguageSupport } from "../../languages.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import { sliceText, toRange } from "../../util/ast.js";
import { getMemberAccessParts } from "../../util/memberAccess.js";
import { defNodeId, nodeForDef, type SymbolGraph } from "../symbol-graph.js";
import type { DetailedClassNode, DetailedFunctionNode } from "./ast.js";
import { collectIdentifiers, collectNodesByType, findFirstNodeByType, isIdentifierType } from "./ast.js";

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
  recordEdge: (
    fromId: string,
    toId: string,
    label?: string,
    site?: SymbolGraph["edges"][number]["site"],
  ) => boolean;
};

function ensureNode(context: EdgePassContext, def: SymbolDef): string {
  const id = defNodeId(def);
  if (!context.nodes.has(id)) context.nodes.set(id, nodeForDef(def));
  return id;
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

function tryResolveNode(context: EdgePassContext, node: SyntaxNodeLike, fromId: string, label: string): void {
  if (isIdentifierType(context.sup, node.type) || node.type === "type_identifier") {
    const name = sliceText(node, context.source);
    const target = context.resolveIdentifier(name);
    if (target) {
      recordDefEdge(context, fromId, target, label, node);
      return;
    }
  }
  if (context.optionalMemberTypes.has(node.type)) {
    tryResolveChain(context, node, fromId, label);
  }
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
  const nonArgumentChildren = node.namedChildren.filter((child) => child.type !== "argument_list");
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
        (candidate) =>
          candidate.node.startIndex <= fn.node.startIndex &&
          candidate.node.endIndex >= fn.node.endIndex,
      )
      .sort(
        (left, right) =>
          left.node.endIndex -
          left.node.startIndex -
          (right.node.endIndex - right.node.startIndex),
      );
    const owner = owners[0];
    if (!owner) continue;
    recordDefEdge(context, ensureNode(context, fn.def), owner.def, "member_of");
  }
}

export function emitFunctionBodyEdges(context: EdgePassContext, functionNodes: DetailedFunctionNode[]): void {
  const callNodeTypes = new Set<string>(["call_expression", "call", "method_invocation", "invocation_expression"]);
  const newNodeTypes = new Set<string>([
    "new_expression",
    "object_creation_expression",
    "struct_expression",
    "composite_literal",
  ]);

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
              const targetModule = context.index.byFile.get(modFile);
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
            tryResolveNode(context, methodNode, fromId, "calls");
            return false;
          }
        }
        const callee = getCallTarget(node);
        if (callee) tryResolveNode(context, callee, fromId, "calls");
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
  relationForTarget: (target: SymbolDef, index: number) => "extends" | "implements",
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
          if (target) recordDefEdge(context, fromId, target, "implements");
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
        if (target) recordDefEdge(context, fromId, target, "implements");
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
          recordDefEdge(context, fromId, traitDef, "implements");
        }
      }
    }
    for (const child of node.namedChildren ?? []) walkImpls(child);
  };
  walkImpls(rootNode);
}
