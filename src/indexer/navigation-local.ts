import type { LanguageSupport } from "../languages.js";
import type { ParserLanguage, SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { FileId } from "../types.js";
import { fileIdentityKey, normalizePath } from "../util/paths.js";
import { okGoToResult } from "./navigation-provenance.js";
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
  lang: ParserLanguage | undefined,
  mod: ModuleIndex,
  tree: SyntaxTreeLike,
): ScopeIndex {
  const fileKey = fileIdentityKey(file);
  let scopeIndex = index.scopeCache.get(fileKey);
  if (scopeIndex) return scopeIndex;
  scopeIndex = buildScopeIndexFromSource(file, source, sup, lang, mod.imports, { tree });
  index.scopeCache.set(fileKey, scopeIndex);
  return scopeIndex;
}

export function findClosestBinding(
  scopeIndex: ScopeIndex,
  file: FileId,
  bindingName: string,
  currentNode: SyntaxNodeLike,
  support: LanguageSupport,
): SymbolDef | null {
  bindingName = support.normalizeIdentifier(bindingName);
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
  support: LanguageSupport,
  name: string,
): GoToResult | null {
  const requiresExplicitReceiver = !support.membersAreImplicitlyInScope;
  const directExport = requiresExplicitReceiver
    ? mod.exports.find((entry) => entry.type === "local" && entry.exportedAs === name && !entry.target.isMember)
    : undefined;
  const hit =
    directExport && directExport.type === "local"
      ? { kind: "resolved" as const, def: directExport.target }
      : resolveExport(index, file, name, { allowLocalFallback: support.membersAreImplicitlyInScope });
  if (hit?.kind === "resolved" && (!requiresExplicitReceiver || !hit.def.isMember)) {
    return okGoToResult(index, hit.def, {
      via: { exportedName: name },
      resolution: "exact",
      confidence: "high",
    });
  }
  if (hit?.kind === "namespace") {
    const targetMod = index.byFile.get(fileIdentityKey(hit.file));
    const firstExport = targetMod?.exports.find((entry) => entry.type === "local");
    if (firstExport) {
      return okGoToResult(index, firstExport.target, {
        via: { exportedName: name },
        resolution: "namespace",
        confidence: "medium",
      });
    }
  }

  for (const imp of mod.imports) {
    if (imp.kind === "default" && imp.local === name) {
      const result = resolveImported(index, imp, "default");
      if (result && !("namespace" in result)) {
        return okGoToResult(index, result, {
          via: {
            ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
            exportedName: "default",
          },
          resolution: "import",
          confidence: "high",
        });
      }
    } else if (imp.kind === "named" && imp.local === name) {
      const result = resolveImported(index, imp, imp.imported);
      if (result && !("namespace" in result)) {
        return okGoToResult(index, result, {
          via: {
            ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
            exportedName: imp.imported,
          },
          resolution: "import",
          confidence: "high",
        });
      }
    } else if (imp.kind === "star") {
      const result = resolveImported(index, imp, name);
      if (result && !("namespace" in result)) {
        return okGoToResult(index, result, {
          via: {
            ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
            exportedName: name,
          },
          resolution: "import-star",
          confidence: "medium",
        });
      }
    } else if (imp.kind === "namespace" && imp.localNS === name) {
      const targetFile = typeof imp.resolved === "string" ? normalizePath(imp.resolved) : undefined;
      const targetMod = targetFile ? index.byFile.get(fileIdentityKey(targetFile)) : undefined;
      const firstExport = targetMod?.exports.find((entry) => entry.type === "local");
      if (firstExport) {
        return okGoToResult(index, firstExport.target, {
          via: {
            ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
            exportedName: firstExport.exportedAs,
          },
          resolution: "namespace",
          confidence: "medium",
        });
      }
    }
  }

  return null;
}
