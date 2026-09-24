import { isUnsupportedParserInputError, prepareSourceInput } from "../languages/file-prep.js";
import { supportForFileWithoutHeaderSample } from "../languages.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { logWithLevel, type LogLevel } from "../logging.js";
import { ProjectedSyntaxTree } from "../native/projected-tree.js";
import {
  assertNativeRequiredAvailable,
  getNativeSyntaxTreeExecution,
  isNativeRequiredUnavailableError,
} from "../native/tree-sitter-native.js";
import { cppCallableIsDefinition, cppEquivalentCallableBindings } from "../indexer/cpp-callables.js";
import { resolveExport, resolvePhpExportByImportType } from "../indexer/navigation-resolve.js";
import {
  resolveCppCallableBindings,
  resolveCppCollidingBinding,
  resolveCppExportedCallables,
  resolveVisibleCppCallableName,
} from "../indexer/navigation-cpp.js";
import { findPhpImportAlias, inferPhpQualifiedReferenceImportType } from "../indexer/navigation-php.js";
import { findClosestScopeBinding, getOrBuildScopeIndex, resolveNamedDefinition } from "../indexer/navigation-local.js";
import { ensureParsedContext, type ParsedFileContext } from "../indexer/parse-context.js";
import {
  SymbolKind,
  type ModuleIndex,
  type ProjectIndex,
  type ResolvedExport,
  type SymbolDef,
} from "../indexer/types.js";
import type { Binding } from "../indexer/scope-types.js";
import type { FileId } from "../types.js";
import { fileIdentityKey, normalizePath } from "../util/paths.js";
import { foldPhpIdentifierCase } from "../util/identifiers.js";
import { buildSymbolGraph, defNodeId, type SymbolGraph } from "./symbol-graph.js";
import { collectDetailedDeclarations } from "./symbol-graph-detailed/ast.js";
import {
  emitClassInheritanceEdges,
  emitFunctionBodyEdges,
  emitMemberOwnershipEdges,
  emitMemberImplementationEdges,
  emitPythonDecoratorEdges,
  emitRustImplEdges,
} from "./symbol-graph-detailed/edge-passes.js";
import { buildImportAliasMaps } from "./symbol-graph-detailed/import-aliases.js";
import { createMemberChainResolver } from "./symbol-graph-detailed/member-chains.js";
import {
  emitReceiverCallEdges,
  type ReceiverCallCandidate,
  type ReceiverMemberScope,
  type MemberArityRange,
} from "./symbol-graph-detailed/receiver-calls.js";

type BuildDetailedSymbolGraphOptions = {
  scope?: "all" | "imported";
  files?: Set<FileId>;
  maxEdges?: number;
  membersOnly?: boolean;
  logLevel?: LogLevel;
};

type ResolvedDetailedExport = ResolvedExport;

export type DetailedSymbolGraph = SymbolGraph & {
  truncated?: boolean;
  limits?: { edges: number };
  omittedCounts?: { edges: number };
};

function symbolDefForBinding(moduleEntry: ModuleIndex, binding: Binding): SymbolDef | null {
  const bindingRange = binding.def;
  if (!bindingRange) return null;
  return (
    moduleEntry.locals.find(
      (candidate) =>
        candidate.kind === SymbolKind.Function &&
        candidate.range.start.index === bindingRange.start.index &&
        candidate.range.end.index === bindingRange.end.index,
    ) ?? null
  );
}

function recordCallableDeclarationAliases(
  moduleEntry: ModuleIndex,
  languageId: string,
  bindings: readonly Binding[],
  nodeAliases: Map<string, string>,
): void {
  const recordGroup = (group: readonly Binding[]): void => {
    if (group.length < 2) return;
    const canonicalBinding = group.find((binding) => !cppCallableIsDefinition(binding.node)) ?? group[0]!;
    const canonicalDef = symbolDefForBinding(moduleEntry, canonicalBinding);
    if (!canonicalDef) return;
    const canonicalId = defNodeId(canonicalDef);
    for (const binding of group) {
      const def = symbolDefForBinding(moduleEntry, binding);
      if (!def) continue;
      const id = defNodeId(def);
      if (id !== canonicalId) nodeAliases.set(id, canonicalId);
    }
  };

  if (languageId === "c") {
    const byName = new Map<string, Binding[]>();
    for (const binding of bindings) {
      if (binding.kind !== "function" || !binding.def) continue;
      const group = byName.get(binding.canonicalName) ?? [];
      group.push(binding);
      byName.set(binding.canonicalName, group);
    }
    for (const group of byName.values()) recordGroup(group);
    return;
  }
  if (languageId !== "cpp") return;

  const handled = new Set<Binding>();
  for (const binding of bindings) {
    if (binding.kind !== "function" || handled.has(binding)) continue;
    const group = cppEquivalentCallableBindings(binding);
    for (const candidate of group) handled.add(candidate);
    recordGroup(group);
  }
}

export async function buildSymbolGraphDetailed(
  index: ProjectIndex,
  opts?: BuildDetailedSymbolGraphOptions,
): Promise<DetailedSymbolGraph> {
  assertNativeRequiredAvailable(index.nativeMode);
  const base = await buildSymbolGraph(index, opts?.files ? { files: opts.files } : undefined);
  const configuredMaxEdges =
    typeof opts?.maxEdges === "number" && opts.maxEdges > 0 ? Math.floor(opts.maxEdges) : undefined;
  const maxEdges = configuredMaxEdges ?? Number.POSITIVE_INFINITY;
  const nodes = new Map(base.nodes);
  const edges = base.edges.slice(0, maxEdges);
  let omittedEdges = Math.max(0, base.edges.length - edges.length);
  let skippedSyntaxTreeFiles = 0;

  const added = new Set<string>();
  const membersOnly = !!opts?.membersOnly;
  const scopeMode = opts?.scope ?? "all";

  const importedByOthers = new Set<string>();
  if (scopeMode === "imported") {
    for (const moduleEntry of index.byFile.values()) {
      for (const imp of moduleEntry.imports) {
        const target = typeof imp.resolved === "string" ? fileIdentityKey(imp.resolved) : undefined;
        if (target) importedByOthers.add(target);
      }
    }
  }

  let edgeCount = edges.length;
  const maybePushEdge = (fromId: string, toId: string, label?: string, site?: SymbolGraph["edges"][number]["site"]) => {
    if (edgeCount >= maxEdges) {
      omittedEdges += 1;
      return false;
    }
    edges.push({
      from: fromId,
      to: toId,
      ...(label ? { label } : {}),
      ...(site ? { site } : {}),
    });
    edgeCount++;
    return true;
  };
  const edgeKey = (
    fromId: string,
    toId: string,
    label?: string,
    site?: SymbolGraph["edges"][number]["site"],
  ): string => {
    const siteKey = site ? `${site.file}:${site.range.start.index ?? ""}:${site.range.end.index ?? ""}` : "";
    return `${fromId}->${toId}::${label ?? ""}::${siteKey}`;
  };
  const recordEdge = (fromId: string, toId: string, label?: string, site?: SymbolGraph["edges"][number]["site"]) => {
    const key = edgeKey(fromId, toId, label, site);
    if (added.has(key)) return true;
    added.add(key);
    return maybePushEdge(fromId, toId, label, site);
  };

  const resolveExportNamespace = (file: string, exportedName: string): ResolvedDetailedExport | null =>
    resolveExport(index, file, exportedName);

  const resolveExportDef = (file: string, exportedName: string): SymbolDef | null => {
    const resolved = resolveExportNamespace(file, exportedName);
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

    if (targetDef) return targetDef;
    const languageId = supportForFileWithoutHeaderSample(file ?? startFile, index.languageExtensions)?.id;
    if (languageId === "c" || languageId === "cpp") return null;

    const fileKey = typeof file === "string" ? fileIdentityKey(file) : null;
    const moduleEntry = fileKey ? index.byFile.get(fileKey) : undefined;
    const lastName = names[0];
    return moduleEntry?.locals.find((entry) => entry.localName === lastName) ?? null;
  };

  const resolveExportFrom = (file: string, exportedName: string): SymbolDef | null =>
    resolveExportDef(file, exportedName);

  const receiverCalls: ReceiverCallCandidate[] = [];
  const receiverMemberScopes = new Map<string, ReceiverMemberScope>();
  const receiverMemberArities = new Map<string, MemberArityRange>();
  const nodeAliases = new Map<string, string>();
  const ownershipParsedContexts = new Map<string, Promise<ParsedFileContext | null>>();
  const loadParsedFile = (file: string): Promise<ParsedFileContext | null> => {
    const fileKey = fileIdentityKey(file);
    const cached = ownershipParsedContexts.get(fileKey);
    if (cached) return cached;
    const pending = ensureParsedContext(file, index.parsed?.get(fileKey), index.languageExtensions).catch(() => null);
    ownershipParsedContexts.set(fileKey, pending);
    return pending;
  };
  // Receiver calls into runtime and dependency APIs dominate real call sites. Build these
  // indexes lazily so a scoped graph that has no receiver calls pays no allocation cost.
  let callableNames: { exact: Set<string>; phpFolded: Set<string> } | undefined;
  const ensureCallableNames = (): { exact: Set<string>; phpFolded: Set<string> } => {
    if (!callableNames) {
      callableNames = { exact: new Set(), phpFolded: new Set() };
      for (const entry of index.byFile.values()) {
        const isPhp = supportForFileWithoutHeaderSample(entry.file, index.languageExtensions)?.id === "php";
        for (const local of entry.locals) {
          if (local.kind !== SymbolKind.Function) continue;
          callableNames.exact.add(local.localName);
          if (isPhp) callableNames.phpFolded.add(foldPhpIdentifierCase(local.localName));
        }
      }
    }
    return callableNames;
  };
  const hasCallableNamed = (name: string, phpCaseInsensitive = false): boolean => {
    const names = ensureCallableNames();
    return phpCaseInsensitive ? names.phpFolded.has(foldPhpIdentifierCase(name)) : names.exact.has(name);
  };
  // Function-valued bindings (`const helper = () => 1`) index as variables, so the
  // kind scan above cannot see them; the detailed pass mirrors each name it proves
  // callable here as its files are processed.
  const noteCallableName = (name: string, phpCaseInsensitive = false): void => {
    const names = ensureCallableNames();
    names.exact.add(name);
    if (phpCaseInsensitive) names.phpFolded.add(foldPhpIdentifierCase(name));
  };

  const optionFileKeys = opts?.files ? new Set(Array.from(opts.files, fileIdentityKey)) : undefined;
  for (const moduleEntry of index.byFile.values()) {
    const file = moduleEntry.file;
    if (optionFileKeys && !optionFileKeys.has(fileIdentityKey(file))) continue;
    if (scopeMode === "imported") {
      const hasFuncOrClass = moduleEntry.locals.some(
        (local) => local.kind === SymbolKind.Function || local.kind === SymbolKind.Class,
      );
      const isImportedOrImports = importedByOthers.has(fileIdentityKey(file)) || !!moduleEntry.imports.length;
      if (!(hasFuncOrClass && isImportedOrImports)) continue;
    }
    try {
      const parsedEntry = index.parsed?.get(fileIdentityKey(file));
      let sup = parsedEntry?.sup;
      let src = parsedEntry?.source;
      let tree: SyntaxTreeLike | undefined = parsedEntry?.tree;
      if (!sup || src === undefined) {
        const prep = await prepareSourceInput(file, {
          languageExtensions: index.languageExtensions,
        });
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
          skippedSyntaxTreeFiles += 1;
          continue;
        }
      }
      if (!sup || src === undefined || !tree) {
        throw new Error(`Failed to parse ${file}`);
      }
      ownershipParsedContexts.set(fileIdentityKey(file), Promise.resolve({ source: src, tree, sup }));

      const { aliasToTargetDef, aliasToTargetModule } = buildImportAliasMaps(
        index,
        moduleEntry,
        resolveExportNamespace,
        resolveExportFrom,
      );
      if (sup.id === "c" || sup.id === "cpp") {
        for (const [alias, def] of [...aliasToTargetDef]) {
          const exported = resolveExport(index, def.file, alias, {
            allowLocalFallback: false,
            ...(sup.id === "c" ? { cNamespace: "ordinary" as const } : {}),
          });
          if (exported?.kind !== "resolved") aliasToTargetDef.delete(alias);
        }
      }

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

      const scopeIndex = getOrBuildScopeIndex(index, file, src, sup, moduleEntry, tree);
      recordCallableDeclarationAliases(moduleEntry, sup.id, scopeIndex.all, nodeAliases);
      const cppParsedByFile = sup.id === "cpp" ? new Map<string, ParsedFileContext>() : null;
      if (cppParsedByFile) {
        cppParsedByFile.set(fileIdentityKey(file), { source: src, tree, sup });
        const importedFiles = new Set<string>();
        for (const imp of moduleEntry.imports) {
          if (typeof imp.resolved === "string") importedFiles.add(imp.resolved);
        }
        for (const importedFile of importedFiles) {
          const parsedImport = await loadParsedFile(importedFile);
          if (parsedImport) cppParsedByFile.set(fileIdentityKey(importedFile), parsedImport);
        }
      }
      const loadCppParsedFile = (targetFile: string): ParsedFileContext | null =>
        cppParsedByFile?.get(fileIdentityKey(targetFile)) ?? null;
      const resolveCppAliasTarget = (target: SymbolDef | undefined, node: SyntaxNodeLike): SymbolDef | null => {
        if (!target) return null;
        if (sup.id !== "cpp" || target.kind !== SymbolKind.Function) return target;
        return resolveCppExportedCallables(index, [target], node, src, loadCppParsedFile);
      };
      const resolveIdentifier = (name: string, node: SyntaxNodeLike): SymbolDef | null => {
        const binding = findClosestScopeBinding(scopeIndex, name, node, sup);
        if (sup.id === "cpp" && name.includes("::")) {
          const qualifiedBindings = scopeIndex.cppQualifiedFunctionBindings.get(name);
          if (qualifiedBindings) return resolveCppCallableBindings(file, qualifiedBindings, node, src);
          const visibleQualified = resolveVisibleCppCallableName(
            index,
            moduleEntry,
            name,
            node,
            src,
            loadCppParsedFile,
          );
          if (visibleQualified !== undefined) return visibleQualified;
          const qualifiedDefinition = resolveNamedDefinition(index, moduleEntry, file, sup, name);
          if (qualifiedDefinition?.status === "ok") return qualifiedDefinition.definition;
        }
        const cppCollision =
          sup.id === "cpp" && binding ? resolveCppCollidingBinding(file, binding, node, src) : undefined;
        if (cppCollision !== undefined) return cppCollision;
        if (binding?.def) {
          return (
            moduleEntry.locals.find(
              (local) =>
                sup.normalizeIdentifier(local.localName) === binding.canonicalName &&
                local.range.start.index === binding.def?.start.index &&
                local.range.end.index === binding.def?.end.index,
            ) ?? null
          );
        }
        if (sup.id === "php") {
          const importType = inferPhpQualifiedReferenceImportType(node) ?? "const";
          const phpImport = findPhpImportAlias(moduleEntry.imports, name, importType);
          if (phpImport && typeof phpImport.resolved === "string") {
            const resolved = resolvePhpExportByImportType(index, phpImport.resolved, phpImport.imported, importType);
            if (resolved?.kind === "resolved") return resolved.def;
          }
        }
        if (sup.id === "cpp") {
          const visible = resolveVisibleCppCallableName(index, moduleEntry, name, node, src, loadCppParsedFile);
          if (visible !== undefined) return visible;
        }
        if (binding) return resolveCppAliasTarget(aliasToTargetDef.get(binding.name), node);

        const localCandidates = moduleEntry.locals.filter(
          (local) => sup.normalizeIdentifier(local.localName) === sup.normalizeIdentifier(name),
        );
        if (localCandidates.length === 1) {
          const only = localCandidates[0]!;
          return sup.id === "cpp" && only.kind === SymbolKind.Function
            ? resolveCppExportedCallables(index, [only], node, src, loadCppParsedFile)
            : only;
        }
        return resolveCppAliasTarget(aliasToTargetDef.get(name), node);
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
        receiverCalls,
        receiverMemberScopes,
        receiverMemberArities,
        nodeAliases,
        noteCallableName,
        loadParsedFile,
      };
      emitPythonDecoratorEdges(edgePassContext, tree.rootNode);
      emitFunctionBodyEdges(edgePassContext, functionNodes);
      await emitMemberOwnershipEdges(edgePassContext, functionNodes, classNodes);
      emitClassInheritanceEdges(edgePassContext, classNodes);
      emitRustImplEdges(edgePassContext, tree.rootNode);
    } catch (error) {
      if (isNativeRequiredUnavailableError(error)) {
        throw error;
      }
      if (isUnsupportedParserInputError(error)) {
        continue;
      }
      logWithLevel(opts?.logLevel, "warn", `Warning: Failed to build detailed symbol edges for ${file}:`, error);
    }
  }
  // Function-valued bindings are proven while each file is processed. Apply the callable-name
  // prefilter only after that pass so receiver calls do not depend on file iteration order.
  const callableReceiverCalls = receiverCalls.filter((candidate) =>
    hasCallableNamed(candidate.memberName, candidate.caseInsensitiveMemberName),
  );
  const removedReceiverEdges = emitReceiverCallEdges(
    { nodes, edges },
    callableReceiverCalls,
    recordEdge,
    receiverMemberScopes,
    nodeAliases,
    receiverMemberArities,
  );
  edgeCount -= removedReceiverEdges.length;
  for (const edge of removedReceiverEdges) added.delete(edgeKey(edge.from, edge.to, edge.label, edge.site));
  const canonicalNodeId = (id: string): string => {
    let current = id;
    const seen = new Set<string>();
    while (nodeAliases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = nodeAliases.get(current)!;
    }
    return current;
  };
  for (const [aliasId] of nodeAliases) {
    const canonicalId = canonicalNodeId(aliasId);
    nodeAliases.set(aliasId, canonicalId);
    if (canonicalId === aliasId) continue;
    const aliasNode = nodes.get(aliasId);
    const canonicalNode = nodes.get(canonicalId);
    if (aliasNode && canonicalNode) {
      if (!canonicalNode.docstring && aliasNode.docstring) canonicalNode.docstring = aliasNode.docstring;
      canonicalNode.lineSpan = Math.max(canonicalNode.lineSpan ?? 0, aliasNode.lineSpan ?? 0);
      canonicalNode.complexity = Math.max(canonicalNode.complexity ?? 0, aliasNode.complexity ?? 0);
      if (aliasNode.callable) canonicalNode.callable = true;
      if (aliasNode.implementationTarget) canonicalNode.implementationTarget = true;
      if (canonicalNode.memberArity === undefined && aliasNode.memberArity !== undefined) {
        canonicalNode.memberArity = aliasNode.memberArity;
      }
    }
    nodes.delete(aliasId);
  }
  if (nodeAliases.size) {
    const reconciledEdges: SymbolGraph["edges"] = [];
    const reconciledEdgeKeys = new Set<string>();
    for (const edge of edges) {
      const reconciled = {
        ...edge,
        from: canonicalNodeId(edge.from),
        to: canonicalNodeId(edge.to),
      };
      const key = edgeKey(reconciled.from, reconciled.to, reconciled.label, reconciled.site);
      if (reconciledEdgeKeys.has(key)) continue;
      reconciledEdgeKeys.add(key);
      reconciledEdges.push(reconciled);
    }
    edges.splice(0, edges.length, ...reconciledEdges);
    added.clear();
    for (const edge of edges) added.add(edgeKey(edge.from, edge.to, edge.label, edge.site));
    edgeCount = edges.length;
  }
  emitMemberImplementationEdges({ nodes, edges }, recordEdge);

  if (skippedSyntaxTreeFiles > 0) {
    logWithLevel(
      opts?.logLevel,
      "warn",
      `Warning: Skipped detailed symbol edges for ${skippedSyntaxTreeFiles} file(s) because no syntax-tree backend was available.`,
    );
  }

  const graph: DetailedSymbolGraph = {
    nodes,
    edges,
    ...(configuredMaxEdges !== undefined
      ? {
          truncated: omittedEdges > 0,
          limits: { edges: configuredMaxEdges },
          omittedCounts: { edges: omittedEdges },
        }
      : {}),
  };
  if (nodeAliases.size) Object.defineProperty(graph, "nodeAliases", { value: nodeAliases });
  return graph;
}
