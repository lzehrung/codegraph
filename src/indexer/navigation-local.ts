import type { LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { FileId } from "../types.js";
import { fileIdentityKey, normalizePath } from "../util/paths.js";
import { okGoToResult } from "./navigation-provenance.js";
import { cppBindingCallableShape, cppSelectCallableBinding } from "./cpp-callables.js";
import { cScopeName, cTagRole } from "../languages/definitions/c.js";
import { buildScopeIndexFromSource, type Binding, type ScopeIndex } from "./scope.js";
import { resolveExport, resolveImported } from "./navigation-resolve.js";
import {
  SymbolKind,
  type GoToResult,
  type ModuleIndex,
  type ProjectIndex,
  type ResolvedExport,
  type SymbolDef,
} from "./types.js";

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
  mod: ModuleIndex,
  tree: SyntaxTreeLike,
): ScopeIndex {
  const fileKey = fileIdentityKey(file);
  let scopeIndex = index.scopeCache.get(fileKey);
  if (scopeIndex) return scopeIndex;
  scopeIndex = buildScopeIndexFromSource(file, source, sup, mod.imports, { tree });
  index.scopeCache.set(fileKey, scopeIndex);
  return scopeIndex;
}

export function findClosestScopeBinding(
  scopeIndex: ScopeIndex,
  bindingName: string,
  currentNode: SyntaxNodeLike,
  support: LanguageSupport,
): Binding | null {
  const canonicalName = support.normalizeIdentifier(bindingName);
  const normalizedName = support.id === "c" && cTagRole(currentNode) ? cScopeName(canonicalName, "tag") : canonicalName;
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
    const binding = currentScope.map.get(normalizedName);
    if (binding) return binding;
    currentScope = currentScope.parent;
  }

  return null;
}

export function findClosestBinding(
  scopeIndex: ScopeIndex,
  file: FileId,
  bindingName: string,
  currentNode: SyntaxNodeLike,
  support: LanguageSupport,
  source?: string,
): SymbolDef | null {
  const binding = findClosestScopeBinding(scopeIndex, bindingName, currentNode, support);
  if (!binding?.def) return null;
  if (support.id === "cpp" && binding.kind === "function" && source) {
    const collisions = binding.sameScopeFunctionBindings ?? [binding];
    if (collisions.length > 1 || cppBindingCallableShape(binding)) {
      const selected = cppSelectCallableBinding(collisions, currentNode, source);
      if (!selected?.def) return null;
      return {
        file,
        localName: selected.name,
        kind: SymbolKind.Function,
        range: selected.def,
      };
    }
  }
  let kind = SymbolKind.Variable;
  if (binding.kind === "function") {
    kind = SymbolKind.Function;
  } else if (binding.kind === "class") {
    kind = SymbolKind.Class;
  } else if (binding.kind === "type") {
    kind = SymbolKind.TypeAlias;
  }
  const tagRole = support.id === "c" && binding.node ? cTagRole(binding.node) : undefined;
  return {
    file,
    localName: binding.name,
    kind,
    range: binding.def,
    ...(tagRole ? { cTag: tagRole } : {}),
  };
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
  cNamespace?: "tag" | "ordinary",
  referenceIndex?: number,
): GoToResult | null {
  const normalizedName = support.normalizeIdentifier(name);
  const requiresExplicitReceiver = !support.membersAreImplicitlyInScope;
  const directExport =
    requiresExplicitReceiver && support.id !== "c"
      ? mod.exports.find(
          (entry) =>
            entry.type === "local" &&
            support.normalizeIdentifier(entry.exportedAs) === normalizedName &&
            !entry.target.isMember,
        )
      : undefined;
  const suppressCppUnqualifiedLocalExport = support.id === "cpp" && !name.includes("::");
  let hit: ResolvedExport | null = null;
  if (!suppressCppUnqualifiedLocalExport) {
    hit =
      directExport && directExport.type === "local"
        ? { kind: "resolved", def: directExport.target }
        : resolveExport(index, file, name, {
            allowLocalFallback: support.membersAreImplicitlyInScope,
            ...(cNamespace ? { cNamespace } : {}),
            ...(support.id === "csharp" && referenceIndex !== undefined ? { referenceIndex } : {}),
          });
  }
  if (hit?.kind === "resolved" && (!requiresExplicitReceiver || !hit.def.isMember)) {
    const importedFrom =
      support.id === "c" && fileIdentityKey(file) !== fileIdentityKey(hit.def.file) ? hit.def.file : undefined;
    return okGoToResult(index, hit.def, {
      via: { exportedName: name, ...(importedFrom ? { importedFrom } : {}) },
      resolution: importedFrom ? "import" : "exact",
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
    if (imp.kind === "default" && support.normalizeIdentifier(imp.local) === normalizedName) {
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
    } else if (imp.kind === "named" && support.normalizeIdentifier(imp.local) === normalizedName) {
      const result = resolveImported(index, imp, imp.imported, cNamespace ? { cNamespace } : undefined);
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
      const result = resolveImported(index, imp, name, cNamespace ? { cNamespace } : undefined);
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
    } else if (imp.kind === "namespace" && support.normalizeIdentifier(imp.localNS) === normalizedName) {
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
