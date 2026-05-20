import { isJsFallbackAvailable, parseWithJsLanguage } from "../jsFallback.js";
import { type LanguageSupport } from "../languages.js";
import { isUnsupportedParserInputError, prepareSourceInput } from "../languages/filePrep.js";
import type { SyntaxTreeLike } from "../languages/types.js";
import { logWithLevel, type LogLevel } from "../logging.js";
import { ProjectedSyntaxTree } from "../native/projectedTree.js";
import { getNativeSyntaxTreeExecution } from "../native/treeSitterNative.js";
import { SymbolKind, type ProjectIndex, type ResolvedExport, type SymbolDef } from "../indexer/types.js";
import type { FileId } from "../types.js";
import { buildSymbolGraph, type SymbolGraph } from "./symbol-graph.js";
import {
  collectDetailedDeclarations,
} from "./symbol-graph-detailed/ast.js";
import {
  emitClassInheritanceEdges,
  emitFunctionBodyEdges,
  emitPythonDecoratorEdges,
  emitRustImplEdges,
} from "./symbol-graph-detailed/edgePasses.js";
import { buildImportAliasMaps } from "./symbol-graph-detailed/importAliases.js";
import { createMemberChainResolver } from "./symbol-graph-detailed/memberChains.js";

type BuildDetailedSymbolGraphOptions = {
  scope?: "all" | "imported";
  files?: Set<FileId>;
  maxEdges?: number;
  membersOnly?: boolean;
  logLevel?: LogLevel;
};

type ResolvedDetailedExport = ResolvedExport;

const normalizePath = (file: string) => file.replace(/\\/g, "/");

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
      const isImportedOrImports = importedByOthers.has(normalizePath(file)) || !!moduleEntry.imports.length;
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

      const { aliasToTargetDef, aliasToTargetModule } = buildImportAliasMaps(
        index,
        moduleEntry,
        resolveExportNamespace,
        resolveExportFrom,
      );

      const { functionNodes, classNodes, constStringOf } = collectDetailedDeclarations(
        tree.rootNode,
        sup,
        src,
        moduleEntry.locals,
      );

      const memberResolver = createMemberChainResolver({
        sup,
        source: src,
        constStringOf,
        aliasToTargetModule,
        resolveMemberPathFromModule,
      });
      const { memberExpressionType, optionalMemberTypes, propertyIdentifierTypes, resolveMemberChainTarget } =
        memberResolver;

      const resolveIdentifier = (name: string): SymbolDef | null => {
        const fromAlias = aliasToTargetDef.get(name);
        if (fromAlias) return fromAlias;
        return moduleEntry.locals.find((local) => local.localName === name) ?? null;
      };

      const edgePassContext = {
        index,
        sup,
        source: src,
        moduleEntry,
        nodes,
        membersOnly,
        memberExpressionType,
        propertyIdentifierTypes,
        optionalMemberTypes,
        aliasToTargetDef,
        aliasToTargetModule,
        resolveIdentifier,
        resolveExportFrom,
        resolveMemberChainTarget,
        recordEdge,
      };
      emitPythonDecoratorEdges(edgePassContext, tree.rootNode);
      emitFunctionBodyEdges(edgePassContext, functionNodes);
      emitClassInheritanceEdges(edgePassContext, classNodes);
      emitRustImplEdges(edgePassContext, tree.rootNode);
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
