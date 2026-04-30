import type { LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import { sliceText } from "../util.js";
import { ensureParsedContext } from "./parse-context.js";
import { resolveExport, resolveImported } from "./navigation-resolve.js";
import type { GoToResult, ModuleIndex, ProjectIndex, ResolvedExport, SymbolDef } from "./types.js";

type MemberAccessTarget = {
  obj: SyntaxNodeLike | null;
  prop: SyntaxNodeLike | null;
};

function getMemberAccessTarget(supId: string, memberNode: SyntaxNodeLike): MemberAccessTarget {
  if (supId === "python") {
    return {
      obj: memberNode.childForFieldName("object") ?? memberNode.child(0),
      prop: memberNode.childForFieldName("attribute") ?? memberNode.child(2),
    };
  }
  if (supId === "csharp") {
    return {
      obj: memberNode.child(0),
      prop: memberNode.child(2),
    };
  }
  if (supId === "java") {
    if (memberNode.type === "method_invocation") {
      return {
        obj: memberNode.childForFieldName("object") ?? memberNode.child(0),
        prop: memberNode.childForFieldName("name") ?? memberNode.child(2),
      };
    }
    if (memberNode.type === "scoped_identifier" || memberNode.type === "scoped_type_identifier") {
      return {
        obj: memberNode.childForFieldName("scope") ?? memberNode.child(0),
        prop: memberNode.childForFieldName("name") ?? memberNode.child(2),
      };
    }
  }
  if (supId === "ruby") {
    if (memberNode.type === "scope_resolution") {
      return {
        obj: memberNode.childForFieldName("scope") ?? memberNode.child(0),
        prop: memberNode.childForFieldName("name") ?? memberNode.child(2),
      };
    }
    return {
      obj: memberNode.childForFieldName("receiver") ?? memberNode.child(0),
      prop: memberNode.childForFieldName("method") ?? memberNode.child(2),
    };
  }
  if (supId === "rust") {
    if (memberNode.type === "scoped_identifier") {
      return {
        obj: memberNode.childForFieldName("path") ?? memberNode.child(0),
        prop: memberNode.childForFieldName("name") ?? memberNode.child(2),
      };
    }
  }
  if (supId === "go") {
    if (memberNode.type === "qualified_type") {
      return {
        obj: memberNode.namedChildren[0] ?? memberNode.child(0),
        prop: memberNode.namedChildren[1] ?? memberNode.child(1),
      };
    }
  }
  if (supId === "kotlin" || supId === "swift") {
    if (memberNode.type === "navigation_expression") {
      const obj = memberNode.namedChildren[0] ?? memberNode.child(0);
      const suffix =
        memberNode.namedChildren.find((child) => child.type === "navigation_suffix") ?? memberNode.child(1);
      if (suffix) {
        return {
          obj,
          prop:
            suffix.childForFieldName("suffix") ??
            suffix.childForFieldName("name") ??
            suffix.namedChildren[0] ??
            suffix.child(0),
        };
      }
      return { obj, prop: null };
    }
  }
  return {
    obj: memberNode.child(0),
    prop: memberNode.child(2),
  };
}

function getNavigationSubProperty(expr: SyntaxNodeLike): SyntaxNodeLike | null {
  const suffix = expr.namedChildren.find((child) => child.type === "navigation_suffix") ?? expr.child(1);
  if (!suffix) return null;
  return (
    suffix.childForFieldName?.("suffix") ??
    suffix.childForFieldName?.("name") ??
    suffix.namedChildren[0] ??
    suffix.child(0)
  );
}

function isMemberAccessNode(
  sup: { id: string; nodeTypes: { memberExpression?: string } },
  node: SyntaxNodeLike,
): boolean {
  const memberExpressionType = sup.nodeTypes.memberExpression ?? "member_expression";
  return (
    node.type === memberExpressionType ||
    (sup.id === "go" && node.type === "qualified_type") ||
    node.type === "member_access_expression" ||
    node.type === "qualified_name" ||
    node.type === "field_access" ||
    node.type === "method_invocation" ||
    node.type === "scoped_identifier" ||
    node.type === "scoped_type_identifier" ||
    node.type === "call" ||
    node.type === "scope_resolution" ||
    node.type === "field_expression" ||
    node.type === "attribute"
  );
}

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
  const { obj, prop } = getMemberAccessTarget(sup.id, memberNode);
  const memberExpressionType = sup.nodeTypes.memberExpression ?? "member_expression";
  const optionalMemberTypes = new Set<string>([
    memberExpressionType,
    sup.id === "go" ? "qualified_type" : "",
    "optional_member_expression",
    "subscript_expression",
    "optional_chain",
    sup.id === "python" ? "attribute" : "",
  ]);

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
      const subObj = expr.child(0);
      let subProp =
        expr.type === "qualified_type"
          ? (expr.namedChildren[1] ?? expr.child(1))
          : (expr.childForFieldName?.("property") ?? expr.child(2) ?? expr.childForFieldName?.("attribute"));
      if (!subProp && expr.type === "navigation_expression") {
        subProp = getNavigationSubProperty(expr);
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
      return {
        status: "ok",
        definition: chain.def,
        via: { exportedName: sliceText(prop, source) },
      };
    }
    if (chain.kind === "namespace") {
      const targetMod = index.byFile.get(chain.file);
      const first = targetMod?.exports.find((entry) => entry.type === "local");
      if (first) {
        return {
          status: "ok",
          definition: first.target,
          via: { exportedName: first.exportedAs },
        };
      }
    }
  }

  if (
    obj &&
    prop &&
    node.id === prop.id &&
    (sup.id === "csharp" || sup.id === "java" || sup.id === "ruby" || sup.id === "rust")
  ) {
    const member = sliceText(prop, source);
    let objDef: SymbolDef | null = null;
    const result = await resolveExpression(obj);
    if (result?.kind === "resolved") objDef = result.def;

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
            return {
              status: "ok",
              definition: memberDef,
              via: { exportedName: member },
            };
          }
        }
      }
    }
  }

  return null;
}
