import { type LanguageSupport } from "../languages.js";
import type { JsLanguage, SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { ensureParsedContext } from "./parse-context.js";
import { resolveMemberAccessDefinition } from "./navigation-goto.js";
import {
  getPhpQualifiedReference,
  inferPhpQualifiedReferenceImportType,
  normalizePhpQualifiedReference,
  readPhpNamespaceFromRange,
} from "./navigation-php.js";
import { resolveExport, resolveImported } from "./navigation-resolve.js";
import { extractEnclosingBlock, extractLineContext, rangeContains, sameDef } from "./reference-context.js";
import { DEFAULT_REF_CONTEXT_LINES } from "./shared.js";
import { buildScopeIndexFromSource, type ScopeIndex } from "./scope.js";
import { type FileId, type Range } from "../types.js";
import { resolveImportSpecifier, sliceText, toRange } from "../util.js";
import {
  type GoToRequest,
  type GoToResult,
  type ModuleIndex,
  type ProjectIndex,
  type Reference,
  type ResolvedExport,
  type SymbolDef,
  SymbolKind,
} from "./types.js";

export { resolveExport, resolveImported } from "./navigation-resolve.js";

export async function goToDefinition(index: ProjectIndex, req: GoToRequest): Promise<GoToResult> {
  const { file, line, column } = req;
  const mod = index.byFile.get(file);
  if (!mod) return { status: "not_found", reason: "File not indexed" };

  const parsedEntry = index.parsed?.get(file);
  const context = await ensureParsedContext(file, parsedEntry);
  const sup = context.sup;
  const lang = context.lang;
  const source = context.source;
  const tree = context.tree;

  const pos = {
    row: Math.max(0, line - 1),
    column: Math.max(0, column - 1),
  };
  let node: SyntaxNodeLike | null = tree.rootNode.descendantForPosition(pos, pos);

  if (node && node.type === "variable_declarator") {
    const value = node.childForFieldName("value");
    if (value && value.type === "call_expression") {
      let callee = value.childForFieldName("function");
      if (!callee) callee = value.childForFieldName("callee");
      if (!callee) callee = value.child(0);
      if (callee && sup.nodeTypes.identifier.includes(callee.type)) {
        node = callee;
      }
    }
  }

  while (node && (node.type === "," || node.type === ".")) node = node.parent;
  if (!node) return { status: "not_found", reason: "No node at position" };

  const isId = sup.nodeTypes.identifier.includes(node.type);
  let name: string | null = isId ? sliceText(node, source) : null;
  const phpQualifiedReference = sup.id === "php" ? getPhpQualifiedReference(node, source) : null;

  if (!name) {
    const findDeclNameNode = (currentNode: SyntaxNodeLike | null): SyntaxNodeLike | null => {
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
    };
    const declNameNode = findDeclNameNode(node);
    if (declNameNode) {
      name = sliceText(declNameNode, source);
    }
  }

  if (sup.supportsCrossModuleSymbols) {
    const memberAccessResult = await resolveMemberAccessDefinition({
      index,
      mod,
      node,
      source,
      sup,
    });
    if (memberAccessResult) {
      return memberAccessResult;
    }
  }

  if (sup.id === "php" && phpQualifiedReference && index.projectRoot) {
    const normalizedQualifiedReference = normalizePhpQualifiedReference(phpQualifiedReference, source, tree, node);
    if (normalizedQualifiedReference?.includes("\\")) {
      const phpImportType = inferPhpQualifiedReferenceImportType(node);
      const resolvedTarget = await resolveImportSpecifier(
        index.projectRoot,
        file,
        normalizedQualifiedReference,
        "php",
        {
          ...(phpImportType ? { phpImportType } : {}),
        },
      );
      if (typeof resolvedTarget === "string") {
        const exportedName = normalizedQualifiedReference.split("\\").filter(Boolean).pop() ?? null;
        if (exportedName) {
          let preferredKind: SymbolKind | undefined;
          if (phpImportType === "function") {
            preferredKind = SymbolKind.Function;
          } else if (phpImportType === "class") {
            preferredKind = SymbolKind.Class;
          }
          const hit = resolveExport(index, resolvedTarget, exportedName, {
            ...(preferredKind ? { preferredKind } : {}),
          });
          if (hit?.kind === "resolved") {
            return {
              status: "ok",
              definition: hit.def,
              via: { importedFrom: resolvedTarget, exportedName },
            };
          }
        }
      }
    }
  }

  if (name) {
    let scopeIndex = index.scopeCache.get(file);
    if (!scopeIndex) {
      scopeIndex = buildScopeIndexFromSource(file, source, sup, lang, mod.imports, { tree });
      index.scopeCache.set(file, scopeIndex);
    }

    const findClosestBinding = (bindingName: string, currentNode: SyntaxNodeLike): SymbolDef | null => {
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
    };

    const local = findClosestBinding(name, node);
    if (local) {
      return { status: "ok", definition: local };
    }

    if (sup.supportsCrossModuleSymbols) {
      const hit = resolveExport(index, file, name);
      if (hit?.kind === "resolved") {
        return {
          status: "ok",
          definition: hit.def,
          via: { exportedName: name },
        };
      }
      if (hit?.kind === "namespace") {
        const targetFile = hit.file;
        const targetMod = index.byFile.get(targetFile);
        if (targetMod) {
          const firstExport = targetMod.exports.find((entry) => entry.type === "local");
          if (firstExport) {
            return {
              status: "ok",
              definition: firstExport.target,
              via: { exportedName: name },
            };
          }
        }
      }

      for (const imp of mod.imports) {
        if (imp.kind === "default" && imp.local === name) {
          const result = resolveImported(index, imp, "default");
          if (result) {
            const target = "namespace" in result ? null : result;
            if (target) {
              return {
                status: "ok",
                definition: target,
                via: {
                  ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
                  exportedName: "default",
                },
              };
            }
          }
        } else if (imp.kind === "named" && imp.local === name) {
          const result = resolveImported(index, imp, imp.imported);
          if (result) {
            const target = "namespace" in result ? null : result;
            if (target) {
              return {
                status: "ok",
                definition: target,
                via: {
                  ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
                  exportedName: imp.imported,
                },
              };
            }
          }
        } else if (imp.kind === "star") {
          const result = resolveImported(index, imp, name);
          if (result) {
            const target = "namespace" in result ? null : result;
            if (target) {
              return {
                status: "ok",
                definition: target,
                via: {
                  ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
                  exportedName: name,
                },
              };
            }
          }
        } else if (imp.kind === "namespace" && imp.localNS === name) {
          const targetFile = typeof imp.resolved === "string" ? imp.resolved.replace(/\\/g, "/") : undefined;
          if (targetFile) {
            const targetMod = index.byFile.get(targetFile);
            if (targetMod) {
              const firstExport = targetMod.exports.find((entry) => entry.type === "local");
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
        }
      }
    }
  }

  return {
    status: "not_found",
    reason: "No matching local or imported definition",
  };
}

function toModuleRef(resolved?: FileId | { external: string }): string | undefined {
  if (!resolved) return undefined;
  return typeof resolved === "string" ? resolved : resolved.external;
}

export async function findReferences(
  index: ProjectIndex,
  req: { file: FileId; line: number; column: number } | { def: SymbolDef },
  opts?: {
    context?: "line" | "block";
    lines?: number;
    blockMaxLines?: number;
    maxReferences?: number;
  },
): Promise<{ status: "ok"; definition: SymbolDef; references: Reference[] } | { status: "not_found"; reason: string }> {
  let def: SymbolDef | null = null;
  if ("def" in req) {
    def = req.def;
  } else {
    const module = index.byFile.get(req.file);
    const localAtPosition = module?.locals.find((local) =>
      rangeContains(local.range, {
        row: req.line,
        column: req.column,
      }),
    );
    if (localAtPosition) {
      def = localAtPosition;
    } else {
      const gotoResult = await goToDefinition(index, req);
      if (gotoResult.status === "ok") def = gotoResult.definition;
    }
  }
  if (!def) {
    return { status: "not_found", reason: "Could not resolve definition" };
  }

  const definitionFile = def.file;
  const parsedDef = index.parsed?.get(definitionFile);
  const parsedContext = await ensureParsedContext(definitionFile, parsedDef);
  const getCachedScope = (
    fileId: string,
    moduleIndex: ModuleIndex,
    parsedCtx: {
      source: string;
      sup: LanguageSupport;
      lang?: JsLanguage;
      tree: SyntaxTreeLike;
    },
  ): ScopeIndex => {
    if (index.scopeCache.has(fileId)) return index.scopeCache.get(fileId)!;
    const scopeIndex = buildScopeIndexFromSource(
      fileId,
      parsedCtx.source,
      parsedCtx.sup,
      parsedCtx.lang,
      moduleIndex.imports,
      {
        tree: parsedCtx.tree,
      },
    );
    index.scopeCache.set(fileId, scopeIndex);
    return scopeIndex;
  };

  const mod = index.byFile.get(definitionFile);
  if (!mod) return { status: "not_found", reason: "Module not found" };

  const scope = getCachedScope(definitionFile, mod, parsedContext);
  const refs: Reference[] = [];
  const maxReferences =
    typeof opts?.maxReferences === "number" && opts.maxReferences > 0 ? opts.maxReferences : undefined;
  const seenRefs = new Set<string>();
  const hasReachedMaxReferences = (): boolean => maxReferences !== undefined && refs.length >= maxReferences;
  const pushRef = (ref: Reference): void => {
    const key = `${ref.file}:${ref.range.start.line}:${ref.range.start.column}`;
    if (seenRefs.has(key)) return;
    seenRefs.add(key);
    refs.push(ref);
  };

  const localBindings = scope.bindings.get(def.localName) ?? [];
  const localBinding = localBindings.find(
    (binding) => binding.def && binding.def.start.index === def.range.start.index,
  );
  pushRef({ file: definitionFile, range: def.range });
  if (localBinding) {
    for (const occurrence of localBinding.occurrences) {
      if (hasReachedMaxReferences()) break;
      pushRef({ file: definitionFile, range: occurrence });
    }
  }

  const exportedNames: string[] = [];
  for (const entry of mod.exports) {
    if (entry.type === "local" && sameDef(entry.target, def)) {
      exportedNames.push(entry.exportedAs);
    }
  }
  if (!exportedNames.length) {
    exportedNames.push(def.localName);
  }

  const exportedNameSet = new Set(exportedNames);
  let phpQualifiedNames: string[] = [];
  try {
    const definitionParsed = await ensureParsedContext(definitionFile, index.parsed?.get(definitionFile));
    phpQualifiedNames =
      definitionParsed.sup.id === "php"
        ? (() => {
            const phpNamespace = readPhpNamespaceFromRange(definitionParsed.tree, definitionParsed.source, def.range);
            if (!phpNamespace) return [];
            const qualifiedName = `${phpNamespace}\\${def.localName}`;
            return [qualifiedName, `\\${qualifiedName}`];
          })()
        : [];
  } catch {
    phpQualifiedNames = [];
  }

  const collectNamedNodeReferences = async (fileId: string, symbolName: string): Promise<Range[]> => {
    try {
      const parsedEntry = index.parsed?.get(fileId);
      const parsed = await ensureParsedContext(fileId, parsedEntry);
      const identifierTypes = new Set<string>([
        ...parsed.sup.nodeTypes.identifier,
        ...(parsed.sup.nodeTypes.propertyIdentifier ?? []),
        "constant",
        "type_identifier",
        "field_identifier",
      ]);
      const matches: Range[] = [];
      const walk = (node: SyntaxNodeLike): void => {
        if (identifierTypes.has(node.type) && sliceText(node, parsed.source) === symbolName) {
          matches.push(toRange(node));
        }
        for (const child of node.namedChildren) {
          walk(child);
        }
      };
      walk(parsed.tree.rootNode);
      return matches;
    } catch {
      return [];
    }
  };

  const collectVerifiedNamedNodeReferences = async (
    fileId: string,
    symbolName: string,
    expectedDef: SymbolDef,
    maxVerified?: number,
  ): Promise<Range[]> => {
    const matches = await collectNamedNodeReferences(fileId, symbolName);
    const verified: Range[] = [];
    for (const range of matches) {
      if (maxVerified !== undefined && maxVerified > 0 && verified.length >= maxVerified) {
        break;
      }
      const resolved = await goToDefinition(index, {
        file: fileId,
        line: range.start.line,
        column: range.start.column,
      });
      if (resolved.status !== "ok") continue;
      if (sameDef(resolved.definition, expectedDef)) {
        verified.push(range);
      }
    }
    return verified;
  };

  const getCandidateReferenceNames = (module: ModuleIndex): string[] => {
    const names = new Set<string>();
    let hasDirectImport = false;

    for (const imp of module.imports) {
      const resolved = typeof imp.resolved === "string" ? imp.resolved : undefined;
      if (!resolved || resolved !== definitionFile) continue;
      hasDirectImport = true;

      if (imp.kind === "named") {
        if (exportedNameSet.has(imp.imported)) names.add(imp.local);
      } else if (imp.kind === "default") {
        if (exportedNameSet.has("default")) names.add(imp.local);
      } else if (imp.kind === "namespace" || imp.kind === "star") {
        for (const name of exportedNameSet) {
          names.add(name);
        }
      }
    }

    if (!hasDirectImport) return [];
    return Array.from(names);
  };

  const hasExpandedNamedImport = (module: ModuleIndex, targetFile: string, symbolName: string): boolean =>
    module.imports.some(
      (candidate) =>
        candidate.kind === "named" &&
        candidate.local === symbolName &&
        candidate.imported === symbolName &&
        candidate.resolved === targetFile,
    );

  let candidateFiles = Array.from(index.byFile.keys()).filter((candidateFile) => candidateFile !== definitionFile);
  candidateFiles.sort((left, right) => left.localeCompare(right));
  if (index.bloomFilters && exportedNames.length > 0) {
    candidateFiles = candidateFiles.filter((candidateFile) => {
      const module = index.byFile.get(candidateFile);
      if (!module) return true;
      const filter = index.bloomFilters?.get(candidateFile);
      if (!filter) return true;

      const aliases = getCandidateReferenceNames(module);
      if (aliases.length === 0) {
        return exportedNames.some((exportedName) => filter.mightContain(exportedName));
      }
      return aliases.some((alias) => filter.mightContain(alias));
    });
  }

  for (const fileId of candidateFiles) {
    if (hasReachedMaxReferences()) break;
    const module = index.byFile.get(fileId);
    if (!module) continue;

    let scopeIndex: ScopeIndex | null = null;
    const ensureScope = async (): Promise<ScopeIndex> => {
      if (!scopeIndex) {
        const parsedEntry = index.parsed?.get(fileId);
        const parsed = await ensureParsedContext(fileId, parsedEntry);
        scopeIndex = getCachedScope(fileId, module, parsed);
      }
      return scopeIndex;
    };

    for (const imp of module.imports) {
      if (hasReachedMaxReferences()) break;
      const targetFile = typeof imp.resolved === "string" ? imp.resolved : undefined;
      if (!targetFile) continue;

      for (const exportedName of exportedNames) {
        if (hasReachedMaxReferences()) break;
        if (imp.kind === "namespace") {
          const hit = resolveExport(index, targetFile, exportedName);
          const matchesDef = hit?.kind === "resolved" ? sameDef(hit.def, def) : targetFile === definitionFile;
          if (!matchesDef) continue;
          await ensureScope();
          const ranges = await collectNamespaceMemberRefs(fileId, imp.localNS, exportedName);
          for (const range of ranges) {
            if (hasReachedMaxReferences()) break;
            pushRef({
              file: fileId,
              range,
              via: { import: imp, namespaceMember: exportedName },
            });
          }
        } else if (imp.kind === "star") {
          const result = resolveImported(index, imp, exportedName);
          const matchesDef = !!result && !("namespace" in result) && sameDef(result, def);
          if (!matchesDef) continue;
          if (hasExpandedNamedImport(module, targetFile, exportedName)) {
            continue;
          }
          const remainingReferences =
            maxReferences !== undefined ? Math.max(0, maxReferences - refs.length) : undefined;
          const ranges = await collectVerifiedNamedNodeReferences(fileId, exportedName, def, remainingReferences);
          for (const range of ranges) {
            if (hasReachedMaxReferences()) break;
            pushRef({ file: fileId, range, via: { import: imp } });
          }
        } else {
          let exported = exportedName;
          if (imp.kind === "named") {
            exported = imp.imported;
          } else if (imp.kind === "default") {
            exported = "default";
          }
          const hit = resolveExport(index, targetFile, exported);
          const matchesDef = hit?.kind === "resolved" ? sameDef(hit.def, def) : targetFile === definitionFile;
          if (!matchesDef) continue;
          const resolvedScope = await ensureScope();
          const localName = imp.local;
          const bindings = resolvedScope.bindings.get(localName) ?? [];
          for (const binding of bindings) {
            if (binding.import === imp) {
              for (const occurrence of binding.occurrences) {
                if (hasReachedMaxReferences()) break;
                pushRef({ file: fileId, range: occurrence, via: { import: imp } });
              }
            }
          }
        }
      }
    }

    if (phpQualifiedNames.length > 0) {
      const remainingReferences = maxReferences !== undefined ? Math.max(0, maxReferences - refs.length) : undefined;
      for (const candidateName of [...exportedNames, ...phpQualifiedNames]) {
        if (hasReachedMaxReferences()) break;
        const ranges = await collectVerifiedNamedNodeReferences(fileId, candidateName, def, remainingReferences);
        for (const range of ranges) {
          if (hasReachedMaxReferences()) break;
          pushRef({ file: fileId, range });
        }
      }
    }
  }

  refs.sort((left, right) => {
    if (left.file === right.file) {
      const leftIndex = left.range.start.index ?? 0;
      const rightIndex = right.range.start.index ?? 0;
      return leftIndex - rightIndex;
    }
    return left.file.localeCompare(right.file);
  });

  if (opts?.context) {
    const perFileCache = new Map<string, { source: string; tree: SyntaxTreeLike; sup: LanguageSupport }>();

    for (const ref of refs) {
      let cached = perFileCache.get(ref.file);
      if (!cached) {
        const parsedEntry = index.parsed?.get(ref.file);
        const parsed = await ensureParsedContext(ref.file, parsedEntry);
        cached = { source: parsed.source, tree: parsed.tree, sup: parsed.sup };
        perFileCache.set(ref.file, cached);
      }

      if (opts.context === "line") {
        const lines = opts.lines ?? DEFAULT_REF_CONTEXT_LINES;
        ref.context = extractLineContext(cached.source, ref.range.start.line, lines);
      } else if (opts.context === "block") {
        const maxLines = opts.blockMaxLines ?? 60;
        ref.context = extractEnclosingBlock(cached.source, cached.tree, ref.range, maxLines, cached.sup);
      }
    }
  }

  return { status: "ok", definition: def, references: refs };
}

export async function collectNamespaceMemberRefs(file: string, ns: string, member: string): Promise<Range[]> {
  const parsed = await ensureParsedContext(file, undefined);
  const sup = parsed.sup;
  const source = parsed.source;
  const tree = parsed.tree;
  const ranges: Range[] = [];
  const isRuby = sup.id === "ruby";
  let memberExpressionType = sup.nodeTypes.memberExpression;
  if (!memberExpressionType) {
    if (sup.id === "python") {
      memberExpressionType = "attribute";
    } else if (sup.id === "ruby") {
      memberExpressionType = "call";
    } else {
      memberExpressionType = "member_expression";
    }
  }
  const isPropertyIdentifier = (nodeType: string): boolean =>
    (sup.nodeTypes.propertyIdentifier ?? ["property_identifier"]).includes(nodeType) ||
    nodeType === "field_identifier" ||
    nodeType === "type_identifier" ||
    nodeType === "identifier" ||
    nodeType === "constant";
  const isObjectIdentifier = (nodeType: string): boolean =>
    nodeType === "identifier" ||
    nodeType === "type_identifier" ||
    nodeType === "package_identifier" ||
    nodeType === "constant" ||
    nodeType === "namespace_identifier";

  const walk = (node: SyntaxNodeLike): void => {
    if (
      node.type === memberExpressionType ||
      (sup.id === "go" && node.type === "qualified_type") ||
      (isRuby && (node.type === "call" || node.type === "scope_resolution"))
    ) {
      let obj: SyntaxNodeLike | null = null;
      let prop: SyntaxNodeLike | null = null;
      if (isRuby) {
        if (node.type === "scope_resolution") {
          obj = node.childForFieldName("scope") ?? node.child(0);
          prop = node.childForFieldName("name") ?? node.child(2);
        } else {
          obj = node.childForFieldName("receiver") ?? node.child(0);
          prop = node.childForFieldName("method") ?? node.child(2);
        }
      } else if (sup.id === "go" && node.type === "qualified_type") {
        obj = node.namedChildren[0] ?? node.child(0);
        prop = node.namedChildren[1] ?? node.child(1);
      } else {
        obj = node.childForFieldName("object") ?? node.child(0);
        prop = node.childForFieldName("property") ?? node.childForFieldName("attribute") ?? node.child(2);
      }
      if (obj && prop && isObjectIdentifier(obj.type) && isPropertyIdentifier(prop.type)) {
        const objectName = sliceText(obj, source);
        const propertyName = sliceText(prop, source);
        if (objectName === ns && propertyName === member) {
          ranges.push(toRange(node));
        }
      }
    }
    for (const child of node.namedChildren) {
      walk(child);
    }
  };

  walk(tree.rootNode);
  return ranges;
}
