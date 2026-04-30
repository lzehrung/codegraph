import type { LanguageSupport } from "../languages.js";
import type { JsLanguage, SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { FileId } from "../types.js";
import { buildScopeIndexFromSource, type ScopeIndex } from "./scope.js";
import { resolveExport, resolveImported } from "./navigation-resolve.js";
import { SymbolKind, type GoToResult, type ModuleIndex, type ProjectIndex, type SymbolDef } from "./types.js";

export function findDeclarationNameNode(
  sup: LanguageSupport,
  currentNode: SyntaxNodeLike | null,
): SyntaxNodeLike | null {
  let current: SyntaxNodeLike | null = currentNode;
  while (current) {
    if (
      current.type === "function_declaration" ||
      current.type === "class_declaration" ||
      current.type === "variable_declarator" ||
      current.type === "interface_declaration" ||
      current.type === "type_alias_declaration" ||
      current.type === "function_definition" ||
      current.type === "class_definition" ||
      current.type === "assignment"
    ) {
      let named = current.childForFieldName("name");
      if (!named && current.type === "assignment") {
        const left = current.child(0);
        if (left && sup.nodeTypes.identifier.includes(left.type)) {
          named = left;
        }
      }
      if (named && sup.nodeTypes.identifier.includes(named.type)) {
        return named;
      }
    }
    current = current.parent;
  }
  return null;
}

export function getOrBuildScopeIndex(
  index: ProjectIndex,
  file: FileId,
  source: string,
  sup: LanguageSupport,
  lang: JsLanguage | undefined,
  mod: ModuleIndex,
  tree: SyntaxTreeLike,
): ScopeIndex {
  let scopeIndex = index.scopeCache.get(file);
  if (scopeIndex) return scopeIndex;
  scopeIndex = buildScopeIndexFromSource(file, source, sup, lang, mod.imports, { tree });
  index.scopeCache.set(file, scopeIndex);
  return scopeIndex;
}

export function findClosestBinding(
  scopeIndex: ScopeIndex,
  file: FileId,
  bindingName: string,
  currentNode: SyntaxNodeLike,
): SymbolDef | null {
  let currentScope = scopeIndex.allScopes.find((scope) => {
    const start = scope.node.startIndex;
    const end = scope.node.endIndex;
    return currentNode.startIndex >= start && currentNode.endIndex <= end;
  });

  if (currentScope) {
    let best = currentScope;
    for (const scope of scopeIndex.allScopes) {
      if (
        currentNode.startIndex >= scope.node.startIndex &&
        currentNode.endIndex <= scope.node.endIndex &&
        scope.node.startIndex >= best.node.startIndex &&
        scope.node.endIndex <= best.node.endIndex
      ) {
        best = scope;
      }
    }
    currentScope = best;
  }

  while (currentScope) {
    const binding = currentScope.map.get(bindingName);
    if (binding && binding.def) {
      let kind = SymbolKind.Variable;
      if (binding.kind === "function") {
        kind = SymbolKind.Function;
      } else if (binding.kind === "class") {
        kind = SymbolKind.Class;
      } else if (binding.kind === "type") {
        kind = SymbolKind.TypeAlias;
      }
      return {
        file,
        localName: binding.name,
        kind,
        range: binding.def,
      };
    }
    currentScope = currentScope.parent;
  }

  return null;
}

export function toModuleRef(resolved?: FileId | { external: string }): string | undefined {
  if (!resolved) return undefined;
  return typeof resolved === "string" ? resolved : resolved.external;
}

export function resolveNamedDefinition(
  index: ProjectIndex,
  mod: ModuleIndex,
  file: FileId,
  name: string,
): GoToResult | null {
  const hit = resolveExport(index, file, name);
  if (hit?.kind === "resolved") {
    return {
      status: "ok",
      definition: hit.def,
      via: { exportedName: name },
    };
  }
  if (hit?.kind === "namespace") {
    const targetMod = index.byFile.get(hit.file);
    const firstExport = targetMod?.exports.find((entry) => entry.type === "local");
    if (firstExport) {
      return {
        status: "ok",
        definition: firstExport.target,
        via: { exportedName: name },
      };
    }
  }

  for (const imp of mod.imports) {
    if (imp.kind === "default" && imp.local === name) {
      const result = resolveImported(index, imp, "default");
      if (result && !("namespace" in result)) {
        return {
          status: "ok",
          definition: result,
          via: {
            ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
            exportedName: "default",
          },
        };
      }
    } else if (imp.kind === "named" && imp.local === name) {
      const result = resolveImported(index, imp, imp.imported);
      if (result && !("namespace" in result)) {
        return {
          status: "ok",
          definition: result,
          via: {
            ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
            exportedName: imp.imported,
          },
        };
      }
    } else if (imp.kind === "star") {
      const result = resolveImported(index, imp, name);
      if (result && !("namespace" in result)) {
        return {
          status: "ok",
          definition: result,
          via: {
            ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
            exportedName: name,
          },
        };
      }
    } else if (imp.kind === "namespace" && imp.localNS === name) {
      const targetFile = typeof imp.resolved === "string" ? imp.resolved.replace(/\\/g, "/") : undefined;
      const targetMod = targetFile ? index.byFile.get(targetFile) : undefined;
      const firstExport = targetMod?.exports.find((entry) => entry.type === "local");
      if (firstExport) {
        return {
          status: "ok",
          definition: firstExport.target,
          via: {
            ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
            exportedName: firstExport.exportedAs,
          },
        };
      }
    }
  }

  return null;
}
