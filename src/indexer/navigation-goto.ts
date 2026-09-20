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
  memberAccessTraversalTypes,
} from "../util/member-access.js";
import { CSHARP_IDENTIFIER_SOURCE, JAVA_IDENTIFIER_SOURCE, XID_IDENTIFIER_SOURCE } from "../util/identifiers.js";
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

const RUBY_CONSTANT_SOURCE = String.raw`(?=\p{Lu})${XID_IDENTIFIER_SOURCE}`;
const CSHARP_CONSTANT_SOURCE = String.raw`(?=@?\p{Lu})${CSHARP_IDENTIFIER_SOURCE}`;
const JAVA_CONSTANT_SOURCE = String.raw`(?=\p{Lu})${JAVA_IDENTIFIER_SOURCE}`;
const RUST_CONSTANT_SOURCE = String.raw`(?=\p{Lu})${XID_IDENTIFIER_SOURCE}`;
const IDENTIFIER_BOUNDARY_SOURCE = String.raw`[$_\p{ID_Continue}\u200c\u200d]`;

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
  const implicitClassReceiver =
    (isJsTsLanguage(sup.id) && receiverName === "this") ||
    (sup.id === "php" && /^(?:\$this|self|static)$/.test(receiverName)) ||
    (sup.id === "rust" && /^(?:self|Self)$/.test(receiverName));
  if (obj && prop && node.id === prop.id && (supportsReceiverMemberResolution(sup.id) || implicitClassReceiver)) {
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

    const receiver = await resolveReceiverDefinition(obj, source, sup, resolveExpression);

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
          let memberDef: SymbolDef | undefined;
          if (receiver.runtimeTypeOnly) {
            memberDef = findDirectLocalWithinNode(
              targetModule.locals,
              member,
              container,
              targetContext,
              normalizeIdentifier,
            );
          } else if (targetContext.sup.id === "java") {
            memberDef = findDirectLocalWithinNode(
              targetModule.locals,
              member,
              container,
              targetContext,
              normalizeIdentifier,
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

type ReceiverMemberScope = "any" | "instance" | "static";

type ResolvedReceiverDefinition = {
  def: SymbolDef;
  memberScope: ReceiverMemberScope;
  runtimeTypeOnly?: true;
};

async function resolveReceiverDefinition(
  obj: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
  resolveExpression: (expr: SyntaxNodeLike) => Promise<ResolvedExport | null>,
): Promise<ResolvedReceiverDefinition | null> {
  const constructor = receiverConstructorExpression(obj, source, sup);
  if (constructor) {
    const result = await resolveExpression(constructor);
    if (result?.kind === "resolved") {
      return {
        def: result.def,
        memberScope: isJsTsLanguage(sup.id) ? "instance" : "any",
      };
    }
  }
  const direct = await resolveExpression(obj);
  if (isJsTsLanguage(sup.id) && sup.nodeTypes.identifier.includes(obj.type)) {
    if (direct?.kind === "resolved" && direct.def.kind === SymbolKind.Class) {
      return { def: direct.def, memberScope: "static" };
    }
    if (direct?.kind === "resolved" && direct.def.kind === SymbolKind.TypeAlias) {
      return { def: direct.def, memberScope: "any", runtimeTypeOnly: true };
    }
    return null;
  }
  if (direct?.kind === "resolved") {
    return { def: direct.def, memberScope: "any" };
  }
  return null;
}

/**
 * Resolves the node naming the type a receiver expression was constructed from, or
 * null when no constructor is proven for it. Shared with detailed symbol-graph call
 * extraction so `goto` and resolved `calls` edges accept the same receiver forms.
 */
export function receiverConstructorExpression(
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
  if (!new RegExp(String.raw`^(?:${RUBY_CONSTANT_SOURCE})\.new$`, "u").test(sliceText(node, source))) return null;
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
  "function_definition",
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
  "parameter_declaration",
  "short_var_declaration",
  "var_spec",
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
    if (sup.id === "go" && (current.type === "short_var_declaration" || current.type === "var_spec")) {
      const candidate = constructorFromGoBinding(current, receiverName, source, sup);
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
  const typeNameSource = sup.id === "java" ? JAVA_CONSTANT_SOURCE : CSHARP_CONSTANT_SOURCE;
  const match = text.match(
    new RegExp(
      String.raw`^\s*(${typeNameSource})\s+${escapeRegExp(receiverName)}\s*=\s*new\s+(${typeNameSource})(?![\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Nd}\p{Mn}\p{Mc}\p{Cf}])`,
      "u",
    ),
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
      if (goBindingDeclaresName(current, receiverName, source, sup)) return true;
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
  if (
    !new RegExp(
      String.raw`(?<!${IDENTIFIER_BOUNDARY_SOURCE})${escapeRegExp(receiverName)}(?!${IDENTIFIER_BOUNDARY_SOURCE})`,
      "u",
    ).test(text)
  )
    return null;
  if (sup.id === "ruby") {
    const match = text.match(
      new RegExp(
        String.raw`^\s*${escapeRegExp(receiverName)}\s*=\s*(${RUBY_CONSTANT_SOURCE})\.new(?!${IDENTIFIER_BOUNDARY_SOURCE})`,
        "u",
      ),
    );
    if (!match?.[1]) return null;
    return findNamedChildText(node, match[1], source, sup);
  }
  if (sup.id === "rust") {
    const match = text.match(
      new RegExp(
        String.raw`^\s*(?:let\s+)?${escapeRegExp(receiverName)}\s*=\s*(${RUST_CONSTANT_SOURCE})(?!${IDENTIFIER_BOUNDARY_SOURCE})`,
        "u",
      ),
    );
    if (!match?.[1]) return null;
    return findNamedChildText(node, match[1], source, sup);
  }
  if (sup.id === "python") {
    return pythonConstructorFromAssignment(node, receiverName, source, sup);
  }
  return null;
}

function goBindingNameNodes(node: SyntaxNodeLike): SyntaxNodeLike[] {
  if (node.type === "short_var_declaration") {
    const left = node.childForFieldName("left");
    return (left?.namedChildren ?? []).filter((child) => child.type === "identifier");
  }
  if (node.type === "var_spec") {
    return (node.namedChildren ?? []).filter((child) => child.type === "identifier");
  }
  return [];
}

function goBindingDeclaresName(
  node: SyntaxNodeLike,
  receiverName: string,
  source: string,
  sup: LanguageSupport,
): boolean {
  if (sup.id !== "go") return false;
  return goBindingNameNodes(node).some((name) => sliceText(name, source) === receiverName);
}

function constructorFromGoBinding(
  node: SyntaxNodeLike,
  receiverName: string,
  source: string,
  sup: LanguageSupport,
): SyntaxNodeLike | null {
  if (!goBindingDeclaresName(node, receiverName, source, sup)) return null;
  if (node.type === "short_var_declaration") {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (!left || !right) return null;
    const names = (left.namedChildren ?? []).filter((child) => child.type === "identifier");
    const values = right.namedChildren ?? [];
    const index = names.findIndex((name) => sliceText(name, source) === receiverName);
    if (index < 0) return null;
    const value = values[index] ?? null;
    return value ? goCompositeLiteralTypeName(value, source) : null;
  }
  if (node.type !== "var_spec") return null;
  const value = node.childForFieldName("value");
  if (value) {
    const first = value.type === "expression_list" ? (value.namedChildren[0] ?? null) : value;
    const fromValue = first ? goCompositeLiteralTypeName(first, source) : null;
    if (fromValue) return fromValue;
  }
  const typeNode = node.childForFieldName("type");
  return typeNode ? unwrapGoConstructorType(typeNode) : null;
}

function goCompositeLiteralTypeName(expr: SyntaxNodeLike, source: string): SyntaxNodeLike | null {
  let current = expr;
  if (current.type === "unary_expression") {
    const operand = current.childForFieldName("operand");
    if (!operand) return null;
    const operator = current.childForFieldName("operator");
    let isAddr = sliceText(current, source).startsWith("&");
    if (operator) isAddr = sliceText(operator, source) === "&";
    if (!isAddr) return null;
    current = operand;
  }
  if (current.type !== "composite_literal") return null;
  const typeNode = current.childForFieldName("type");
  return typeNode ? unwrapGoConstructorType(typeNode) : null;
}

function unwrapGoConstructorType(node: SyntaxNodeLike): SyntaxNodeLike | null {
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
      : (local: SymbolDef) => hasStaticModifier(local, targetContext, container) === (memberScope === "static");
  const containerHit =
    memberScope === "any"
      ? findLocalWithinNode(locals, member, container, normalizeIdentifier)
      : findDirectLocalWithinNode(locals, member, container, targetContext, normalizeIdentifier, memberPredicate);
  if (containerHit) return containerHit;
  if (targetContext.sup.id !== "rust") return undefined;

  const implNode = findRustImplForType(targetContext.tree.rootNode, receiverDef.localName, targetContext.source);
  return implNode ? findLocalWithinNode(locals, member, implNode, normalizeIdentifier) : undefined;
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
      if (child.type === "static") return true;
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

function pythonConstructorFromAssignment(
  node: SyntaxNodeLike,
  receiverName: string,
  source: string,
  sup: LanguageSupport,
): SyntaxNodeLike | null {
  const left = node.childForFieldName("left");
  if (!left || !sup.nodeTypes.identifier.includes(left.type) || sliceText(left, source) !== receiverName) {
    return null;
  }
  const right = node.childForFieldName("right");
  if (!right || right.type !== "call") return null;
  const callee = right.childForFieldName("function") ?? right.namedChildren[0] ?? null;
  if (!callee || !sup.nodeTypes.identifier.includes(callee.type)) return null;
  return callee;
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
