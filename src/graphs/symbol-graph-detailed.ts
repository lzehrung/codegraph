import { isJsFallbackAvailable, parseWithJsLanguage } from "../jsFallback.js";
import { type LanguageSupport } from "../languages.js";
import { isUnsupportedParserInputError, prepareSourceInput } from "../languages/filePrep.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { logWithLevel, type LogLevel } from "../logging.js";
import { ProjectedSyntaxTree } from "../native/projectedTree.js";
import { getNativeSyntaxTreeExecution } from "../native/treeSitterNative.js";
import { SymbolKind, type ImportBinding, type ProjectIndex, type ResolvedExport, type SymbolDef } from "../indexer/types.js";
import type { FileId } from "../types.js";
import { sliceText, unquote } from "../util.js";
import { buildSymbolGraph, defNodeId, nodeForDef, type SymbolGraph } from "./symbol-graph.js";

type BuildDetailedSymbolGraphOptions = {
  scope?: "all" | "imported";
  files?: Set<FileId>;
  maxEdges?: number;
  membersOnly?: boolean;
  logLevel?: LogLevel;
};

type ResolvedDetailedExport = ResolvedExport;

const normalizePath = (file: string) => file.replace(/\\/g, "/");

const isIdentifierType = (sup: LanguageSupport, type: string) =>
  Array.isArray(sup.nodeTypes?.identifier) && sup.nodeTypes.identifier.includes(type);

export async function buildSymbolGraphDetailed(
  index: ProjectIndex,
  opts?: BuildDetailedSymbolGraphOptions,
): Promise<SymbolGraph> {
  const base = await buildSymbolGraph(index);
  const nodes = new Map(base.nodes);
  const edges = base.edges.slice();
  let skippedSyntaxTreeFiles = 0;

  const added = new Set<string>();
  const maxEdges = typeof opts?.maxEdges === "number" && opts.maxEdges > 0 ? opts.maxEdges : Number.POSITIVE_INFINITY;
  const membersOnly = !!opts?.membersOnly;
  const scopeMode = opts?.scope ?? "all";

  const importedByOthers = new Set<string>();
  if (scopeMode === "imported") {
    for (const [, moduleEntry] of index.byFile) {
      for (const imp of moduleEntry.imports) {
        const target = typeof imp.resolved === "string" ? normalizePath(imp.resolved) : undefined;
        if (target) importedByOthers.add(target);
      }
    }
  }

  let edgeCount = edges.length;
  const maybePushEdge = (fromId: string, toId: string, label?: string) => {
    if (edgeCount >= maxEdges) return false;
    edges.push(label ? { from: fromId, to: toId, label } : { from: fromId, to: toId });
    edgeCount++;
    return true;
  };
  const recordEdge = (fromId: string, toId: string, label?: string) => {
    const key = `${fromId}->${toId}::${label ?? ""}`;
    if (added.has(key)) return true;
    added.add(key);
    return maybePushEdge(fromId, toId, label);
  };

  const resolveExportNamespace = (
    file: string,
    exportedName: string,
    cache: Map<string, ResolvedDetailedExport | null> = new Map(),
  ): ResolvedDetailedExport | null => {
    const normalizedFile = normalizePath(file);
    const key = `${normalizedFile}::${exportedName}`;
    if (cache.has(key)) return cache.get(key) ?? null;
    cache.set(key, null);
    const moduleEntry = index.byFile.get(normalizedFile);
    if (!moduleEntry) {
      return null;
    }

    for (const exportEntry of moduleEntry.exports) {
      if (exportEntry.type === "local" && exportEntry.exportedAs === exportedName) {
        const resolved: ResolvedDetailedExport = { kind: "resolved", def: exportEntry.target };
        cache.set(key, resolved);
        return resolved;
      }
    }

    for (const exportEntry of moduleEntry.exports) {
      if (exportEntry.type === "namespaceReexport" && exportEntry.exportedAs === exportedName) {
        const resolved: ResolvedDetailedExport = {
          kind: "namespace",
          file: normalizePath(exportEntry.fromModule),
        };
        cache.set(key, resolved);
        return resolved;
      }
    }

    for (const exportEntry of moduleEntry.exports) {
      if (
        exportEntry.type === "reexport" &&
        exportEntry.exportedAs === exportedName &&
        typeof exportEntry.fromModule === "string"
      ) {
        const resolved =
          resolveExportNamespace(exportEntry.fromModule, exportEntry.sourceSpecifier || exportedName, cache) ??
          resolveExportNamespace(exportEntry.fromModule, exportedName, cache);
        if (resolved) {
          cache.set(key, resolved);
          return resolved;
        }
      }
    }

    for (const exportEntry of moduleEntry.exports) {
      if (exportEntry.type === "exportStar" && typeof exportEntry.fromModule === "string") {
        const resolved = resolveExportNamespace(exportEntry.fromModule, exportedName, cache);
        if (resolved) {
          cache.set(key, resolved);
          return resolved;
        }
      }
    }

    const local = moduleEntry.locals.find((entry) => entry.localName === exportedName);
    if (local) {
      const resolved: ResolvedDetailedExport = { kind: "resolved", def: local };
      cache.set(key, resolved);
      return resolved;
    }

    cache.set(key, null);
    return null;
  };

  const resolveExportDef = (
    file: string,
    exportedName: string,
    cache?: Map<string, ResolvedDetailedExport | null>,
  ): SymbolDef | null => {
    const resolved = resolveExportNamespace(file, exportedName, cache);
    return resolved?.kind === "resolved" ? resolved.def : null;
  };

  const resolveMemberPathFromModule = (startFile: string, names: string[]): SymbolDef | null => {
    let file: string | null = normalizePath(startFile);
    let targetDef: SymbolDef | null = null;
    for (const segment of [...names].reverse()) {
      if (!file) break;
      const resolved = resolveExportNamespace(file, segment);
      if (!resolved) {
        targetDef = null;
        break;
      }
      if (resolved.kind === "namespace") {
        file = normalizePath(resolved.file);
        targetDef = null;
        continue;
      }
      targetDef = resolved.def;
      file = normalizePath(targetDef.file);
    }

    if (targetDef) {
      return targetDef;
    }

    const fileKey = typeof file === "string" ? normalizePath(file) : null;
    const moduleEntry = fileKey ? index.byFile.get(fileKey) : undefined;
    const lastName = names[0];
    return moduleEntry?.locals.find((entry) => entry.localName === lastName) ?? null;
  };

  const resolveExportFrom = (
    file: string,
    exportedName: string,
    cache: Map<string, ResolvedDetailedExport | null> = new Map(),
  ): SymbolDef | null => resolveExportDef(file, exportedName, cache);

  for (const [file, moduleEntry] of index.byFile) {
    if (opts?.files && !opts.files.has(file)) continue;
    if (scopeMode === "imported") {
      const hasFuncOrClass = moduleEntry.locals.some(
        (local) => local.kind === SymbolKind.Function || local.kind === SymbolKind.Class,
      );
      const isImportedOrImports = importedByOthers.has(normalizePath(file)) || moduleEntry.imports.length > 0;
      if (!(hasFuncOrClass && isImportedOrImports)) continue;
    }
    try {
      const parsedEntry = index.parsed?.get(file);
      let sup = parsedEntry?.sup;
      let lang = parsedEntry?.lang;
      let src = parsedEntry?.source;
      let tree: SyntaxTreeLike | undefined = parsedEntry?.tree;
      if (!sup || src === undefined) {
        const prep = await prepareSourceInput(file);
        sup = prep.sup;
        src = prep.source;
      }
      if (sup && !sup.supportsCrossModuleSymbols) {
        continue;
      }
      if (sup && src !== undefined && !tree) {
        const nativeTreeExecution = getNativeSyntaxTreeExecution(src, sup, index.nativeMode);
        if (nativeTreeExecution.tree) {
          tree = new ProjectedSyntaxTree(src, nativeTreeExecution.tree);
        } else {
          if (!isJsFallbackAvailable()) {
            skippedSyntaxTreeFiles += 1;
            continue;
          }
          lang ??= sup.language(file);
          tree = parseWithJsLanguage(src, lang);
        }
      }
      if (!sup || src === undefined || !tree) {
        throw new Error(`Failed to parse ${file}`);
      }

      const aliasToTargetDef = new Map<string, SymbolDef>();
      const aliasToTargetModule = new Map<string, string>();
      const targetModOf = (imp: ImportBinding) => {
        const targetFile = typeof imp.resolved === "string" ? normalizePath(imp.resolved) : undefined;
        return targetFile ? index.byFile.get(targetFile) : undefined;
      };
      for (const imp of moduleEntry.imports) {
        if (!imp) continue;
        const targetModule = targetModOf(imp);
        const targetFile = typeof imp.resolved === "string" ? normalizePath(imp.resolved) : undefined;
        if (!targetModule || !targetFile) continue;
        if (imp.kind === "named") {
          const localFallback = targetModule.locals.find((local) => local.localName === imp.imported);
          const resolved =
            resolveExportNamespace(targetFile, imp.imported) ??
            (localFallback
              ? {
                  kind: "resolved" as const,
                  def: localFallback,
                }
              : null);
          if (resolved?.kind === "resolved") {
            aliasToTargetDef.set(imp.local, resolved.def);
          } else if (resolved?.kind === "namespace") {
            aliasToTargetModule.set(imp.local, normalizePath(resolved.file));
          }
        } else if (imp.kind === "default") {
          const defaultExport = resolveExportFrom(targetFile, "default");
          const fallbackExport = targetModule.exports.find((entry) => entry.type === "local")?.target;
          const def = defaultExport ?? fallbackExport;
          if (def) aliasToTargetDef.set(imp.local, def);
          aliasToTargetModule.set(imp.local, targetFile);
        } else if (imp.kind === "namespace") {
          aliasToTargetModule.set(imp.localNS, targetFile);
        }
      }

      const functionNodes: Array<{ name: string; node: SyntaxNodeLike; def: SymbolDef }> = [];
      const classNodes: Array<{ name: string; node: SyntaxNodeLike; def: SymbolDef }> = [];
      const constStringOf = new Map<string, string>();
      const collectConsts = (node: SyntaxNodeLike) => {
        if (node.type === "variable_declarator") {
          const nameNode = node.childForFieldName("name");
          const valueNode = node.childForFieldName("value");
          if (nameNode && valueNode && valueNode.type === "string") {
            const name = sliceText(nameNode, src);
            const value = unquote(sliceText(valueNode, src));
            constStringOf.set(name, value);
          }
        }
        for (const child of node.namedChildren) collectConsts(child);
      };
      collectConsts(tree.rootNode);

      const memberExpressionType = sup.nodeTypes.memberExpression ?? "member_expression";
      const propertyIdentifierTypes: string[] = sup.nodeTypes.propertyIdentifier ?? ["property_identifier"];
      const optionalMemberTypes = new Set<string>([
        memberExpressionType,
        "optional_member_expression",
        "subscript_expression",
        "optional_chain",
        sup.id === "python" ? "attribute" : "",
      ]);
      const walkCollect = (node: SyntaxNodeLike) => {
        if (
          node.type === "function_declaration" ||
          node.type === "function_definition" ||
          node.type === "method_declaration" ||
          node.type === "constructor_declaration" ||
          node.type === "function_item" ||
          node.type === "method" ||
          node.type === "singleton_method"
        ) {
          const nameNode = node.childForFieldName("name") ?? node.childForFieldName("type");
          const name = nameNode ? sliceText(nameNode, src) : undefined;
          if (name) {
            const def = moduleEntry.locals.find((local) => local.localName === name);
            if (def) functionNodes.push({ name, node, def });
          }
        } else if (node.type === "class_declaration" || node.type === "class_definition" || node.type === "class") {
          const nameNode = node.childForFieldName("name");
          const name = nameNode ? sliceText(nameNode, src) : undefined;
          if (name) {
            const def = moduleEntry.locals.find((local) => local.localName === name);
            if (def) classNodes.push({ name, node, def });
          }
        } else if (node.type === "variable_declarator") {
          const nameNode = node.childForFieldName("name");
          const valueNode = node.childForFieldName("value");
          if (nameNode && valueNode) {
            const valueType = String(valueNode.type || "");
            if (/arrow_function|function/.test(valueType)) {
              const name = sliceText(nameNode, src);
              const def = moduleEntry.locals.find((local) => local.localName === name);
              if (def) functionNodes.push({ name, node: valueNode, def });
            }
          }
        } else if (node.type === "assignment_expression") {
          const left = node.childForFieldName("left");
          const right = node.childForFieldName("right");
          if (left && right) {
            const valueType = String(right.type || "");
            if (/arrow_function|function/.test(valueType)) {
              let name: string | null = null;
              if (left.type === memberExpressionType) {
                const prop = left.child(2);
                if (prop && propertyIdentifierTypes.includes(prop.type)) name = sliceText(prop, src);
              } else if (left.type === "identifier") {
                name = sliceText(left, src);
              }
              if (name) {
                const def = moduleEntry.locals.find((local) => local.localName === name);
                if (def) functionNodes.push({ name, node: right, def });
              }
            }
          }
        }
        for (const child of node.namedChildren) walkCollect(child);
      };
      walkCollect(tree.rootNode);

      const scanForAliasUse = (node: SyntaxNodeLike, cb: (name: string, atNode: SyntaxNodeLike) => void) => {
        if (isIdentifierType(sup, node.type)) {
          const name = sliceText(node, src);
          cb(name, node);
        }
        for (const child of node.namedChildren) scanForAliasUse(child, cb);
      };

      const resolveIdentifier = (name: string): SymbolDef | null => {
        const fromAlias = aliasToTargetDef.get(name);
        if (fromAlias) return fromAlias;
        return moduleEntry.locals.find((local) => local.localName === name) ?? null;
      };

      const tryResolveNode = (node: SyntaxNodeLike, fromId: string, label: string) => {
        if (isIdentifierType(sup, node.type) || node.type === "type_identifier") {
          const name = sliceText(node, src);
          const target = resolveIdentifier(name);
          if (target) {
            const toId = defNodeId(target);
            if (!nodes.has(toId)) nodes.set(toId, nodeForDef(target));
            recordEdge(fromId, toId, label);
            return;
          }
        }
        if (optionalMemberTypes.has(node.type)) {
          tryResolveChain(node, fromId, label);
        }
      };

      const callNodeTypes = new Set<string>(["call_expression", "call", "method_invocation", "invocation_expression"]);
      const newNodeTypes = new Set<string>([
        "new_expression",
        "object_creation_expression",
        "struct_expression",
        "composite_literal",
      ]);

      const getCallTarget = (node: SyntaxNodeLike): SyntaxNodeLike | null => {
        const explicitTarget =
          node.childForFieldName("function") ??
          node.childForFieldName("callee") ??
          node.childForFieldName("name") ??
          node.childForFieldName("method") ??
          node.childForFieldName("member") ??
          node.childForFieldName("expression");
        if (explicitTarget) return explicitTarget;
        const nonArgumentChildren = node.namedChildren.filter((child) => child.type !== "argument_list");
        return nonArgumentChildren.length === 1 ? (nonArgumentChildren[0] ?? null) : null;
      };

      const getNewTarget = (node: SyntaxNodeLike) =>
        node.childForFieldName("constructor") ??
        node.childForFieldName("type") ??
        node.childForFieldName("name") ??
        node.namedChildren.find((child) => child.type === "type_identifier") ??
        node.child(0);

      const tryResolveChain = (node: SyntaxNodeLike, fromId?: string, label = "uses") => {
        const names: string[] = [];
        let current: SyntaxNodeLike | null = node;
        let base: SyntaxNodeLike | null = null;
        const pushProp = (propNode: SyntaxNodeLike | null) => {
          if (!propNode) return;
          if (propertyIdentifierTypes.includes(propNode.type)) names.push(sliceText(propNode, src));
          else if (propNode.type === "string") names.push(unquote(sliceText(propNode, src)));
          else if (propNode.type === "identifier") {
            const keyName = sliceText(propNode, src);
            const value = constStringOf.get(keyName);
            if (typeof value === "string") names.push(value);
          }
        };
        while (current && optionalMemberTypes.has(current.type)) {
          if (current.type === "subscript_expression") {
            base = current.child(0) ?? base;
            const indexNode = current.child(2);
            pushProp(indexNode);
            current = base;
          } else if (
            current.type === memberExpressionType ||
            current.type === "optional_member_expression" ||
            current.type === "attribute"
          ) {
            base = current.child(0) ?? base;
            const propNode =
              current.childForFieldName?.("property") ?? current.child(2) ?? current.childForFieldName?.("attribute");
            pushProp(propNode);
            current = base;
          } else if (current.type === "optional_chain") {
            current = current.child(0);
          } else {
            break;
          }
        }
        if (!current || !isIdentifierType(sup, current.type)) return false;
        const alias = sliceText(current, src);
        const targetFile = aliasToTargetModule.get(alias);
        if (!targetFile || names.length === 0) return false;
        const targetDef = resolveMemberPathFromModule(targetFile, names);
        if (targetDef && fromId) {
          const toId = defNodeId(targetDef);
          if (!nodes.has(toId)) nodes.set(toId, nodeForDef(targetDef));
          if (!recordEdge(fromId, toId, label)) return true;
          return true;
        }
        return !!targetDef;
      };

      if (sup.id === "python") {
        const addDecoratorUses = (node: SyntaxNodeLike) => {
          if (node.type === "decorated_definition") {
            const fn = node.namedChildren.find((child) => child.type === "function_definition");
            if (fn) addDecoratorUses(fn);
            for (const decoratorChild of node.namedChildren) {
              if (decoratorChild.type !== "decorator") continue;
              const nameNode = fn?.childForFieldName("name");
              if (!nameNode) continue;
              const name = sliceText(nameNode, src);
              const def = moduleEntry.locals.find((local) => local.localName === name);
              if (!def) continue;
              const fromId = defNodeId(def);
              if (!nodes.has(fromId)) nodes.set(fromId, nodeForDef(def));
              const expr =
                decoratorChild.childForFieldName?.("name") ??
                decoratorChild.namedChildren?.[0] ??
                decoratorChild.child(1);
              if (expr) tryResolveNode(expr, fromId, "decorates");
            }
          } else if (node.type === "function_definition") {
            const nameNode = node.childForFieldName("name");
            if (nameNode) {
              const name = sliceText(nameNode, src);
              const def = moduleEntry.locals.find((local) => local.localName === name);
              if (def) {
                const fromId = defNodeId(def);
                if (!nodes.has(fromId)) nodes.set(fromId, nodeForDef(def));
                let prev = node.previousSibling;
                while (prev) {
                  if (prev.type === "decorated_definition") {
                    for (const decoratorChild of prev.namedChildren) {
                      if (decoratorChild.type === "decorator") {
                        const expr =
                          decoratorChild.childForFieldName?.("name") ??
                          decoratorChild.namedChildren?.[0] ??
                          decoratorChild.child(1);
                        if (expr) tryResolveNode(expr, fromId, "decorates");
                      } else if (decoratorChild.type === "attribute") {
                        tryResolveNode(decoratorChild, fromId, "decorates");
                      }
                    }
                  } else if (prev.type === "decorator") {
                    const expr = prev.childForFieldName?.("name") ?? prev.namedChildren?.[0] ?? prev.child(1);
                    if (expr) tryResolveNode(expr, fromId, "decorates");
                  }
                  prev = prev.previousSibling;
                }
              }
            }
          }
          for (const child of node.namedChildren) addDecoratorUses(child);
        };
        addDecoratorUses(tree.rootNode);
      }

      for (const fn of functionNodes) {
        const fromId = defNodeId(fn.def);
        if (!nodes.has(fromId)) nodes.set(fromId, nodeForDef(fn.def));
        const seenAliases = new Set<string>();
        if (!membersOnly) {
          scanForAliasUse(fn.node, (name: string, atNode: SyntaxNodeLike) => {
            if (seenAliases.has(name)) return;
            let target: SymbolDef | null = aliasToTargetDef.get(name) ?? null;
            if (!target) {
              const modFile = aliasToTargetModule.get(name);
              if (modFile) {
                let exportedName: string | null = null;
                const parent = atNode.parent;
                if (parent && (parent.type === memberExpressionType || parent.type === "optional_member_expression")) {
                  const prop = parent.childForFieldName?.("property") ?? parent.child(2);
                  if (prop && propertyIdentifierTypes.includes(prop.type)) exportedName = sliceText(prop, src);
                }
                if (exportedName) {
                  target = resolveExportFrom(modFile, exportedName);
                  if (!target) {
                    const targetModule = index.byFile.get(modFile);
                    target = (targetModule?.locals ?? []).find((local) => local.localName === exportedName) ?? null;
                  }
                }
              }
            }
            if (!target) return;
            seenAliases.add(name);
            const toId = defNodeId(target);
            if (!nodes.has(toId)) nodes.set(toId, nodeForDef(target));
            if (!recordEdge(fromId, toId, "uses")) return;
          });
        }

        const walkForMembers = (node: SyntaxNodeLike) => {
          const tryResolveChainLocal = (chainNode: SyntaxNodeLike) => {
            const names: string[] = [];
            let current: SyntaxNodeLike | null = chainNode;
            let base: SyntaxNodeLike | null = null;
            const pushProp = (propNode: SyntaxNodeLike | null) => {
              if (!propNode) return;
              if (propertyIdentifierTypes.includes(propNode.type)) names.push(sliceText(propNode, src));
              else if (propNode.type === "string") names.push(unquote(sliceText(propNode, src)));
              else if (propNode.type === "identifier") {
                const keyName = sliceText(propNode, src);
                const value = constStringOf.get(keyName);
                if (typeof value === "string") names.push(value);
              }
            };
            while (current && optionalMemberTypes.has(current.type)) {
              if (current.type === "subscript_expression") {
                base = current.child(0) ?? base;
                const indexNode = current.child(2);
                pushProp(indexNode);
                current = base;
              } else if (
                current.type === memberExpressionType ||
                current.type === "optional_member_expression" ||
                current.type === "attribute"
              ) {
                base = current.child(0) ?? base;
                const propNode =
                  current.childForFieldName?.("property") ??
                  current.child(2) ??
                  current.childForFieldName?.("attribute");
                pushProp(propNode);
                current = base;
              } else if (current.type === "optional_chain") {
                current = current.child(0);
              } else {
                break;
              }
            }
            if (!current || !isIdentifierType(sup, current.type)) return;
            const alias = sliceText(current, src);
            const targetFile = aliasToTargetModule.get(alias);
            if (!targetFile || names.length === 0) return;
            const targetDef = resolveMemberPathFromModule(targetFile, names);
            if (targetDef) {
              const toId = defNodeId(targetDef);
              if (!nodes.has(toId)) nodes.set(toId, nodeForDef(targetDef));
              if (!recordEdge(fromId, toId, "uses")) return;
            }
          };

          if (optionalMemberTypes.has(node.type)) tryResolveChainLocal(node);
          for (const child of node.namedChildren ?? []) walkForMembers(child);
        };
        walkForMembers(fn.node);

        const walkForCalls = (node: SyntaxNodeLike) => {
          if (callNodeTypes.has(node.type)) {
            if (sup.id === "go") {
              const callTarget = getCallTarget(node);
              const calleeName =
                callTarget && isIdentifierType(sup, callTarget.type) ? sliceText(callTarget, src) : null;
              if (calleeName === "new" || calleeName === "make") {
                const argList = node.childForFieldName("arguments") ?? node.childForFieldName("argument_list");
                const typeNode = argList?.namedChildren?.find((child) => child.type === "type_identifier") ?? null;
                if (typeNode) {
                  tryResolveNode(typeNode, fromId, "instantiates");
                }
                return;
              }
            }
            if (sup.id === "ruby" && node.type === "call") {
              const methodNode = node.childForFieldName("method");
              const receiverNode = node.childForFieldName("receiver");
              const methodName = methodNode ? sliceText(methodNode, src) : null;
              if (methodName === "new" && receiverNode) {
                tryResolveNode(receiverNode, fromId, "instantiates");
                return;
              }
              if (methodNode) {
                tryResolveNode(methodNode, fromId, "calls");
                return;
              }
            }
            const callee = getCallTarget(node);
            if (callee) tryResolveNode(callee, fromId, "calls");
          }
          if (newNodeTypes.has(node.type)) {
            const target = getNewTarget(node);
            if (target) tryResolveNode(target, fromId, "instantiates");
          }
          for (const child of node.namedChildren ?? []) walkForCalls(child);
        };
        walkForCalls(fn.node);
      }

      const collectIdentifiers = (node: SyntaxNodeLike, out: string[]) => {
        if (isIdentifierType(sup, node.type) || node.type === "type_identifier") {
          out.push(sliceText(node, src));
        }
        for (const child of node.namedChildren ?? []) collectIdentifiers(child, out);
      };

      const findFirstNodeByType = (node: SyntaxNodeLike, type: string): SyntaxNodeLike | null => {
        for (const child of node.namedChildren ?? []) {
          if (child.type === type) return child;
          const found = findFirstNodeByType(child, type);
          if (found) return found;
        }
        return null;
      };

      const collectNodesByType = (node: SyntaxNodeLike, type: string, out: SyntaxNodeLike[]) => {
        for (const child of node.namedChildren ?? []) {
          if (child.type === type) out.push(child);
          collectNodesByType(child, type, out);
        }
      };

      for (const cls of classNodes) {
        const fromId = defNodeId(cls.def);
        if (!nodes.has(fromId)) nodes.set(fromId, nodeForDef(cls.def));
        if (sup.id === "java") {
          const superClass = findFirstNodeByType(cls.node, "superclass");
          const superNode = superClass?.childForFieldName("name") ?? superClass?.namedChildren?.[0] ?? null;
          if (superNode) tryResolveNode(superNode, fromId, "extends");

          const interfaces = findFirstNodeByType(cls.node, "super_interfaces");
          if (interfaces) {
            const names: string[] = [];
            collectIdentifiers(interfaces, names);
            for (const name of names) {
              const target = resolveIdentifier(name);
              if (!target) continue;
              const toId = defNodeId(target);
              if (!nodes.has(toId)) nodes.set(toId, nodeForDef(target));
              recordEdge(fromId, toId, "implements");
            }
          }
          continue;
        }

        if (sup.id === "csharp") {
          const baseList = findFirstNodeByType(cls.node, "base_list");
          if (baseList) {
            const names: string[] = [];
            collectIdentifiers(baseList, names);
            names.forEach((name, indexWithinList) => {
              const target = resolveIdentifier(name);
              if (!target) return;
              const toId = defNodeId(target);
              if (!nodes.has(toId)) nodes.set(toId, nodeForDef(target));
              recordEdge(fromId, toId, indexWithinList === 0 ? "extends" : "implements");
            });
          }
          continue;
        }

        const superClause = findFirstNodeByType(cls.node, "extends_clause");
        const superNode = superClause?.namedChildren?.[0] ?? superClause?.child(1);
        if (superNode) tryResolveNode(superNode, fromId, "extends");

        const implementsClauses: SyntaxNodeLike[] = [];
        collectNodesByType(cls.node, "implements_clause", implementsClauses);
        for (const clause of implementsClauses) {
          const names: string[] = [];
          collectIdentifiers(clause, names);
          for (const name of names) {
            const target = resolveIdentifier(name);
            if (!target) continue;
            const toId = defNodeId(target);
            if (!nodes.has(toId)) nodes.set(toId, nodeForDef(target));
            recordEdge(fromId, toId, "implements");
          }
        }
      }

      if (sup.id === "rust") {
        const walkImpls = (node: SyntaxNodeLike) => {
          if (node.type === "impl_item") {
            const typeIdentifiers = node.namedChildren?.filter((child) => child.type === "type_identifier") ?? [];
            if (typeIdentifiers.length >= 2) {
              const traitName = sliceText(typeIdentifiers[0], src);
              const typeName = sliceText(typeIdentifiers[1], src);
              const typeDef = resolveIdentifier(typeName);
              const traitDef = resolveIdentifier(traitName);
              if (typeDef && traitDef) {
                const fromId = defNodeId(typeDef);
                const toId = defNodeId(traitDef);
                if (!nodes.has(fromId)) nodes.set(fromId, nodeForDef(typeDef));
                if (!nodes.has(toId)) nodes.set(toId, nodeForDef(traitDef));
                recordEdge(fromId, toId, "implements");
              }
            }
          }
          for (const child of node.namedChildren ?? []) walkImpls(child);
        };
        walkImpls(tree.rootNode);
      }
    } catch (error) {
      if (isUnsupportedParserInputError(error)) {
        continue;
      }
      logWithLevel(opts?.logLevel, "warn", `Warning: Failed to build detailed symbol edges for ${file}:`, error);
    }
  }

  if (skippedSyntaxTreeFiles > 0) {
    logWithLevel(
      opts?.logLevel,
      "warn",
      `Warning: Skipped detailed symbol edges for ${skippedSyntaxTreeFiles} file(s) because no syntax-tree backend was available.`,
    );
  }

  return { nodes, edges };
}
