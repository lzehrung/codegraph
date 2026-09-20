import type { LanguageSupport } from "../languages.js";
import { isJsTsLanguage } from "../languages/js-family.js";
import { isPythonReceiverAttributeAssignmentName } from "../languages/definitions/python.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import { sliceText } from "../util/ast.js";
import { fileIdentityKey } from "../util/paths.js";
import {
  getMemberAccessParts,
  getNavigationExpressionProperty,
  isMemberAccessNode,
  isReceiverNameNode,
  memberAccessTraversalTypes,
} from "../util/member-access.js";
import {
  declaresMembers,
  hasStaticMemberDistinction,
  isKeywordReceiver,
  nearestMemberContainer,
  receiverConstructorExpression,
  supportsReceiverMemberNavigation,
  unwrapNamedType,
  type ReceiverMemberScope,
} from "../graphs/symbol-graph-detailed/receiver-calls.js";
import { ensureParsedContext, type ParsedFileContext } from "./parse-context.js";
import { okGoToResult } from "./navigation-provenance.js";
import { resolveExport, resolveImported } from "./navigation-resolve.js";
import {
  SymbolKind,
  type GoToResult,
  type ModuleIndex,
  type ProjectIndex,
  type ResolvedExport,
  type SymbolDef,
} from "./types.js";

export async function resolveMemberAccessDefinition(params: {
  index: ProjectIndex;
  mod: ModuleIndex;
  node: SyntaxNodeLike;
  source: string;
  sup: LanguageSupport;
  resolveLexicalBinding?: (expression: SyntaxNodeLike) => SymbolDef | null;
}): Promise<GoToResult | null> {
  const { index, mod, node, source, sup, resolveLexicalBinding } = params;
  const parent = node.parent;
  if (!parent || !sup.supportsCrossModuleSymbols) {
    return null;
  }
  let memberNode: SyntaxNodeLike | null = null;
  if (isMemberAccessNode(sup, parent)) {
    memberNode = parent;
  } else if (parent.parent && isMemberAccessNode(sup, parent.parent)) {
    memberNode = parent.parent;
  }
  if (!memberNode) return null;
  const { object: obj, property: prop } = getMemberAccessParts(sup, memberNode);
  const optionalMemberTypes = memberAccessTraversalTypes(sup);

  const resolveExpression = async (expr: SyntaxNodeLike): Promise<ResolvedExport | null> => {
    const exprIsId = isReceiverNameNode(sup, expr.type) && !isMemberAccessNode(sup, expr);
    if (exprIsId) {
      const lexicalBinding = resolveLexicalBinding?.(expr);
      if (lexicalBinding) return { kind: "resolved", def: lexicalBinding };
      const exprName = sliceText(expr, source);
      const imp = mod.imports.find(
        (candidate) =>
          (candidate.kind === "named" && candidate.local === exprName) ||
          (candidate.kind === "default" && candidate.local === exprName) ||
          (candidate.kind === "namespace" && candidate.localNS === exprName),
      );
      if (imp) {
        if (imp.kind === "namespace") {
          return {
            kind: "namespace",
            file: typeof imp.resolved === "string" ? imp.resolved.replace(/\\/g, "/") : imp.resolved?.external || "",
          };
        }
        const result = resolveImported(index, imp, imp.kind === "named" ? imp.imported : "default");
        if (result) {
          if ("namespace" in result) {
            return { kind: "namespace", file: result.namespace };
          }
          return { kind: "resolved", def: result };
        }
      }

      const local = mod.locals.find((candidate) => candidate.localName === exprName);
      if (local) return { kind: "resolved", def: local };

      for (const starImport of mod.imports.filter((candidate) => candidate.kind === "star")) {
        const result = resolveImported(index, starImport, exprName);
        if (result) {
          if ("namespace" in result) {
            return { kind: "namespace", file: result.namespace };
          }
          return { kind: "resolved", def: result };
        }
      }
      return null;
    }

    if (optionalMemberTypes.has(expr.type)) {
      const parts = getMemberAccessParts(sup, expr);
      const subObj = parts.object;
      let subProp = parts.property;
      if (!subProp && expr.type === "navigation_expression") {
        subProp = getNavigationExpressionProperty(sup, expr);
      }
      if (subObj && subProp) {
        const base = await resolveExpression(subObj);
        const memberName = sliceText(subProp, source);
        if (base?.kind === "namespace") {
          return resolveExport(index, base.file, memberName, { allowLocalFallback: false });
        }
        if (base?.kind === "resolved") {
          if (sup.id === "java") {
            const memberDef = await resolveMemberDefinitionForBase(index, base.def, memberName);
            return memberDef ? { kind: "resolved", def: memberDef } : null;
          }
          if (sup.id === "ruby") {
            const memberDef = await resolveMemberDefinitionForBase(index, base.def, memberName);
            if (memberDef) return { kind: "resolved", def: memberDef };
            const localHit = resolveExport(index, base.def.file, memberName);
            if (localHit) return localHit;
          }
          return null;
        }
      }
    }

    if (sup.id === "java" && (expr.type === "scoped_identifier" || expr.type === "scoped_type_identifier")) {
      const subObj = expr.childForFieldName("scope") ?? expr.child(0);
      const subProp = expr.childForFieldName("name") ?? expr.child(2);
      if (subObj && subProp) {
        const base = await resolveExpression(subObj);
        const memberName = sliceText(subProp, source);
        if (base?.kind === "namespace") {
          return resolveExport(index, base.file, memberName, { allowLocalFallback: false });
        }
        if (base?.kind === "resolved") {
          const memberDef = await resolveMemberDefinitionForBase(index, base.def, memberName);
          return memberDef ? { kind: "resolved", def: memberDef } : null;
        }
      }
    }

    return null;
  };

  const chain = await resolveExpression(memberNode);
  if (chain && prop && node.id === prop.id) {
    if (chain.kind === "resolved") {
      return okGoToResult(index, chain.def, {
        via: { exportedName: sliceText(prop, source) },
        resolution: "member-access",
        confidence: "medium",
      });
    }
    if (chain.kind === "namespace") {
      const targetMod = index.byFile.get(fileIdentityKey(chain.file));
      const first = targetMod?.exports.find((entry) => entry.type === "local");
      if (first) {
        return okGoToResult(index, first.target, {
          via: { exportedName: first.exportedAs },
          resolution: "namespace",
          confidence: "medium",
        });
      }
    }
  }

  const receiverName = obj ? sliceText(obj, source) : "";
  const implicitClassReceiver = isKeywordReceiver(sup.id, receiverName);
  if (obj && prop && node.id === prop.id && (supportsReceiverMemberNavigation(sup.id) || implicitClassReceiver)) {
    const member = sliceText(prop, source);
    if (sup.id === "python") {
      const memberDef = await resolvePythonReceiverMember(
        index,
        mod,
        node,
        obj,
        member,
        source,
        sup,
        resolveExpression,
      );
      if (!memberDef) return null;
      return okGoToResult(index, memberDef, {
        via: { exportedName: member },
        resolution: "member-access",
        confidence: "medium",
      });
    }
    if (!sup.membersAreImplicitlyInScope && implicitClassReceiver) {
      const classContainer = findEnclosingClassContainer(node);
      const memberDef = classContainer
        ? findLocalWithinNode(mod.locals, member, classContainer, sup.normalizeIdentifier)
        : undefined;
      if (memberDef) {
        return okGoToResult(index, memberDef, {
          via: { exportedName: member },
          resolution: "member-access",
          confidence: "medium",
        });
      }
    }

    const receiver = await resolveReceiverDefinition(obj, source, sup, resolveExpression, mod);

    if (receiver) {
      const objDef = receiver.def;
      const targetContext = await ensureParsedContext(objDef.file, undefined, index.languageExtensions);
      const start = objDef.range.start;
      const targetPosition = {
        row: start.line - 1,
        column: start.column - 1,
      };
      const nameNode = targetContext.tree.rootNode.descendantForPosition(targetPosition, targetPosition);
      const container = nameNode.parent;
      if (
        receiver.runtimeTypeOnly &&
        container &&
        container.type !== "enum_declaration" &&
        container.type !== "internal_module" &&
        container.type !== "module"
      ) {
        return null;
      }
      if (container) {
        const targetModule = index.byFile.get(fileIdentityKey(objDef.file));
        if (targetModule) {
          const normalizeIdentifier = targetContext.sup.normalizeIdentifier;
          const memberPredicate =
            receiver.memberScope === "any"
              ? undefined
              : (local: SymbolDef) =>
                  matchesReceiverMemberScope(local, receiver.memberScope, targetContext, container);
          let memberDef: SymbolDef | undefined;
          if (receiver.runtimeTypeOnly || targetContext.sup.id === "java") {
            memberDef = findDirectLocalWithinNode(
              targetModule.locals,
              member,
              container,
              targetContext,
              normalizeIdentifier,
              memberPredicate,
            );
          } else {
            memberDef = findReceiverMemberDefinition(
              targetModule.locals,
              member,
              objDef,
              container,
              targetContext,
              normalizeIdentifier,
              receiver.memberScope,
            );
          }

          if (memberDef) {
            return okGoToResult(index, memberDef, {
              via: { exportedName: member },
              resolution: "member-access",
              confidence: "medium",
            });
          }
        }
      }
    }
  }

  return null;
}

function findEnclosingClassContainer(node: SyntaxNodeLike): SyntaxNodeLike | null {
  return nearestMemberContainer(node);
}

export {
  supportsReceiverCallEdges,
  supportsReceiverMemberNavigation,
} from "../graphs/symbol-graph-detailed/receiver-calls.js";

type ResolvedReceiverDefinition = {
  def: SymbolDef;
  memberScope: ReceiverMemberScope;
  runtimeTypeOnly?: true;
};

function memberDeclaringLocals(mod: ModuleIndex, typeName: string, normalize: (name: string) => string): SymbolDef[] {
  const normalized = normalize(typeName);
  return mod.locals.filter((local) => normalize(local.localName) === normalized && declaresMembers(local));
}

async function resolveReceiverDefinition(
  obj: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
  resolveExpression: (expr: SyntaxNodeLike) => Promise<ResolvedExport | null>,
  mod: ModuleIndex,
): Promise<ResolvedReceiverDefinition | null> {
  const constructor = receiverConstructorExpression(obj, source, sup);
  if (constructor) {
    const typeName = sliceText(constructor, source);
    const typedLocals = memberDeclaringLocals(mod, typeName, sup.normalizeIdentifier);
    if (typedLocals.length === 1) {
      return {
        def: typedLocals[0]!,
        memberScope: hasStaticMemberDistinction(sup.id) ? "instance" : "any",
      };
    }
    const result = await resolveExpression(constructor);
    if (result?.kind === "resolved" && declaresMembers(result.def)) {
      return {
        def: result.def,
        memberScope: hasStaticMemberDistinction(sup.id) ? "instance" : "any",
      };
    }
    if (typedLocals[0]) {
      return {
        def: typedLocals[0],
        memberScope: hasStaticMemberDistinction(sup.id) ? "instance" : "any",
      };
    }
  }
  const direct = await resolveExpression(obj);
  if (direct?.kind === "resolved" && declaresMembers(direct.def)) {
    if (isJsTsLanguage(sup.id) && direct.def.kind === SymbolKind.TypeAlias) {
      return { def: direct.def, memberScope: "any", runtimeTypeOnly: true };
    }
    const memberScope = hasStaticMemberDistinction(sup.id) ? "static" : "any";
    return { def: direct.def, memberScope };
  }
  if (isJsTsLanguage(sup.id) && isReceiverNameNode(sup, obj.type)) {
    return null;
  }
  if (direct?.kind === "resolved") {
    return { def: direct.def, memberScope: "any" };
  }
  return null;
}

async function resolveMemberDefinitionForBase(
  index: ProjectIndex,
  baseDef: SymbolDef,
  member: string,
): Promise<SymbolDef | undefined> {
  const targetContext = await ensureParsedContext(baseDef.file, undefined, index.languageExtensions);
  const start = baseDef.range.start;
  const targetPosition = {
    row: start.line - 1,
    column: start.column - 1,
  };
  const nameNode = targetContext.tree.rootNode.descendantForPosition(targetPosition, targetPosition);
  const container = nameNode.parent;
  if (!container) return undefined;
  const targetModule = index.byFile.get(fileIdentityKey(baseDef.file));
  if (!targetModule) return undefined;
  const normalizeIdentifier = targetContext.sup.normalizeIdentifier;
  const directHit = findDirectLocalWithinNode(
    targetModule.locals,
    member,
    container,
    targetContext,
    normalizeIdentifier,
  );
  if (directHit) return directHit;
  if (targetContext.sup.id === "java") return undefined;
  return findReceiverMemberDefinition(
    targetModule.locals,
    member,
    baseDef,
    container,
    targetContext,
    normalizeIdentifier,
  );
}

function findReceiverMemberDefinition(
  locals: readonly SymbolDef[],
  member: string,
  receiverDef: SymbolDef,
  container: SyntaxNodeLike,
  targetContext: ParsedFileContext,
  normalizeIdentifier: (name: string) => string,
  memberScope: ReceiverMemberScope = "any",
): SymbolDef | undefined {
  const memberPredicate =
    memberScope === "any"
      ? undefined
      : (local: SymbolDef) => matchesReceiverMemberScope(local, memberScope, targetContext, container);
  const containerHit =
    memberScope === "any"
      ? findLocalWithinNode(locals, member, container, normalizeIdentifier)
      : findDirectLocalWithinNode(locals, member, container, targetContext, normalizeIdentifier, memberPredicate);
  if (containerHit) return containerHit;
  if (targetContext.sup.id === "rust") {
    const implNode = findRustImplForType(targetContext.tree.rootNode, receiverDef.localName, targetContext.source);
    return implNode ? findLocalWithinNode(locals, member, implNode, normalizeIdentifier) : undefined;
  }
  if (targetContext.sup.id === "go") {
    return findGoReceiverMember(locals, member, receiverDef.localName, targetContext, normalizeIdentifier);
  }
  return undefined;
}

function findLocalWithinNode(
  locals: readonly SymbolDef[],
  member: string,
  node: SyntaxNodeLike,
  normalizeIdentifier: (name: string) => string = (name) => name,
  predicate?: (local: SymbolDef) => boolean,
): SymbolDef | undefined {
  const containerStart = node.startIndex;
  const containerEnd = node.endIndex;
  const normalizedMember = normalizeIdentifier(member);
  return locals.find((local) => {
    const startIndex = local.range.start.index;
    const endIndex = local.range.end.index;
    return (
      normalizeIdentifier(local.localName) === normalizedMember &&
      startIndex !== undefined &&
      endIndex !== undefined &&
      startIndex >= containerStart &&
      endIndex <= containerEnd &&
      (!predicate || predicate(local))
    );
  });
}
function matchesReceiverMemberScope(
  local: SymbolDef,
  memberScope: ReceiverMemberScope,
  targetContext: ParsedFileContext,
  container: SyntaxNodeLike,
): boolean {
  if (memberScope === "any") return true;
  return hasStaticModifier(local, targetContext, container) === (memberScope === "static");
}

function nodeDeclaresStatic(node: SyntaxNodeLike, source: string): boolean {
  if (node.type === "static" || node.type === "static_modifier") return true;
  if (node.type === "storage_class_specifier" || node.type === "modifier" || node.type === "property_modifier") {
    return sliceText(node, source).trim() === "static";
  }
  if (node.type === "modifiers") {
    for (let childIndex = 0; ; childIndex += 1) {
      const child = node.child(childIndex);
      if (!child) break;
      if (nodeDeclaresStatic(child, source)) return true;
    }
  }
  return false;
}

function hasStaticModifier(local: SymbolDef, targetContext: ParsedFileContext, container: SyntaxNodeLike): boolean {
  const position = {
    row: local.range.start.line - 1,
    column: local.range.start.column - 1,
  };
  let current: SyntaxNodeLike | null = targetContext.tree.rootNode.descendantForPosition(position, position);
  while (current && current !== container) {
    for (let childIndex = 0; ; childIndex += 1) {
      const child = current.child(childIndex);
      if (!child) break;
      if (nodeDeclaresStatic(child, targetContext.source)) return true;
    }
    current = current.parent;
  }
  return false;
}

const NESTED_MEMBER_LOCAL_CONTAINERS = new Set([
  "block",
  "class",
  "class_declaration",
  "class_definition",
  "constructor_declaration",
  "enum_declaration",
  "enum_item",
  "enum_specifier",
  "function_declaration",
  "function_definition",
  "function_item",
  "interface_declaration",
  "method",
  "method_declaration",
  "method_definition",
  "module",
  "statement_block",
]);

function findDirectLocalWithinNode(
  locals: readonly SymbolDef[],
  member: string,
  container: SyntaxNodeLike,
  targetContext: ParsedFileContext,
  normalizeIdentifier: (name: string) => string,
  predicate?: (local: SymbolDef) => boolean,
): SymbolDef | undefined {
  const containerStart = container.startIndex;
  const containerEnd = container.endIndex;
  const normalizedMember = normalizeIdentifier(member);
  for (const local of locals) {
    const startIndex = local.range.start.index;
    const endIndex = local.range.end.index;
    if (
      normalizeIdentifier(local.localName) !== normalizedMember ||
      startIndex === undefined ||
      endIndex === undefined ||
      startIndex < containerStart ||
      endIndex > containerEnd
    ) {
      continue;
    }
    const start = local.range.start;
    const position = {
      row: start.line - 1,
      column: start.column - 1,
    };
    let current = targetContext.tree.rootNode.descendantForPosition(position, position).parent;
    let isDeclarationParent = true;
    while (current && current !== container) {
      const isDirectBody =
        (current.type === "statement_block" || current.type === "block") && current.parent === container;
      if (
        !isDeclarationParent &&
        !isDirectBody &&
        ((current.type === "class_body" && current.parent !== container) ||
          NESTED_MEMBER_LOCAL_CONTAINERS.has(current.type))
      ) {
        current = null;
        break;
      }
      isDeclarationParent = false;
      current = current.parent;
    }
    if (current && (!predicate || predicate(local))) return local;
  }
  return undefined;
}

function findRustImplForType(root: SyntaxNodeLike, typeName: string, source: string): SyntaxNodeLike | null {
  let found: SyntaxNodeLike | null = null;
  const visit = (node: SyntaxNodeLike): boolean => {
    if (node.type === "impl_item") {
      const text = sliceText(node, source);
      if (new RegExp(`^\\s*impl\\s+${escapeRegExp(typeName)}\\b`).test(text)) {
        found = node;
        return false;
      }
    }
    for (const child of node.namedChildren) {
      if (!visit(child)) return false;
    }
    return true;
  };
  visit(root);
  return found;
}

const GO_EMBED_DEPTH = 16;

function goMethodReceiverTypeName(
  methodNode: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
): string | null {
  const receiver = methodNode.childForFieldName("receiver");
  if (!receiver) return null;
  const parameter =
    receiver.namedChildren.find((child) => child.type === "parameter_declaration") ??
    receiver.namedChildren[0] ??
    null;
  const typeNode = parameter?.childForFieldName("type") ?? null;
  if (!typeNode) return null;
  const named = unwrapNamedType(typeNode, sup);
  return named ? sliceText(named, source) : null;
}

function goTypeSpecNamed(
  root: SyntaxNodeLike,
  typeName: string,
  source: string,
  normalizeIdentifier: (name: string) => string,
): SyntaxNodeLike | null {
  const normalized = normalizeIdentifier(typeName);
  let found: SyntaxNodeLike | null = null;
  const visit = (node: SyntaxNodeLike): boolean => {
    if (node.type === "type_spec") {
      const name = node.childForFieldName("name");
      if (name && normalizeIdentifier(sliceText(name, source)) === normalized) {
        found = node;
        return false;
      }
    }
    for (const child of node.namedChildren) {
      if (!visit(child)) return false;
    }
    return true;
  };
  visit(root);
  return found;
}

function goEmbeddedTypeNames(
  typeName: string,
  targetContext: ParsedFileContext,
  normalizeIdentifier: (name: string) => string,
): string[] {
  const spec = goTypeSpecNamed(
    targetContext.tree.rootNode,
    typeName,
    targetContext.source,
    normalizeIdentifier,
  );
  if (!spec) return [];
  const typeNode = spec.childForFieldName("type");
  if (!typeNode) return [];
  const names: string[] = [];
  const visit = (node: SyntaxNodeLike): void => {
    if (node.type === "field_declaration") {
      if (node.childForFieldName("name")) return;
      const fieldType = node.childForFieldName("type");
      const named = fieldType ? unwrapNamedType(fieldType, targetContext.sup) : null;
      if (named) names.push(sliceText(named, targetContext.source));
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(typeNode);
  return names;
}

function goMethodsNamedOnType(
  locals: readonly SymbolDef[],
  member: string,
  typeName: string,
  targetContext: ParsedFileContext,
  normalizeIdentifier: (name: string) => string,
): SymbolDef[] {
  const matches: SymbolDef[] = [];
  const visit = (node: SyntaxNodeLike): void => {
    if (node.type === "method_declaration") {
      const receiverType = goMethodReceiverTypeName(node, targetContext.source, targetContext.sup);
      if (receiverType && normalizeIdentifier(receiverType) === normalizeIdentifier(typeName)) {
        const local = findLocalWithinNode(locals, member, node, normalizeIdentifier);
        if (local && !matches.includes(local)) matches.push(local);
      }
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(targetContext.tree.rootNode);
  return matches;
}

function findGoReceiverMember(
  locals: readonly SymbolDef[],
  member: string,
  typeName: string,
  targetContext: ParsedFileContext,
  normalizeIdentifier: (name: string) => string,
): SymbolDef | undefined {
  const visited = new Set<string>();
  let level = [typeName];
  for (let depth = 0; depth < GO_EMBED_DEPTH && level.length; depth += 1) {
    const matches: SymbolDef[] = [];
    const next: string[] = [];
    for (const currentType of level) {
      if (visited.has(currentType)) continue;
      visited.add(currentType);
      for (const method of goMethodsNamedOnType(
        locals,
        member,
        currentType,
        targetContext,
        normalizeIdentifier,
      )) {
        if (!matches.includes(method)) matches.push(method);
      }
      for (const embedded of goEmbeddedTypeNames(currentType, targetContext, normalizeIdentifier)) {
        if (!visited.has(embedded) && !next.includes(embedded)) next.push(embedded);
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
    level = next;
  }
  return undefined;
}

const PYTHON_SUPERTYPE_DEPTH = 16;

type PythonClassRef = {
  def: SymbolDef;
  container: SyntaxNodeLike;
  context: ParsedFileContext;
  module: ModuleIndex;
};

function pythonClassKey(def: SymbolDef): string {
  const start = def.range.start;
  return `${fileIdentityKey(def.file)}:${start.index ?? `${start.line}:${start.column}`}`;
}

async function resolvePythonReceiverMember(
  index: ProjectIndex,
  mod: ModuleIndex,
  node: SyntaxNodeLike,
  obj: SyntaxNodeLike,
  member: string,
  source: string,
  sup: LanguageSupport,
  resolveExpression: (expr: SyntaxNodeLike) => Promise<ResolvedExport | null>,
): Promise<SymbolDef | undefined> {
  const classRef = await pythonReceiverClassRef(index, mod, node, obj, source, sup, resolveExpression);
  if (!classRef) return undefined;
  return lookupPythonClassMember(index, classRef, member);
}

async function pythonReceiverClassRef(
  index: ProjectIndex,
  mod: ModuleIndex,
  node: SyntaxNodeLike,
  obj: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
  resolveExpression: (expr: SyntaxNodeLike) => Promise<ResolvedExport | null>,
): Promise<PythonClassRef | null> {
  const receiverName = sliceText(obj, source);
  if (receiverName === "self" || receiverName === "cls") {
    const container = findEnclosingClassContainer(node);
    if (!container) return null;
    const nameNode = container.childForFieldName("name");
    if (!nameNode) return null;
    const className = sliceText(nameNode, source);
    const def = mod.locals.find((local) => {
      const startIndex = local.range.start.index;
      const endIndex = local.range.end.index;
      return (
        local.kind === SymbolKind.Class &&
        local.localName === className &&
        startIndex !== undefined &&
        endIndex !== undefined &&
        startIndex >= container.startIndex &&
        endIndex <= container.endIndex
      );
    });
    if (!def) return null;
    return pythonClassRefFromDef(index, def);
  }

  let classDef: SymbolDef | undefined;
  const constructor = receiverConstructorExpression(obj, source, sup);
  if (constructor) {
    const result = await resolveExpression(constructor);
    if (result?.kind === "resolved" && result.def.kind === SymbolKind.Class) {
      classDef = result.def;
    }
  }
  if (!classDef) {
    const direct = await resolveExpression(obj);
    if (direct?.kind === "resolved" && direct.def.kind === SymbolKind.Class) {
      classDef = direct.def;
    }
  }
  if (!classDef) return null;
  return pythonClassRefFromDef(index, classDef);
}

async function pythonClassRefFromDef(index: ProjectIndex, def: SymbolDef): Promise<PythonClassRef | null> {
  const module = index.byFile.get(fileIdentityKey(def.file));
  if (!module) return null;
  const context = await ensureParsedContext(def.file, undefined, index.languageExtensions);
  const start = def.range.start;
  const position = {
    row: start.line - 1,
    column: start.column - 1,
  };
  let current: SyntaxNodeLike | null = context.tree.rootNode.descendantForPosition(position, position);
  while (current && current.type !== "class_definition") {
    current = current.parent;
  }
  if (!current) return null;
  return { def, container: current, context, module };
}

function pythonMembersOnClass(classRef: PythonClassRef, member: string): SymbolDef[] {
  const normalizeIdentifier = classRef.context.sup.normalizeIdentifier;
  const direct = findDirectLocalWithinNode(
    classRef.module.locals,
    member,
    classRef.container,
    classRef.context,
    normalizeIdentifier,
  );
  if (direct) return [direct];
  const attribute = findPythonInstanceAttributeWithinClass(
    classRef.module.locals,
    member,
    classRef.container,
    classRef.context,
    normalizeIdentifier,
  );
  return attribute ? [attribute] : [];
}

function findPythonInstanceAttributeWithinClass(
  locals: readonly SymbolDef[],
  member: string,
  container: SyntaxNodeLike,
  targetContext: ParsedFileContext,
  normalizeIdentifier: (name: string) => string,
): SymbolDef | undefined {
  const containerStart = container.startIndex;
  const containerEnd = container.endIndex;
  const normalizedMember = normalizeIdentifier(member);
  for (const local of locals) {
    const startIndex = local.range.start.index;
    const endIndex = local.range.end.index;
    if (
      normalizeIdentifier(local.localName) !== normalizedMember ||
      startIndex === undefined ||
      endIndex === undefined ||
      startIndex < containerStart ||
      endIndex > containerEnd
    ) {
      continue;
    }
    const start = local.range.start;
    const position = {
      row: start.line - 1,
      column: start.column - 1,
    };
    const nameNode = targetContext.tree.rootNode.descendantForPosition(position, position);
    if (isPythonReceiverAttributeAssignmentName(nameNode)) return local;
  }
  return undefined;
}

function pythonBaseIdentifierNodes(classNode: SyntaxNodeLike): SyntaxNodeLike[] {
  const bases =
    classNode.childForFieldName("superclasses") ??
    (classNode.namedChildren ?? []).find((child) => child.type === "argument_list");
  if (!bases) return [];
  const names: SyntaxNodeLike[] = [];
  const visit = (node: SyntaxNodeLike): void => {
    if (node.type === "keyword_argument" || node.type === "dictionary_splat" || node.type === "list_splat") {
      return;
    }
    if (node.type === "identifier") {
      names.push(node);
      return;
    }
    if (node.type === "subscript") {
      const value = node.childForFieldName("value");
      if (value) visit(value);
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(bases);
  return names;
}

function resolvePythonNamedClass(index: ProjectIndex, mod: ModuleIndex, name: string): SymbolDef | undefined {
  const classes = mod.locals.filter((local) => local.kind === SymbolKind.Class && local.localName === name);
  const topLevel = classes.filter((local) => !local.isMember);
  const candidates = topLevel.length ? topLevel : classes;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) return undefined;

  for (const imp of mod.imports) {
    if (imp.kind === "named" && imp.local === name) {
      const result = resolveImported(index, imp, imp.imported);
      if (result && !("namespace" in result) && result.kind === SymbolKind.Class) return result;
    }
    if (imp.kind === "star") {
      const result = resolveImported(index, imp, name);
      if (result && !("namespace" in result) && result.kind === SymbolKind.Class) return result;
    }
  }
  const exported = resolveExport(index, mod.file, name, { preferredKind: SymbolKind.Class, allowLocalFallback: false });
  if (exported?.kind === "resolved" && exported.def.kind === SymbolKind.Class) return exported.def;
  return undefined;
}

async function pythonBaseClassRefs(index: ProjectIndex, classRef: PythonClassRef): Promise<PythonClassRef[]> {
  const names = pythonBaseIdentifierNodes(classRef.container);
  const refs: PythonClassRef[] = [];
  const seen = new Set<string>();
  for (const nameNode of names) {
    const def = resolvePythonNamedClass(index, classRef.module, sliceText(nameNode, classRef.context.source));
    if (!def) continue;
    const key = pythonClassKey(def);
    if (seen.has(key)) continue;
    seen.add(key);
    const ref = await pythonClassRefFromDef(index, def);
    if (ref) refs.push(ref);
  }
  return refs;
}

async function lookupPythonClassMember(
  index: ProjectIndex,
  start: PythonClassRef,
  member: string,
): Promise<SymbolDef | undefined> {
  const own = pythonMembersOnClass(start, member);
  if (own.length === 1) return own[0];
  if (own.length > 1) return undefined;

  let level = await pythonBaseClassRefs(index, start);
  const visited = new Set<string>([pythonClassKey(start.def), ...level.map((base) => pythonClassKey(base.def))]);
  for (let depth = 0; depth < PYTHON_SUPERTYPE_DEPTH && level.length; depth += 1) {
    const matches: SymbolDef[] = [];
    const seenMatch = new Set<string>();
    for (const base of level) {
      for (const hit of pythonMembersOnClass(base, member)) {
        const key = pythonClassKey(hit);
        if (seenMatch.has(key)) continue;
        seenMatch.add(key);
        matches.push(hit);
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
    const next: PythonClassRef[] = [];
    for (const base of level) {
      for (const parent of await pythonBaseClassRefs(index, base)) {
        const key = pythonClassKey(parent.def);
        if (visited.has(key)) continue;
        visited.add(key);
        next.push(parent);
      }
    }
    level = next;
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
