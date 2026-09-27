import type { LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { FileId, Range } from "../types.js";
import { fileIdentityKey, normalizePath } from "../util/paths.js";
import { okGoToResult } from "./navigation-provenance.js";
import { cppBindingCallableShape, cppSelectCallableBinding } from "./cpp-callables.js";
import { cScopeName, cTagRole } from "../languages/definitions/c.js";
import { bindingCoversUse, fileScopeDefinitionCoversUse, scopeNodesFor } from "./scope-nodes.js";
import { buildScopeIndexFromSource, type Binding, type ScopeIndex } from "./scope.js";
import { cjsRequireValueBinding, resolveExport, resolveImported } from "./navigation-resolve.js";
import { phpNamedImportRole } from "./import-types.js";
import { resolvePhpExplicitImport } from "./php-namespace-symbols.js";
import { AMBIGUOUS_STAR_IMPORT_REASON } from "./ambiguous-resolution.js";
import {
  decideStarImportCandidates,
  effectiveExplicitOrLocalBinding,
  isExpandedStarBinding,
  resolveStarImportedDefinition,
  starImportPrecedence,
  type StarImportCandidate,
} from "./star-import-precedence.js";
import {
  SymbolKind,
  type GoToResult,
  type ImportBinding,
  type ModuleIndex,
  type ProjectIndex,
  type ResolvedExport,
  type SymbolDef,
} from "./types.js";

/** Follow a C# name token through generic arguments and qualified-name segments. */
export function csharpQualifiedNameNode(node: SyntaxNodeLike): SyntaxNodeLike | null {
  let qualified = node;
  while (qualified.parent) {
    const parent = qualified.parent;
    if (parent.type === "generic_name") {
      const name = parent.childForFieldName("name") ?? parent.namedChildren[0];
      if (name && name.startIndex === qualified.startIndex && name.endIndex === qualified.endIndex) {
        qualified = parent;
        continue;
      }
    }
    if (
      (parent.type === "qualified_name" || parent.type === "alias_qualified_name") &&
      parent.endIndex === qualified.endIndex
    ) {
      qualified = parent;
      continue;
    }
    break;
  }
  return qualified.type === "qualified_name" || qualified.type === "alias_qualified_name" ? qualified : null;
}

/** Preserve the full C# namespace or alias path, excluding generic type arguments. */
export function csharpLookupName(node: SyntaxNodeLike, source: string, fallback: string): string {
  const qualified = csharpQualifiedNameNode(node);
  if (!qualified) return fallback;
  const text = source.slice(qualified.startIndex, qualified.endIndex);
  if (!text.includes("<")) return text.replace(/\s+/gu, "");
  const argumentsNodes: SyntaxNodeLike[] = [];
  const collect = (current: SyntaxNodeLike): void => {
    if (current.type === "generic_name") {
      const argumentsNode = (current.namedChildren ?? []).find((child) => child.type === "type_argument_list");
      if (argumentsNode) argumentsNodes.push(argumentsNode);
      return;
    }
    for (const child of current.namedChildren ?? []) {
      if (child.type === "generic_name" || child.type === "qualified_name" || child.type === "alias_qualified_name") {
        collect(child);
      }
    }
  };
  collect(qualified);
  let result = "";
  let from = qualified.startIndex;
  for (const argumentsNode of argumentsNodes) {
    result += source.slice(from, argumentsNode.startIndex);
    from = argumentsNode.endIndex;
  }
  return (result + source.slice(from, qualified.endIndex)).replace(/\s+/gu, "");
}

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

function effectivePythonModuleScopeBinding(binding: Binding, useStartIndex: number): Binding | null {
  let importBinding: ImportBinding | undefined;
  let importSource: Binding | undefined;
  let localBinding: Binding | undefined;
  let latestLocalStart = -1;
  for (let candidate: Binding | undefined = binding; candidate; candidate = candidate.earlierSameScope) {
    const localStart = candidate.def?.start.index;
    if (localStart !== undefined && localStart <= useStartIndex && localStart > latestLocalStart) {
      localBinding = candidate;
      latestLocalStart = localStart;
    }
    if (!importBinding && candidate.import) {
      importBinding = candidate.import;
      importSource = candidate;
    }
  }
  const imports = importBinding ? [importBinding] : [];
  const effective = effectiveExplicitOrLocalBinding(
    imports,
    "python",
    () => true,
    localBinding?.def?.start.index,
    useStartIndex,
  );
  if (effective?.kind === "local") return localBinding ?? null;
  if (effective?.kind === "explicit") return importSource ?? null;
  return null;
}

export function findClosestScopeBinding(
  scopeIndex: ScopeIndex,
  bindingName: string,
  currentNode: SyntaxNodeLike,
  support: LanguageSupport,
): Binding | null {
  if (support.id === "csharp" && bindingName.includes(".")) {
    const names = bindingName.split(".");
    const first = names.shift()!;
    let owner = findClosestScopeBinding(scopeIndex, first, currentNode, support);
    for (const name of names) {
      if (owner?.kind !== "class") return null;
      const body = owner.node?.parent?.childForFieldName("body");
      if (!body) return null;
      const bodyScope = scopeIndex.allScopes.find((scope) => scope.node.id === body.id);
      owner = bodyScope?.map.get(support.normalizeIdentifier(name)) ?? null;
    }
    return owner;
  }
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

  const row = scopeNodesFor(support.id);
  while (currentScope) {
    let binding: Binding | undefined = currentScope.map.get(normalizedName);
    while (binding && !bindingCoversUse(row, currentScope.kind, binding, currentNode.startIndex)) {
      binding = binding.earlierSameScope;
    }
    if (support.id === "python" && currentScope.kind === "module" && binding) {
      const effectiveBinding = effectivePythonModuleScopeBinding(binding, currentNode.startIndex);
      if (effectiveBinding) return effectiveBinding;
      currentScope = currentScope.parent;
      continue;
    }
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

function importBindingCoversIndex(imp: ImportBinding, index: number): boolean {
  const ranges: Range[] = [];
  if ((imp.kind === "named" || imp.kind === "default" || imp.kind === "namespace") && imp.localRange) {
    ranges.push(imp.localRange);
  }
  if (imp.kind === "named" && imp.importedRange) ranges.push(imp.importedRange);
  return ranges.some((range) => {
    const start = range.start.index;
    const end = range.end.index;
    return start !== undefined && end !== undefined && index >= start && index < end;
  });
}

function starImportGoTo(index: ProjectIndex, imp: ImportBinding, def: SymbolDef, name: string): GoToResult {
  return okGoToResult(index, def, {
    via: {
      ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
      exportedName: name,
    },
    resolution: "import-star",
    confidence: "medium",
  });
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
  const precedence = starImportPrecedence(support.id);
  const matchesExplicitBinding = (imp: ImportBinding): boolean => {
    if (isExpandedStarBinding(imp, mod.imports)) return false;
    if (imp.kind === "default") return support.normalizeIdentifier(imp.local) === normalizedName;
    if (imp.kind === "named") return !imp.cNamespace && support.normalizeIdentifier(imp.local) === normalizedName;
    return imp.kind === "namespace" && support.normalizeIdentifier(imp.localNS) === normalizedName;
  };
  // Explicit-beats-star languages: an explicit import, then the compilation unit (Java and
  // Kotlin same-package peers), then a wildcard. resolveExport's compilation-unit hit must wait
  // until explicit imports have had a chance to win and must still beat star imports. In Rust a
  // `use` and a same-named local item are a compile error, so the order changes nothing there.
  const deferCompilationUnitPeers = precedence === "explicit-beats-star";
  if (!suppressCppUnqualifiedLocalExport) {
    if (directExport && directExport.type === "local") {
      hit = { kind: "resolved", def: directExport.target };
    } else if (!deferCompilationUnitPeers) {
      hit = resolveExport(index, file, name, {
        allowLocalFallback: support.membersAreImplicitlyInScope,
        ...(cNamespace ? { cNamespace } : {}),
        ...(support.id === "csharp" && referenceIndex !== undefined ? { referenceIndex } : {}),
      });
    }
  }
  const effectiveBinding = effectiveExplicitOrLocalBinding(
    mod.imports,
    support.id,
    matchesExplicitBinding,
    hit?.kind === "resolved" ? hit.def.range.start.index : undefined,
    referenceIndex,
  );
  const effectiveExplicitImport = effectiveBinding?.kind === "explicit" ? effectiveBinding.binding : undefined;
  if (hit?.kind === "resolved" && (!requiresExplicitReceiver || !hit.def.isMember)) {
    const sameFileCOrCppFallback =
      (support.id === "c" || support.id === "cpp") &&
      referenceIndex !== undefined &&
      fileIdentityKey(file) === fileIdentityKey(hit.def.file);
    if (sameFileCOrCppFallback && !fileScopeDefinitionCoversUse(support.id, hit.def.range, referenceIndex)) {
      return null;
    }
    if (support.id !== "python" || effectiveBinding?.kind === "local") {
      const importedFrom =
        support.id === "c" && fileIdentityKey(file) !== fileIdentityKey(hit.def.file) ? hit.def.file : undefined;
      return okGoToResult(index, hit.def, {
        via: { exportedName: name, ...(importedFrom ? { importedFrom } : {}) },
        resolution: importedFrom ? "import" : "exact",
        confidence: "high",
      });
    }
  }
  if (hit?.kind === "namespace" && effectiveBinding?.kind !== "explicit") {
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

  const starCandidates: StarImportCandidate[] = [];
  let lastWinsResult: GoToResult | null = null;
  const acceptBinding = (result: GoToResult, imp: ImportBinding): GoToResult | null => {
    // A click on the binding's own token names that import, not a later rebinding.
    if (precedence === "last-wins" && referenceIndex !== undefined && importBindingCoversIndex(imp, referenceIndex)) {
      return result;
    }
    if (precedence === "last-wins") {
      lastWinsResult = result;
      return null;
    }
    return result;
  };

  for (const imp of mod.imports) {
    // Star expansion republishes the same names. Judging those copies as explicit
    // imports would hide a second star import behind the first expanded binding.
    if (isExpandedStarBinding(imp, mod.imports)) continue;
    const matchesExplicit = matchesExplicitBinding(imp);
    if (matchesExplicit && effectiveExplicitImport !== imp) continue;

    let matched: GoToResult | null = null;
    if (imp.kind === "default" && support.normalizeIdentifier(imp.local) === normalizedName) {
      const result = resolveImported(index, imp, "default");
      if (result && !("namespace" in result)) {
        matched = okGoToResult(index, result, {
          via: {
            ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
            exportedName: "default",
          },
          resolution: "import",
          confidence: "high",
        });
      }
    } else if (imp.kind === "named" && support.normalizeIdentifier(imp.local) === normalizedName) {
      const phpRole = phpNamedImportRole(imp);
      let result: SymbolDef | { namespace: FileId } | null;
      if (phpRole) {
        // This role-blind fallback cannot choose between PHP class, function, and constant aliases.
        const hasPhpRoleCollision = mod.imports.some(
          (candidate) =>
            candidate !== imp &&
            candidate.kind === "named" &&
            phpNamedImportRole(candidate) !== undefined &&
            support.normalizeIdentifier(candidate.local) === normalizedName,
        );
        if (hasPhpRoleCollision) {
          result = null;
        } else {
          result = resolvePhpExplicitImport(index, imp, phpRole);
        }
      } else {
        result = resolveImported(index, imp, imp.imported, cNamespace ? { cNamespace } : undefined);
      }
      if (result && !("namespace" in result)) {
        matched = okGoToResult(index, result, {
          via: {
            ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
            exportedName: imp.imported,
          },
          resolution: "import",
          confidence: "high",
        });
      }
    } else if (imp.kind === "star") {
      const def = resolveStarImportedDefinition(index, imp, name, support.id, cNamespace);
      if (def) {
        const starResult = starImportGoTo(index, imp, def, name);
        if (precedence === "last-wins") {
          const taken = acceptBinding(starResult, imp);
          if (taken) return taken;
        } else {
          starCandidates.push({ imp, def });
        }
      }
    } else if (imp.kind === "namespace" && support.normalizeIdentifier(imp.localNS) === normalizedName) {
      const targetFile = typeof imp.resolved === "string" ? normalizePath(imp.resolved) : undefined;
      if (imp.mechanism === "cjs" && targetFile) {
        const classValue = cjsRequireValueBinding(index, targetFile);
        if (classValue) {
          matched = okGoToResult(index, classValue, {
            via: {
              ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
              exportedName: classValue.localName,
            },
            resolution: "import",
            confidence: "high",
          });
        }
      }
      if (!matched) {
        const targetMod = targetFile ? index.byFile.get(fileIdentityKey(targetFile)) : undefined;
        const firstExport = targetMod?.exports.find((entry) => entry.type === "local");
        if (firstExport) {
          matched = okGoToResult(index, firstExport.target, {
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

    if (!matched) {
      if (matchesExplicit && effectiveExplicitImport === imp) {
        if (precedence !== "last-wins") return null;
        lastWinsResult = null;
      }
      continue;
    }
    const taken = acceptBinding(matched, imp);
    if (taken) return taken;
  }

  // A local binding name always wins above so a grouped import's own aliases never collide with
  // each other. An aliased import's source spelling is not itself a bound name anywhere in the
  // file (Python: `from a import helper as h` binds only `h`; a bare `helper()` elsewhere is
  // unbound and must stay not_found), so only resolve it when the click falls inside that exact
  // import statement's own source-name token, never by re-matching the spelling anywhere else.
  if (referenceIndex !== undefined) {
    for (const imp of mod.imports) {
      if (
        imp.kind !== "named" ||
        imp.local === imp.imported ||
        support.normalizeIdentifier(imp.imported) !== normalizedName ||
        !imp.importedRange ||
        imp.importedRange.start.index === undefined ||
        imp.importedRange.end.index === undefined ||
        referenceIndex < imp.importedRange.start.index ||
        referenceIndex >= imp.importedRange.end.index
      ) {
        continue;
      }
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
    }
  }

  if (precedence === "last-wins") {
    if (lastWinsResult) return lastWinsResult;
  } else {
    if (deferCompilationUnitPeers) {
      const unitHit = resolveExport(index, file, name, {
        allowLocalFallback: support.membersAreImplicitlyInScope,
      });
      if (unitHit?.kind === "resolved" && (!requiresExplicitReceiver || !unitHit.def.isMember)) {
        return okGoToResult(index, unitHit.def, {
          via: { exportedName: name },
          resolution: "exact",
          confidence: "high",
        });
      }
      if (unitHit?.kind === "namespace") {
        const targetMod = index.byFile.get(fileIdentityKey(unitHit.file));
        const firstExport = targetMod?.exports.find((entry) => entry.type === "local");
        if (firstExport) {
          return okGoToResult(index, firstExport.target, {
            via: { exportedName: name },
            resolution: "namespace",
            confidence: "medium",
          });
        }
      }
    }
    if (!starCandidates.length) return null;
    const decision = decideStarImportCandidates(index, support.id, starCandidates, file);
    if (decision.status === "ambiguous") {
      return { status: "not_found", reason: AMBIGUOUS_STAR_IMPORT_REASON };
    }
    if (decision.status === "resolved") {
      return starImportGoTo(index, decision.imp, decision.definition, name);
    }
  }

  return null;
}
