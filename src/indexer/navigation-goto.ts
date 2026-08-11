import type { LanguageSupport } from "../languages.js";
import { isJsTsLanguage } from "../languages/js-family.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import { sliceText } from "../util/ast.js";
import { fileIdentityKey } from "../util/paths.js";
import {
  getMemberAccessParts,
  getNavigationExpressionProperty,
  isMemberAccessNode,
  memberAccessTraversalTypes,
} from "../util/memberAccess.js";
import { ensureParsedContext } from "./parse-context.js";
import { okGoToResult } from "./navigation-provenance.js";
import { resolveExport, resolveImported } from "./navigation-resolve.js";
import type { GoToResult, ModuleIndex, ProjectIndex, ResolvedExport, SymbolDef } from "./types.js";

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
  if (!parent || !sup.supportsCrossModuleSymbols || !isMemberAccessNode(sup, parent)) {
    return null;
  }

  const memberNode = parent;
  const { object: obj, property: prop } = getMemberAccessParts(sup, memberNode);
  const optionalMemberTypes = memberAccessTraversalTypes(sup);

  const resolveExpression = async (expr: SyntaxNodeLike): Promise<ResolvedExport | null> => {
    const exprIsId = sup.nodeTypes.identifier.includes(expr.type) && !isMemberAccessNode(sup, expr);
    if (exprIsId || expr.type === "identifier" || expr.type === "type_identifier" || expr.type === "constant") {
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
        subProp = getNavigationExpressionProperty(expr);
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
  const implicitClassReceiver =
    (isJsTsLanguage(sup.id) && receiverName === "this") ||
    (sup.id === "php" && /^(?:\$this|self|static)$/.test(receiverName)) ||
    (sup.id === "rust" && /^(?:self|Self)$/.test(receiverName));
  if (obj && prop && node.id === prop.id && (supportsReceiverMemberResolution(sup.id) || implicitClassReceiver)) {
    const member = sliceText(prop, source);
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

    const objDef = await resolveReceiverDefinition(obj, source, sup, resolveExpression);

    if (objDef) {
      const targetContext = await ensureParsedContext(objDef.file);
      const start = objDef.range.start;
      const targetPosition = {
        row: start.line - 1,
        column: start.column - 1,
      };
      const nameNode = targetContext.tree.rootNode.descendantForPosition(targetPosition, targetPosition);
      const container = nameNode.parent;
      if (container) {
        const targetModule = index.byFile.get(fileIdentityKey(objDef.file));
        if (targetModule) {
          const memberDef =
            targetContext.sup.id === "java"
              ? findDirectLocalWithinNode(targetModule.locals, member, container, targetContext)
              : findReceiverMemberDefinition(targetModule.locals, member, objDef, container, targetContext);

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
  let current = node.parent;
  while (current) {
    if (
      current.type === "class_declaration" ||
      current.type === "abstract_class_declaration" ||
      current.type === "class_definition" ||
      current.type === "impl_item"
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

export function supportsReceiverMemberResolution(languageId: string): boolean {
  return (
    languageId === "csharp" ||
    languageId === "python" ||
    languageId === "js" ||
    languageId === "java" ||
    languageId === "javascript" ||
    languageId === "jsx" ||
    languageId === "rust" ||
    languageId === "ts" ||
    languageId === "typescript" ||
    languageId === "tsx"
  );
}

async function resolveReceiverDefinition(
  obj: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
  resolveExpression: (expr: SyntaxNodeLike) => Promise<ResolvedExport | null>,
): Promise<SymbolDef | null> {
  const constructor = receiverConstructorExpression(obj, source, sup);
  if (constructor) {
    const result = await resolveExpression(constructor);
    if (result?.kind === "resolved") {
      return result.def;
    }
  }
  if (isJsTsLanguage(sup.id)) {
    if (sup.nodeTypes.identifier.includes(obj.type)) {
      return null;
    }
  }

  const direct = await resolveExpression(obj);
  if (direct?.kind === "resolved") {
    return direct.def;
  }
  return null;
}

function receiverConstructorExpression(
  obj: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
): SyntaxNodeLike | null {
  if (obj.type === "new_expression" || obj.type === "object_creation_expression") {
    return constructorNameNode(obj, sup);
  }
  if (sup.id === "ruby" && obj.type === "call") {
    const rubyConstructor = rubyNewReceiverNameNode(obj, source, sup);
    if (rubyConstructor) return rubyConstructor;
  }
  if (!sup.nodeTypes.identifier.includes(obj.type)) {
    return null;
  }

  const receiverName = sliceText(obj, source);
  return findVisiblePriorNewConstructor(obj, receiverName, source, sup);
}

function constructorNameNode(node: SyntaxNodeLike, sup: LanguageSupport): SyntaxNodeLike | null {
  const constructor = node.childForFieldName("constructor") ?? node.child(0);
  if (constructor && sup.nodeTypes.identifier.includes(constructor.type)) {
    return constructor;
  }
  for (const child of node.namedChildren) {
    if (
      sup.nodeTypes.identifier.includes(child.type) ||
      child.type === "type_identifier" ||
      child.type === "constant"
    ) {
      return child;
    }
  }
  return null;
}

function rubyNewReceiverNameNode(node: SyntaxNodeLike, source: string, sup: LanguageSupport): SyntaxNodeLike | null {
  if (!/^[A-Z]\w*\.new$/.test(sliceText(node, source))) return null;
  return (
    node.namedChildren.find((child) => sup.nodeTypes.identifier.includes(child.type) || child.type === "constant") ??
    null
  );
}

function rootOf(node: SyntaxNodeLike): SyntaxNodeLike {
  let current = node;
  while (current.parent) {
    current = current.parent;
  }
  return current;
}

const BINDING_CONTAINER_TYPES = new Set([
  "program",
  "compilation_unit",
  "source_file",
  "statement_block",
  "block",
  "function_declaration",
  "function_item",
  "function",
  "function_expression",
  "arrow_function",
  "method_definition",
  "method_declaration",
  "method",
]);

const BINDING_DECLARATION_TYPES = new Set([
  "variable_declarator",
  "let_declaration",
  "assignment",
  "formal_parameter",
  "required_parameter",
  "optional_parameter",
]);

function findVisiblePriorNewConstructor(
  receiver: SyntaxNodeLike,
  receiverName: string,
  source: string,
  sup: LanguageSupport,
): SyntaxNodeLike | null {
  let current: SyntaxNodeLike | null = receiver;
  while (current) {
    if (BINDING_CONTAINER_TYPES.has(current.type)) {
      const constructor = findPriorNewConstructorInContainer(current, receiver, receiverName, source, sup);
      if (constructor || bindingContainerDeclaresNameBefore(current, receiver, receiverName, source, sup)) {
        return constructor;
      }
    }
    current = current.parent;
  }

  return findPriorNewConstructorInContainer(rootOf(receiver), receiver, receiverName, source, sup);
}

function findPriorNewConstructorInContainer(
  node: SyntaxNodeLike,
  receiver: SyntaxNodeLike,
  receiverName: string,
  source: string,
  sup: LanguageSupport,
): SyntaxNodeLike | null {
  let constructor: SyntaxNodeLike | null = null;
  const visit = (current: SyntaxNodeLike): boolean => {
    if (current.startIndex >= receiver.startIndex) {
      return true;
    }
    if (current !== node && isSkippableBindingContainer(current, receiver)) {
      return true;
    }
    if (current.type === "variable_declarator") {
      const name = current.childForFieldName("name") ?? current.child(0);
      const value = current.childForFieldName("value");
      if (
        name &&
        value &&
        (value.type === "new_expression" ||
          value.type === "object_creation_expression" ||
          sup.nodeTypes.identifier.includes(value.type)) &&
        sup.nodeTypes.identifier.includes(name.type) &&
        sliceText(name, source) === receiverName
      ) {
        const candidate = constructorNameNode(value, sup);
        if (!candidate) {
          return true;
        }
        if (constructor && sliceText(constructor, source) !== sliceText(candidate, source)) {
          constructor = null;
          return false;
        }
        constructor = candidate;
      }
    }
    if (current.type === "assignment" || current.type === "let_declaration") {
      const candidate = constructorFromAssignmentLike(current, receiverName, source, sup);
      if (candidate) {
        if (constructor && sliceText(constructor, source) !== sliceText(candidate, source)) {
          constructor = null;
          return false;
        }
        constructor = candidate;
      }
    }
    if (
      current.type === "local_variable_declaration" ||
      current.type === "local_declaration_statement" ||
      current.type === "variable_declaration"
    ) {
      const candidate = constructorFromTypedLocalDeclaration(current, receiverName, source, sup);
      if (candidate) {
        if (constructor && sliceText(constructor, source) !== sliceText(candidate, source)) {
          constructor = null;
          return false;
        }
        constructor = candidate;
      }
    }
    for (const child of current.namedChildren) {
      if (!visit(child)) {
        return false;
      }
    }
    return true;
  };
  visit(node);
  return constructor;
}

function constructorFromTypedLocalDeclaration(
  node: SyntaxNodeLike,
  receiverName: string,
  source: string,
  sup: LanguageSupport,
): SyntaxNodeLike | null {
  if (sup.id !== "csharp" && sup.id !== "java") return null;
  const text = sliceText(node, source);
  const match = text.match(
    new RegExp(`^\\s*([A-Z]\\w*)\\s+${escapeRegExp(receiverName)}\\s*=\\s*new\\s+([A-Z]\\w*)\\b`),
  );
  const typeName = match?.[2] ?? match?.[1];
  return typeName ? findNamedChildText(node, typeName, source, sup) : null;
}

function bindingContainerDeclaresNameBefore(
  node: SyntaxNodeLike,
  receiver: SyntaxNodeLike,
  receiverName: string,
  source: string,
  sup: LanguageSupport,
): boolean {
  const visit = (current: SyntaxNodeLike): boolean => {
    if (current.startIndex >= receiver.startIndex) {
      return false;
    }
    if (current !== node && isSkippableBindingContainer(current, receiver)) {
      return false;
    }
    if (BINDING_DECLARATION_TYPES.has(current.type)) {
      const name = current.childForFieldName("name") ?? current.child(0);
      if (name && sup.nodeTypes.identifier.includes(name.type) && sliceText(name, source) === receiverName) {
        return true;
      }
    }
    for (const child of current.namedChildren) {
      if (visit(child)) {
        return true;
      }
    }
    return false;
  };
  return visit(node);
}

function isSkippableBindingContainer(node: SyntaxNodeLike, receiver: SyntaxNodeLike): boolean {
  return BINDING_CONTAINER_TYPES.has(node.type) && !nodeContainsIndex(node, receiver.startIndex);
}

function nodeContainsIndex(node: SyntaxNodeLike, index: number): boolean {
  return node.startIndex <= index && node.endIndex >= index;
}

function constructorFromAssignmentLike(
  node: SyntaxNodeLike,
  receiverName: string,
  source: string,
  sup: LanguageSupport,
): SyntaxNodeLike | null {
  const text = sliceText(node, source);
  if (!new RegExp(`\\b${escapeRegExp(receiverName)}\\b`).test(text)) return null;
  if (sup.id === "ruby") {
    const match = text.match(new RegExp(`^\\s*${escapeRegExp(receiverName)}\\s*=\\s*([A-Z]\\w*)\\.new\\b`));
    if (!match?.[1]) return null;
    return findNamedChildText(node, match[1], source, sup);
  }
  if (sup.id === "rust") {
    const match = text.match(new RegExp(`^\\s*(?:let\\s+)?${escapeRegExp(receiverName)}\\s*=\\s*([A-Z]\\w*)\\b`));
    if (!match?.[1]) return null;
    return findNamedChildText(node, match[1], source, sup);
  }
  return null;
}

function findNamedChildText(
  node: SyntaxNodeLike,
  name: string,
  source: string,
  sup: LanguageSupport,
): SyntaxNodeLike | null {
  const isNameNode = (candidate: SyntaxNodeLike): boolean =>
    (sup.nodeTypes.identifier.includes(candidate.type) ||
      candidate.type === "type_identifier" ||
      candidate.type === "constant") &&
    sliceText(candidate, source) === name;
  const visit = (current: SyntaxNodeLike): SyntaxNodeLike | null => {
    if (isNameNode(current)) return current;
    for (const child of current.namedChildren) {
      const hit = visit(child);
      if (hit) return hit;
    }
    return null;
  };
  return visit(node);
}

async function resolveMemberDefinitionForBase(
  index: ProjectIndex,
  baseDef: SymbolDef,
  member: string,
): Promise<SymbolDef | undefined> {
  const targetContext = await ensureParsedContext(baseDef.file);
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
  const directHit = findDirectLocalWithinNode(targetModule.locals, member, container, targetContext);
  if (directHit) return directHit;
  if (targetContext.sup.id === "java") return undefined;
  return findReceiverMemberDefinition(targetModule.locals, member, baseDef, container, targetContext);
}

function findReceiverMemberDefinition(
  locals: readonly SymbolDef[],
  member: string,
  receiverDef: SymbolDef,
  container: SyntaxNodeLike,
  targetContext: Awaited<ReturnType<typeof ensureParsedContext>>,
): SymbolDef | undefined {
  const containerHit = findLocalWithinNode(locals, member, container);
  if (containerHit) return containerHit;
  if (targetContext.sup.id !== "rust") return undefined;

  const implNode = findRustImplForType(targetContext.tree.rootNode, receiverDef.localName, targetContext.source);
  return implNode ? findLocalWithinNode(locals, member, implNode) : undefined;
}

function findLocalWithinNode(
  locals: readonly SymbolDef[],
  member: string,
  node: SyntaxNodeLike,
  normalizeIdentifier: (name: string) => string = (name) => name,
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
      endIndex <= containerEnd
    );
  });
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
  targetContext: Awaited<ReturnType<typeof ensureParsedContext>>,
): SymbolDef | undefined {
  const containerStart = container.startIndex;
  const containerEnd = container.endIndex;
  for (const local of locals) {
    const startIndex = local.range.start.index;
    const endIndex = local.range.end.index;
    if (
      local.localName !== member ||
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
      if (
        !isDeclarationParent &&
        ((current.type === "class_body" && current.parent !== container) ||
          NESTED_MEMBER_LOCAL_CONTAINERS.has(current.type))
      ) {
        current = null;
        break;
      }
      isDeclarationParent = false;
      current = current.parent;
    }
    if (current) return local;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
