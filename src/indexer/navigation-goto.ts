import type { LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import { sliceText } from "../util/ast.js";
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
}): Promise<GoToResult | null> {
  const { index, mod, node, source, sup } = params;
  const parent = node.parent;
  if (!parent || !sup.supportsCrossModuleSymbols || !isMemberAccessNode(sup, parent)) {
    return null;
  }

  const memberNode = parent;
  const { object: obj, property: prop } = getMemberAccessParts(sup, memberNode);
  const optionalMemberTypes = memberAccessTraversalTypes(sup);

  const resolveExpression = async (expr: SyntaxNodeLike): Promise<ResolvedExport | null> => {
    const exprName = sliceText(expr, source);
    const exprIsId = sup.nodeTypes.identifier.includes(expr.type);
    if (exprIsId || expr.type === "identifier" || expr.type === "type_identifier" || expr.type === "constant") {
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
          return resolveExport(index, base.file, memberName);
        }
        if (base?.kind === "resolved") {
          if (sup.id === "java" || sup.id === "ruby") {
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
          return resolveExport(index, base.file, memberName);
        }
        if (base?.kind === "resolved") {
          return resolveExport(index, base.def.file, memberName);
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
      const targetMod = index.byFile.get(chain.file);
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

  if (obj && prop && node.id === prop.id && supportsReceiverMemberResolution(sup.id)) {
    const member = sliceText(prop, source);
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
        const targetModule = index.byFile.get(objDef.file);
        if (targetModule) {
          const containerStart = container.startIndex;
          const containerEnd = container.endIndex;
          const memberDef = targetModule.locals.find((local) => {
            const startIndex = local.range.start.index;
            const endIndex = local.range.end.index;
            return (
              local.localName === member &&
              startIndex !== undefined &&
              endIndex !== undefined &&
              startIndex >= containerStart &&
              endIndex <= containerEnd
            );
          });

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

function supportsReceiverMemberResolution(languageId: string): boolean {
  return (
    languageId === "csharp" ||
    languageId === "js" ||
    languageId === "java" ||
    languageId === "javascript" ||
    languageId === "jsx" ||
    languageId === "ruby" ||
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
  if (isJsTsLanguage(sup.id)) {
    const constructor = receiverConstructorExpression(obj, source, sup);
    if (constructor) {
      const result = await resolveExpression(constructor);
      if (result?.kind === "resolved") {
        return result.def;
      }
    }
  }

  const direct = await resolveExpression(obj);
  if (direct?.kind === "resolved") {
    return direct.def;
  }
  return null;
}

function isJsTsLanguage(languageId: string): boolean {
  return (
    languageId === "javascript" ||
    languageId === "jsx" ||
    languageId === "js" ||
    languageId === "typescript" ||
    languageId === "tsx" ||
    languageId === "ts"
  );
}

function receiverConstructorExpression(
  obj: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
): SyntaxNodeLike | null {
  if (obj.type === "new_expression") {
    return constructorNameNode(obj, sup);
  }
  if (!sup.nodeTypes.identifier.includes(obj.type)) {
    return null;
  }

  const receiverName = sliceText(obj, source);
  const root = rootOf(obj);
  return findPriorNewConstructor(root, receiverName, obj.startIndex, source, sup);
}

function constructorNameNode(node: SyntaxNodeLike, sup: LanguageSupport): SyntaxNodeLike | null {
  const constructor = node.childForFieldName("constructor") ?? node.child(0);
  if (constructor && sup.nodeTypes.identifier.includes(constructor.type)) {
    return constructor;
  }
  return null;
}

function rootOf(node: SyntaxNodeLike): SyntaxNodeLike {
  let current = node;
  while (current.parent) {
    current = current.parent;
  }
  return current;
}

function findPriorNewConstructor(
  node: SyntaxNodeLike,
  receiverName: string,
  beforeIndex: number,
  source: string,
  sup: LanguageSupport,
): SyntaxNodeLike | null {
  let constructor: SyntaxNodeLike | null = null;
  const visit = (current: SyntaxNodeLike): boolean => {
    if (current.startIndex >= beforeIndex) {
      return true;
    }
    if (current.type === "variable_declarator") {
      const name = current.childForFieldName("name") ?? current.child(0);
      const value = current.childForFieldName("value");
      if (
        name &&
        value?.type === "new_expression" &&
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
