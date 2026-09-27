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
import { IMPLICIT_UNIT_LANGUAGES } from "../indexer/compilation-units.js";
import { cppCallableIsDefinition, cppEquivalentCallableBindings } from "../indexer/cpp-callables.js";
import { cjsRequireValueBinding, resolveExport } from "../indexer/navigation-resolve.js";
import {
  typescriptCollapsedOverloadTarget,
  typescriptCallableContainerKey,
  typescriptCallableRoleAt,
} from "../indexer/ts-callables.js";
import { isJsTsLanguage } from "../languages/js-family.js";
import { isGoExportedMemberName, languageHasDeclarationVisibility } from "../indexer/declaration-visibility.js";
import { fileScopeDefinitionCoversUse } from "../indexer/scope-nodes.js";
import { csharpAliasQualifiedLookupName, innermostNamespaceImport } from "../indexer/navigation-goto.js";
import {
  cppUsingDeclarationTarget,
  resolveCppCallableBindings,
  resolveCppCollidingBinding,
  resolveCppExportedCallables,
  resolveCppUsingDirectiveName,
  resolveVisibleCppCallableName,
} from "../indexer/navigation-cpp.js";
import { findPhpImportAlias, inferPhpQualifiedReferenceImportType } from "../indexer/navigation-php.js";
import {
  ensurePhpNamespaceSymbolIndex,
  phpClassReferenceMatchesDefinition,
  resolveIndexedPhpClassReference,
  resolvePhpExplicitImport,
} from "../indexer/php-namespace-symbols.js";
import {
  csharpLookupName,
  findClosestScopeBinding,
  getOrBuildScopeIndex,
  resolveNamedDefinition,
} from "../indexer/navigation-local.js";
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
  type SharedOwnerPeer,
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

function recordTypeScriptCallableAliases(
  moduleEntry: ModuleIndex,
  languageId: string,
  tree: SyntaxTreeLike,
  nodeAliases: Map<string, string>,
): void {
  if (languageId !== "ts" && languageId !== "tsx") return;
  const groups = new Map<string, SymbolDef[]>();
  for (const local of moduleEntry.locals) {
    if (local.kind !== SymbolKind.Function) continue;
    const start = local.range.start.index ?? 0;
    const end = local.range.end.index ?? start;
    const role = typescriptCallableRoleAt(tree, start, end);
    if (role === "other") continue;
    const key = `${typescriptCallableContainerKey(tree, start, end)}\0${local.localName}`;
    const group = groups.get(key) ?? [];
    group.push(local);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Signature-only and multiply implemented groups keep their distinct declarations.
    const canonical = typescriptCollapsedOverloadTarget(group, tree, (local) => local);
    if (!canonical) continue;
    const canonicalId = defNodeId(canonical);
    for (const local of group) {
      const id = defNodeId(local);
      if (id !== canonicalId) nodeAliases.set(id, canonicalId);
    }
  }
}

export async function buildSymbolGraphDetailed(
  index: ProjectIndex,
  opts?: BuildDetailedSymbolGraphOptions,
): Promise<DetailedSymbolGraph> {
  assertNativeRequiredAvailable(index.nativeMode);
  await ensurePhpNamespaceSymbolIndex(index);
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

  const resolveExportNamespace = (file: string, exportedName: string): ResolvedDetailedExport | null => {
    const languageId = supportForFileWithoutHeaderSample(file, index.languageExtensions)?.id;
    if (!isGoExportedMemberName(languageId, exportedName)) return null;
    return resolveExport(index, file, exportedName);
  };

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
    if (languageId === "c" || languageId === "cpp" || (languageId && languageHasDeclarationVisibility(languageId)))
      return null;

    const fileKey = typeof file === "string" ? fileIdentityKey(file) : null;
    const moduleEntry = fileKey ? index.byFile.get(fileKey) : undefined;
    const lastName = names[0];
    if (languageId === "go" && (!lastName || !isGoExportedMemberName(languageId, lastName))) return null;
    return moduleEntry?.locals.find((entry) => entry.localName === lastName) ?? null;
  };

  const resolveExportFrom = (file: string, exportedName: string): SymbolDef | null =>
    resolveExportDef(file, exportedName);

  const receiverCalls: ReceiverCallCandidate[] = [];
  const fileHiddenMemberIds = new Set<string>();
  const receiverMemberScopes = new Map<string, ReceiverMemberScope>();
  const receiverMemberArities = new Map<string, MemberArityRange>();
  const sharedOwnerPeers = new Map<string, Promise<SharedOwnerPeer[]>>();
  const sharedOwnerAnchors = new Map<string, string>();
  const sharedOwnerAccessibleMembers = new Map<string, Set<string>>();
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

      const scopeIndex = getOrBuildScopeIndex(index, file, src, sup, moduleEntry, tree);
      const { aliasToTargetDef, aliasToTargetModule } = buildImportAliasMaps(
        index,
        moduleEntry,
        resolveExportNamespace,
        resolveExportFrom,
        scopeIndex,
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
        ...(sup.id === "zig" || sup.id === "csharp" || isJsTsLanguage(sup.id)
          ? {
              resolveNamespaceAlias: (alias: string, useNode: SyntaxNodeLike): string | undefined => {
                if (sup.id === "zig") {
                  const binding = findClosestScopeBinding(scopeIndex, alias, useNode, sup);
                  if (binding && binding.kind !== "namespace") return undefined;
                }
                const imported = innermostNamespaceImport(moduleEntry.imports, alias, useNode, sup.normalizeIdentifier);
                if (
                  isJsTsLanguage(sup.id) &&
                  imported?.mechanism === "cjs" &&
                  typeof imported.resolved === "string" &&
                  cjsRequireValueBinding(index, imported.resolved)
                ) {
                  return undefined;
                }
                if (typeof imported?.resolved === "string") return imported.resolved;
                if (isJsTsLanguage(sup.id)) return aliasToTargetModule.get(alias);
                return undefined;
              },
            }
          : {}),
        // Go has no `resolveNamespaceAlias` override otherwise, so a local variable that
        // shadows a package alias (`u := LocalU{}; u.Square()` alongside `import u "pkg"`)
        // would still resolve `u.Square` through the blind `aliasToTargetModule` text map.
        // Refuse the package alias whenever a closer, non-namespace scope binding owns the
        // name at this exact use site, matching how the receiver-proof path already treats
        // the local as the real receiver instead.
        ...(sup.id === "go"
          ? {
              resolveNamespaceAlias: (alias: string, useNode: SyntaxNodeLike): string | undefined => {
                const binding = findClosestScopeBinding(scopeIndex, alias, useNode, sup);
                if (binding && binding.kind !== "namespace") return undefined;
                return aliasToTargetModule.get(alias);
              },
            }
          : {}),
      });
      const { memberExpressionType, optionalMemberTypes, propertyIdentifierTypes, resolveMemberChainTarget } =
        memberResolver;

      recordCallableDeclarationAliases(moduleEntry, sup.id, scopeIndex.all, nodeAliases);
      recordTypeScriptCallableAliases(moduleEntry, sup.id, tree, nodeAliases);
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
        const lookupName = sup.id === "csharp" ? csharpLookupName(node, src, name) : name;
        const csharpExportName =
          sup.id === "csharp" ? csharpAliasQualifiedLookupName(node, src, lookupName, moduleEntry.imports) : lookupName;
        // PHP class and function names occupy separate namespaces. Dispatch class syntax
        // before the lexical function binding or generic same-file name lookup can win.
        const phpClassReference = sup.id === "php" && inferPhpQualifiedReferenceImportType(node) === "class";
        if (phpClassReference) {
          const phpImport = findPhpImportAlias(moduleEntry.imports, name, "class");
          if (phpImport) return resolvePhpExplicitImport(index, phpImport, "class");
          const indexedClass = resolveIndexedPhpClassReference(index, src, tree, node, lookupName, moduleEntry.imports);
          if (indexedClass) return indexedClass;
        }
        const binding = findClosestScopeBinding(scopeIndex, lookupName, node, sup);
        const usingTarget = sup.id === "cpp" && binding ? cppUsingDeclarationTarget(binding, src) : undefined;
        if (usingTarget) {
          const visible = resolveVisibleCppCallableName(index, moduleEntry, usingTarget, node, src, loadCppParsedFile);
          if (visible !== undefined) return visible;
          const target = resolveNamedDefinition(index, moduleEntry, file, sup, usingTarget);
          return target?.status === "ok" ? target.definition : null;
        }
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
        if (sup.id === "php" && !phpClassReference) {
          const importType = inferPhpQualifiedReferenceImportType(node) ?? "const";
          const phpImport = findPhpImportAlias(moduleEntry.imports, name, importType);
          if (phpImport) return resolvePhpExplicitImport(index, phpImport, importType);
        }
        if (binding?.def) {
          const local = moduleEntry.locals.find(
            (candidate) =>
              sup.normalizeIdentifier(candidate.localName) === binding.canonicalName &&
              candidate.range.start.index === binding.def?.start.index &&
              candidate.range.end.index === binding.def?.end.index,
          );
          if (
            phpClassReference &&
            (!local ||
              !phpClassReferenceMatchesDefinition(index, src, tree, node, lookupName, moduleEntry.imports, local))
          ) {
            return null;
          }
          return local ?? null;
        }
        if (sup.id === "cpp") {
          const visible = resolveVisibleCppCallableName(index, moduleEntry, name, node, src, loadCppParsedFile);
          if (visible !== undefined) return visible;
          const directed = resolveCppUsingDirectiveName(index, moduleEntry, name, node, src, loadCppParsedFile);
          if (directed !== undefined) return directed;
        }
        if (binding) return resolveCppAliasTarget(aliasToTargetDef.get(binding.name), node);

        // C# namespace regions can reopen within one file. Without a lexical binding,
        // resolve through the position-aware unit lookup, not file-wide local names.
        const localCandidates =
          sup.id === "csharp"
            ? []
            : moduleEntry.locals.filter(
                (local) => sup.normalizeIdentifier(local.localName) === sup.normalizeIdentifier(name),
              );
        if (localCandidates.length === 1) {
          const only = localCandidates[0]!;
          if (
            (sup.id === "c" || sup.id === "cpp") &&
            !fileScopeDefinitionCoversUse(sup.id, only.range, node.startIndex)
          ) {
            return null;
          }
          if (
            phpClassReference &&
            !phpClassReferenceMatchesDefinition(index, src, tree, node, lookupName, moduleEntry.imports, only)
          ) {
            return null;
          }
          return sup.id === "cpp" && only.kind === SymbolKind.Function
            ? resolveCppExportedCallables(index, [only], node, src, loadCppParsedFile)
            : only;
        }
        const aliasTarget = resolveCppAliasTarget(aliasToTargetDef.get(lookupName), node);
        if (aliasTarget) return aliasTarget;
        // A bare name owned by no scope binding or local declaration can still name a
        // sibling declaration of the file's implicit compilation unit (Go/JVM package,
        // C# namespace, Swift module). Resolve it through the same proven peer relation
        // navigation uses rather than a project-wide name scan, so the graph and
        // navigation agree on the target. The C# use site is pinned to its namespace
        // region by `referenceIndex`; every other unit language reads its whole unit.
        if (localCandidates.length === 0 && IMPLICIT_UNIT_LANGUAGES[sup.id]) {
          const resolved = resolveExport(index, file, csharpExportName, {
            ...(sup.id === "csharp" ? { referenceIndex: node.startIndex } : {}),
          });
          if (resolved?.kind === "resolved") return resolved.def;
        }
        if (phpClassReference) {
          const imported = resolveNamedDefinition(
            index,
            moduleEntry,
            file,
            sup,
            lookupName,
            undefined,
            node.startIndex,
          );
          if (
            imported?.status === "ok" &&
            phpClassReferenceMatchesDefinition(
              index,
              src,
              tree,
              node,
              lookupName,
              moduleEntry.imports,
              imported.definition,
            )
          ) {
            return imported.definition;
          }
        }
        return null;
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
        hasNonModuleBinding: (name: string, node: SyntaxNodeLike): boolean => {
          const binding = findClosestScopeBinding(scopeIndex, name, node, sup);
          return !!binding && scopeIndex.allScopes[0]?.map.get(binding.canonicalName) !== binding;
        },
        resolveExportFrom,
        resolveMemberChainTarget,
        recordEdge,
        receiverCalls,
        receiverMemberScopes,
        receiverMemberArities,
        sharedOwnerPeers,
        sharedOwnerAnchors,
        sharedOwnerAccessibleMembers,
        fileHiddenMemberIds,
        nodeAliases,
        noteCallableName,
        loadParsedFile,
      };
      emitPythonDecoratorEdges(edgePassContext, tree.rootNode);
      emitFunctionBodyEdges(edgePassContext, functionNodes);
      await emitMemberOwnershipEdges(edgePassContext, functionNodes, classNodes);
      await emitClassInheritanceEdges(edgePassContext, classNodes);
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
    sharedOwnerAnchors,
    sharedOwnerAccessibleMembers,
    fileHiddenMemberIds,
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
