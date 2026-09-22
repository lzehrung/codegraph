import { supportForFileWithoutHeaderSample, type LanguageExtensionMap, type LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { ensureParsedContext, type ParsedFileContext } from "./parse-context.js";
import { resolveMemberAccessDefinition, supportsReceiverMemberNavigation } from "./navigation-goto.js";
import {
  findClosestBinding,
  findDeclarationNameNode,
  getOrBuildScopeIndex,
  resolveNamedDefinition,
} from "./navigation-local.js";
import { createNavigationProvenance, okGoToResult } from "./navigation-provenance.js";
import {
  getPhpQualifiedReference,
  inferPhpQualifiedReferenceImportType,
  isPhpCaseInsensitiveSymbolKind,
  normalizePhpQualifiedReference,
  phpLastIdentifierSegment,
} from "./navigation-php.js";
import {
  buildIndexedCandidateCoverage,
  buildPhpQualifiedNames,
  describeReferenceStrategies,
  collectVerifiedNamedNodeReferences,
  type VerifiedNamedNodeReference,
  getCachedScope,
  exportFromIdentifier,
  getCachedReferenceCandidateFiles,
  getCandidateReferenceNames,
  hasExpandedNamedImport,
  importBindingDeclarationRangeKeys,
  importBindingIdentityVerificationSites,
  importBindingReferenceSites,
  rangeIdentityKey,
  referenceSiteKey,
} from "./navigation-references.js";
import { resolveExport, resolveImported } from "./navigation-resolve.js";
import { extractEnclosingBlock, extractLineContext, rangeContains, sameDef } from "./reference-context.js";
import { DEFAULT_REF_CONTEXT_LINES } from "./shared.js";
import { type Binding, type ScopeIndex } from "./scope.js";
import { type FileId, type Range } from "../types.js";
import { loadNearestTsconfigFor, resolveImportSpecifier } from "../util/resolution.js";
import { fileIdentityKey } from "../util/paths.js";
import { sliceText, toRange } from "../util/ast.js";
import { foldPhpIdentifierCase } from "../util/identifiers.js";
import {
  getMemberAccessParts,
  isMemberAccessNode,
  isMemberObjectIdentifier,
  isMemberReferencePropertyIdentifier,
  isReceiverNameNode,
} from "../util/member-access.js";
import {
  type FindReferencesResult,
  type GoToRequest,
  type GoToResult,
  type ProjectIndex,
  type Reference,
  type ResolutionProvenance,
  type SymbolDef,
  SymbolKind,
} from "./types.js";
import { findSqlReferences, goToSqlDefinition } from "../sql/navigation.js";

export { resolveExport, resolveImported } from "./navigation-resolve.js";

export async function goToDefinition(
  index: ProjectIndex,
  req: GoToRequest,
  parsedContext?: ParsedFileContext,
): Promise<GoToResult> {
  const { file, line, column } = req;
  const mod = index.byFile.get(fileIdentityKey(file));
  if (!mod) return { status: "not_found", reason: "File not indexed" };

  const sqlResult = await goToSqlDefinition(index, req);
  if (sqlResult) return sqlResult;

  const context =
    parsedContext ??
    (await ensureParsedContext(file, index.parsed?.get(fileIdentityKey(file)), index.languageExtensions));
  const sup = context.sup;
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

  const shorthandId = sup.nodeTypes.shorthandPropertyIdentifier ?? [];
  const isId = sup.nodeTypes.identifier.includes(node.type) || shorthandId.includes(node.type);
  let name: string | null = isId ? sliceText(node, source) : null;
  const phpQualifiedReference = sup.id === "php" ? getPhpQualifiedReference(node, source) : null;

  if (!name) {
    const declNameNode = findDeclarationNameNode(sup, node);
    if (declNameNode) {
      name = sliceText(declNameNode, source);
    }
  }

  if (node && sup.supportsExportFromReferences && index.projectRoot) {
    const exportFrom = exportFromIdentifier(index, file, toRange(node), context);
    if (exportFrom?.entry) {
      // Index construction normalizes in-root re-export targets, so the common relative
      // case needs no resolver at all. Re-resolving a POSIX absolute path would instead
      // treat its leading slash as project-root-relative. Only a path alias or package
      // specifier reaches the resolver, so defer the nearest-tsconfig walk until then
      // rather than paying it on every re-export goto.
      let resolvedTarget: FileId | { external: string };
      if (index.byFile.has(fileIdentityKey(exportFrom.entry.fromModule))) {
        resolvedTarget = exportFrom.entry.fromModule;
      } else {
        const { matchPath } = await loadNearestTsconfigFor(file, index.projectRoot);
        resolvedTarget = await resolveImportSpecifier(
          index.projectRoot,
          file,
          exportFrom.entry.moduleSpecifier ?? exportFrom.entry.fromModule,
          sup.id,
          {
            ...(matchPath ? { matchPath } : {}),
          },
        );
      }
      if (typeof resolvedTarget === "string") {
        const hit = resolveExport(index, resolvedTarget, exportFrom.entry.sourceSpecifier);
        if (hit?.kind === "resolved") {
          return okGoToResult(index, hit.def, {
            via: { importedFrom: resolvedTarget, exportedName: exportFrom.entry.sourceSpecifier },
            resolution: "import",
            confidence: "high",
          });
        }
      }
    }
  }

  if (sup.supportsCrossModuleSymbols) {
    const scopeIndex =
      node.parent && isMemberAccessNode(sup, node.parent)
        ? getOrBuildScopeIndex(index, file, source, sup, mod, tree)
        : null;
    const memberAccessResult = await resolveMemberAccessDefinition({
      index,
      mod,
      node,
      source,
      sup,
      ...(scopeIndex
        ? {
            resolveLexicalBinding: (receiver) => {
              if (!isReceiverNameNode(sup, receiver.type)) return null;
              return findClosestBinding(scopeIndex, file, sliceText(receiver, source), receiver, sup);
            },
          }
        : {}),
    });
    if (memberAccessResult) {
      return memberAccessResult;
    }
    if (isUnresolvedReceiverMemberProperty(sup, node)) {
      return { status: "not_found", reason: "No matching receiver member definition" };
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
            return okGoToResult(index, hit.def, {
              via: { importedFrom: resolvedTarget, exportedName },
              resolution: "php-qualified",
              confidence: "high",
            });
          }
        }
      }
    }
  }

  if (name) {
    const scopeIndex = getOrBuildScopeIndex(index, file, source, sup, mod, tree);
    const local = findClosestBinding(scopeIndex, file, name, node, sup);
    if (local) {
      return okGoToResult(index, local, {
        resolution: "exact",
        confidence: "high",
      });
    }

    if (sup.supportsCrossModuleSymbols) {
      const resolvedName = resolveNamedDefinition(index, mod, file, sup, name);
      if (resolvedName) {
        return resolvedName;
      }
    }
  }

  const localAtPosition = mod.locals.find((local) =>
    rangeContains(local.range, {
      row: line,
      column: column,
    }),
  );
  if (localAtPosition) {
    return okGoToResult(index, localAtPosition, {
      resolution: "exact",
      confidence: "high",
    });
  }

  return {
    status: "not_found",
    reason: "No matching local or imported definition",
  };
}

function isUnresolvedReceiverMemberProperty(sup: LanguageSupport, node: SyntaxNodeLike): boolean {
  const parent = node.parent;
  if (!parent || !supportsReceiverMemberNavigation(sup.id) || !isMemberAccessNode(sup, parent)) {
    return false;
  }
  const { object, property } = getMemberAccessParts(sup, parent);
  if (!property || node.id !== property.id) return false;
  // Unqualified calls reuse member-call nodes with the name in both slots.
  if (!object || object.startIndex === property.startIndex) return false;
  // Namespace and nested-type qualification still resolve through the language
  // paths below; only value-receiver members must not fall back to a bare name.
  if (
    parent.type === "qualified_name" ||
    parent.type === "qualified_identifier" ||
    parent.type === "qualified_type" ||
    parent.type === "scoped_identifier" ||
    parent.type === "scoped_type_identifier" ||
    parent.type === "scope_resolution" ||
    parent.type === "namespace_name"
  ) {
    return false;
  }
  if (
    (parent.type === "scoped_call_expression" ||
      parent.type === "class_constant_access_expression" ||
      parent.type === "scoped_property_access_expression") &&
    (object.type === "qualified_name" || object.type === "namespace_name")
  ) {
    return false;
  }
  // Go `o.Name` and C `obj.field` are member-access nodes but not method calls.
  if (parent.type === "selector_expression" || parent.type === "field_expression") {
    const grandparent = parent.parent;
    const called =
      grandparent !== null &&
      (grandparent.type === "call_expression" ||
        grandparent.type === "call" ||
        grandparent.type === "method_invocation");
    if (!called) return false;
  }
  return true;
}

type FindReferencesRequest = { file: FileId; line: number; column: number } | { def: SymbolDef };

type FindReferencesOptions = {
  context?: "line" | "block";
  lines?: number;
  blockMaxLines?: number;
  maxReferences?: number;
};

export async function findReferences(
  index: ProjectIndex,
  req: FindReferencesRequest,
  opts?: FindReferencesOptions,
): Promise<FindReferencesResult> {
  return findReferencesInternal(index, req, opts, "all");
}

/** Internal bounded lookup for consumers that need usage sites, not declaration sites. */
export async function findUsageReferences(
  index: ProjectIndex,
  req: FindReferencesRequest,
  opts?: FindReferencesOptions,
): Promise<FindReferencesResult> {
  return findReferencesInternal(index, req, opts, "usages");
}
/** Internal bounded lookup for semantic rename sites after preserved aliases are excluded. */
export async function findRenameReferences(
  index: ProjectIndex,
  def: SymbolDef,
  opts?: FindReferencesOptions,
): Promise<FindReferencesResult> {
  return findReferencesInternal(index, { def }, opts, "rename");
}

async function findReferencesInternal(
  index: ProjectIndex,
  req: FindReferencesRequest,
  opts: FindReferencesOptions | undefined,
  collectionMode: "all" | "usages" | "rename",
): Promise<FindReferencesResult> {
  let def: SymbolDef | null = null;
  let provenance: ResolutionProvenance | undefined;
  if ("def" in req) {
    def = req.def;
    provenance = createNavigationProvenance(index, "exact", "high");
  } else {
    const module = index.byFile.get(fileIdentityKey(req.file));
    const localAtPosition = module?.locals.find((local) =>
      rangeContains(local.range, {
        row: req.line,
        column: req.column,
      }),
    );
    if (localAtPosition) {
      def = localAtPosition;
      provenance = createNavigationProvenance(index, "exact", "high");
    } else {
      const gotoResult = await goToDefinition(index, req);
      if (gotoResult.status === "ok") {
        def = gotoResult.definition;
        provenance = gotoResult.provenance;
      }
    }
  }
  if (!def) {
    return { status: "not_found", reason: "Could not resolve definition" };
  }

  const maxReferences =
    typeof opts?.maxReferences === "number" && opts.maxReferences > 0 ? opts.maxReferences : undefined;
  const sqlReferences = await findSqlReferences(index, def, {
    includeDefinition: collectionMode === "all",
    ...(maxReferences === undefined ? {} : { maxReferences }),
  });
  if (sqlReferences) return sqlReferences;

  const definitionFile = def.file;
  const definitionSiteKey = referenceSiteKey(definitionFile, def.range);
  const includeReference = (ref: Reference): boolean => {
    if (collectionMode === "all") return true;
    if (ref.via?.reexport || referenceSiteKey(ref.file, ref.range) === definitionSiteKey) return false;
    if (collectionMode === "usages") return ref.via?.importBinding === undefined;
    const binding = ref.via?.import;
    if (!binding || binding.kind === "star" || binding.kind === "namespace") return true;
    if (ref.via?.importBinding === "imported" && binding.kind === "named" && binding.imported === def.localName) {
      return true;
    }
    if (binding.kind === "default") return false;
    return !binding.explicitAlias && binding.local === def.localName;
  };
  const verifiedReferenceFilter = (
    fileId: string,
  ): ((reference: VerifiedNamedNodeReference) => boolean) | undefined => {
    if (collectionMode === "all") return undefined;
    return (reference) => !reference.via?.reexport && referenceSiteKey(fileId, reference.range) !== definitionSiteKey;
  };
  const parsedDef = index.parsed?.get(fileIdentityKey(definitionFile));
  const parsedContext = await ensureParsedContext(definitionFile, parsedDef, index.languageExtensions);

  const mod = index.byFile.get(fileIdentityKey(definitionFile));
  if (!mod) return { status: "not_found", reason: "Module not found" };

  const scope = getCachedScope(index, definitionFile, mod, parsedContext);
  const refs: Reference[] = [];
  const seenRefs = new Map<string, number>();
  const collectionLimit = maxReferences !== undefined ? maxReferences + 1 : undefined;
  const hasReachedCollectionLimit = (): boolean => collectionLimit !== undefined && refs.length >= collectionLimit;
  const remainingCollectionSlots = (): number | undefined =>
    collectionLimit !== undefined ? Math.max(0, collectionLimit - refs.length) : undefined;
  const importBindingRank = (ref: Reference): number => (ref.via?.importBinding === "imported" ? 1 : 0);
  const pushRef = (ref: Reference): void => {
    if (!includeReference(ref)) return;
    const key = referenceSiteKey(ref.file, ref.range);
    const existingIndex = seenRefs.get(key);
    if (existingIndex !== undefined) {
      const existing = refs[existingIndex]!;
      if (importBindingRank(ref) > importBindingRank(existing)) {
        refs[existingIndex] = ref;
      }
      return;
    }
    if (hasReachedCollectionLimit()) return;
    seenRefs.set(key, refs.length);
    refs.push(ref);
  };

  const normalizedLocalName = parsedContext.sup.normalizeIdentifier(def.localName);
  const localBindings = scope.bindings.get(normalizedLocalName) ?? [];
  const localBinding = localBindings.find(
    (binding) => binding.def && binding.def.start.index === def.range.start.index,
  );
  pushRef({ file: definitionFile, range: def.range });
  if (localBinding) {
    for (const occurrence of localBinding.occurrences) {
      if (hasReachedCollectionLimit()) break;
      pushRef({ file: definitionFile, range: occurrence });
    }
  }

  const exportedNames: string[] = [];
  for (const entry of mod.exports) {
    if (entry.type === "local" && sameDef(entry.target, def, index.languageExtensions)) {
      exportedNames.push(entry.exportedAs);
    }
  }
  if (!exportedNames.length && shouldUseLocalNameAsExportFallback(def, parsedContext)) {
    exportedNames.push(def.localName);
  }

  const exportedNameSet = new Set(exportedNames);
  const phpQualifiedNames = await buildPhpQualifiedNames(index, definitionFile, def);

  let candidateFiles = getCachedReferenceCandidateFiles(index, def, exportedNames, !!phpQualifiedNames.length);
  // A bloom filter holds each candidate file's identifiers in that file's own spelling, and a
  // probe can only test one spelling. PHP resolves class, interface, trait, enum, and function
  // names case-insensitively, so `new \App\sErViCe()` must still match a `Service` definition.
  // `buildBloomFilterFromSource` stores every PHP file's identifiers both in their own spelling
  // and ASCII-case-folded, so folding the probe's last identifier segment here narrows those
  // kinds exactly instead of skipping narrowing and walking every indexed PHP file. Variables,
  // properties, and constants stay case-sensitive and probe with their own spelling.
  const phpCaseInsensitiveDefinition = phpQualifiedNames.length && isPhpCaseInsensitiveSymbolKind(def.kind);
  if (index.bloomFilters && phpQualifiedNames.length) {
    candidateFiles = candidateFiles.filter((candidateFile) => {
      const module = index.byFile.get(fileIdentityKey(candidateFile));
      if (!module) return true;
      const filter = index.bloomFilters?.get(fileIdentityKey(candidateFile));
      if (!filter) return true;

      // Bloom filters contain names normalized by the candidate file's language, so probes must use that rule.
      const normalizeIdentifier =
        supportForFileWithoutHeaderSample(candidateFile, index.languageExtensions)?.normalizeIdentifier ??
        ((name) => name);
      const aliases = getCandidateReferenceNames(module, definitionFile, exportedNameSet);
      const probeNames = aliases.length ? aliases : [...exportedNames, ...phpQualifiedNames];
      if (phpCaseInsensitiveDefinition) {
        return probeNames.some((candidateName) =>
          filter.mightContain(foldPhpIdentifierCase(normalizeIdentifier(phpLastIdentifierSegment(candidateName)))),
        );
      }
      return probeNames.some((candidateName) => filter.mightContain(normalizeIdentifier(candidateName)));
    });
  }

  for (const fileId of candidateFiles) {
    if (hasReachedCollectionLimit()) break;
    const module = index.byFile.get(fileIdentityKey(fileId));
    if (!module) continue;

    let scopeIndex: ScopeIndex | null = null;
    let candidateParsedContext: ParsedFileContext | null = null;
    const ensureCandidateParsed = async (): Promise<ParsedFileContext> => {
      if (!candidateParsedContext) {
        const parsedEntry = index.parsed?.get(fileIdentityKey(fileId));
        candidateParsedContext = await ensureParsedContext(fileId, parsedEntry, index.languageExtensions);
      }
      return candidateParsedContext;
    };
    const ensureScope = async (): Promise<ScopeIndex> => {
      if (!scopeIndex) {
        const parsed = await ensureCandidateParsed();
        scopeIndex = getCachedScope(index, fileId, module, parsed);
      }
      return scopeIndex;
    };

    if (supportForFileWithoutHeaderSample(fileId, index.languageExtensions)?.supportsExportFromReferences) {
      for (const entry of module.exports) {
        if (hasReachedCollectionLimit()) break;
        if (entry.type !== "reexport") continue;
        if (!exportedNameSet.has(entry.sourceSpecifier)) continue;
        const resolved = resolveExport(index, entry.fromModule, entry.sourceSpecifier);
        if (resolved?.kind === "resolved" && !sameDef(resolved.def, def, index.languageExtensions)) continue;
        const remainingReferences = remainingCollectionSlots();
        const ranges = await collectVerifiedNamedNodeReferences(
          index,
          fileId,
          entry.sourceSpecifier,
          def,
          (params, parsed) => goToDefinition(index, params, parsed),
          remainingReferences,
          verifiedReferenceFilter(fileId),
        );
        for (const { range, provenance, via } of ranges) {
          if (hasReachedCollectionLimit()) break;
          if (!via?.reexport) continue;
          pushRef({ file: fileId, range, via, ...(provenance ? { provenance } : {}) });
        }
      }
    }

    for (const imp of module.imports) {
      if (hasReachedCollectionLimit()) break;
      const targetFile = typeof imp.resolved === "string" ? imp.resolved : undefined;
      const bindingSites = importBindingReferenceSites(imp);
      let verifiedBindingMatches: boolean | undefined;
      const bindingMatchesDefinition = async (): Promise<boolean> => {
        if (verifiedBindingMatches !== undefined) return verifiedBindingMatches;
        verifiedBindingMatches = false;
        const parsed = await ensureCandidateParsed();
        for (const verificationSite of importBindingIdentityVerificationSites(imp)) {
          const resolved = await goToDefinition(
            index,
            {
              file: fileId,
              line: verificationSite.range.start.line,
              column: verificationSite.range.start.column,
            },
            parsed,
          );
          if (resolved.status === "ok" && sameDef(resolved.definition, def, index.languageExtensions)) {
            verifiedBindingMatches = true;
            break;
          }
        }
        return verifiedBindingMatches;
      };

      // Package and Composer imports can be stored as external specifiers even when
      // language-specific goto resolution proves that their declaration binds this
      // indexed definition. Preserve those exact declaration sites; generic occurrence
      // collection intentionally excludes every attributed import range.
      if (!targetFile) {
        if (!bindingSites.length || !(await bindingMatchesDefinition())) continue;
        for (const site of bindingSites) {
          pushRef({
            file: fileId,
            range: site.range,
            via: { import: imp, importBinding: site.importBinding },
          });
        }
        continue;
      }
      for (const exportedName of exportedNames) {
        if (hasReachedCollectionLimit()) break;
        if (imp.kind === "namespace") {
          const hit = resolveExport(index, targetFile, exportedName);
          const matchesDef =
            hit?.kind === "resolved"
              ? sameDef(hit.def, def, index.languageExtensions)
              : imp.kind === "namespace" && fileIdentityKey(targetFile) === fileIdentityKey(definitionFile);
          if (!matchesDef) continue;
          const parsed = await ensureCandidateParsed();
          const ranges = await collectNamespaceMemberRefs(
            fileId,
            imp.localNS,
            exportedName,
            parsed,
            index.languageExtensions,
          );
          for (const range of ranges) {
            if (hasReachedCollectionLimit()) break;
            pushRef({
              file: fileId,
              range,
              via: { import: imp, namespaceMember: exportedName },
            });
          }
        } else if (imp.kind === "star") {
          const result = resolveImported(index, imp, exportedName);
          const matchesDef = !!result && !("namespace" in result) && sameDef(result, def, index.languageExtensions);
          if (!matchesDef) continue;
          if (hasExpandedNamedImport(module, targetFile, exportedName)) {
            continue;
          }
          const remainingReferences = remainingCollectionSlots();
          const ranges = await collectVerifiedNamedNodeReferences(
            index,
            fileId,
            exportedName,
            def,
            (params, parsed) => goToDefinition(index, params, parsed),
            remainingReferences,
            verifiedReferenceFilter(fileId),
          );
          for (const { range, provenance, via } of ranges) {
            if (hasReachedCollectionLimit()) break;
            pushRef({
              file: fileId,
              range,
              via: { import: imp, ...(via ?? {}) },
              ...(provenance ? { provenance } : {}),
            });
          }
        } else {
          let exported = exportedName;
          if (imp.kind === "named") {
            exported = imp.imported;
          } else if (imp.kind === "default") {
            exported = "default";
          }
          const hit = resolveExport(index, targetFile, exported);
          let matchesDef = hit?.kind === "resolved" && sameDef(hit.def, def, index.languageExtensions);
          if (!matchesDef && bindingSites.length) {
            matchesDef = await bindingMatchesDefinition();
          }
          if (!matchesDef) continue;
          for (const site of bindingSites) {
            pushRef({
              file: fileId,
              range: site.range,
              via: { import: imp, importBinding: site.importBinding },
            });
          }
          if (fileIdentityKey(targetFile) !== fileIdentityKey(definitionFile)) {
            const remainingReferences = remainingCollectionSlots();
            const ranges = await collectVerifiedNamedNodeReferences(
              index,
              fileId,
              imp.local,
              def,
              (params, parsed) => goToDefinition(index, params, parsed),
              remainingReferences,
              verifiedReferenceFilter(fileId),
            );
            for (const { range, provenance, via } of ranges) {
              if (hasReachedCollectionLimit()) break;
              pushRef({
                file: fileId,
                range,
                via: { import: imp, ...(via ?? {}) },
                ...(provenance ? { provenance } : {}),
              });
            }
            continue;
          }
          const parsed = await ensureCandidateParsed();
          const resolvedScope = await ensureScope();
          const localName = parsed.sup.normalizeIdentifier(imp.local);
          const declarationKeys = importBindingDeclarationRangeKeys(module);
          const bindings = resolvedScope.bindings.get(localName) ?? [];
          for (const binding of bindings) {
            if (binding.import === imp) {
              for (const occurrence of binding.occurrences) {
                if (hasReachedCollectionLimit()) break;
                if (declarationKeys.has(rangeIdentityKey(occurrence))) continue;
                pushRef({ file: fileId, range: occurrence, via: { import: imp } });
              }
            }
          }
        }
      }
    }

    if (phpQualifiedNames.length) {
      const remainingReferences = remainingCollectionSlots();
      const ranges = await collectVerifiedNamedNodeReferences(
        index,
        fileId,
        def.localName,
        def,
        (params, parsed) => goToDefinition(index, params, parsed),
        remainingReferences,
        verifiedReferenceFilter(fileId),
      );
      for (const { range, provenance, via } of ranges) {
        if (hasReachedCollectionLimit()) break;
        pushRef({ file: fileId, range, ...(via ? { via } : {}), ...(provenance ? { provenance } : {}) });
      }
    }
  }

  const receiverScannedFiles: FileId[] = [];
  if (shouldScanVerifiedReferences(def, phpQualifiedNames, parsedContext)) {
    for (const fileId of Array.from(index.byFile.values(), (module) => module.file).sort((left, right) =>
      left.localeCompare(right),
    )) {
      if (hasReachedCollectionLimit()) break;
      receiverScannedFiles.push(fileId);
      const filter = index.bloomFilters?.get(fileIdentityKey(fileId));
      // Bloom filters contain names normalized by the candidate file's language, so probes must use that rule.
      const canonicalName =
        supportForFileWithoutHeaderSample(fileId, index.languageExtensions)?.normalizeIdentifier(def.localName) ??
        def.localName;
      if (filter && !filter.mightContain(canonicalName)) continue;
      const remainingReferences = remainingCollectionSlots();
      const ranges = await collectVerifiedNamedNodeReferences(
        index,
        fileId,
        def.localName,
        def,
        (params, parsed) => goToDefinition(index, params, parsed),
        remainingReferences,
        verifiedReferenceFilter(fileId),
      );
      for (const { range, provenance, via } of ranges) {
        if (hasReachedCollectionLimit()) break;
        pushRef({ file: fileId, range, ...(via ? { via } : {}), ...(provenance ? { provenance } : {}) });
      }
    }
  }

  const truncated = maxReferences !== undefined && refs.length > maxReferences;
  if (truncated) {
    refs.length = maxReferences;
  }

  refs.sort((left, right) => {
    if (fileIdentityKey(left.file) === fileIdentityKey(right.file)) {
      const leftIndex = left.range.start.index ?? 0;
      const rightIndex = right.range.start.index ?? 0;
      return leftIndex - rightIndex;
    }
    return left.file.localeCompare(right.file);
  });

  if (opts?.context) {
    const perFileCache = new Map<string, { source: string; tree: SyntaxTreeLike; sup: LanguageSupport }>();

    for (const ref of refs) {
      let cached = perFileCache.get(fileIdentityKey(ref.file));
      if (!cached) {
        const parsedEntry = index.parsed?.get(fileIdentityKey(ref.file));
        const parsed = await ensureParsedContext(ref.file, parsedEntry, index.languageExtensions);
        cached = { source: parsed.source, tree: parsed.tree, sup: parsed.sup };
        perFileCache.set(fileIdentityKey(ref.file), cached);
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

  const scannedFiles = [definitionFile, ...candidateFiles, ...receiverScannedFiles];
  const referenceCoverage = buildIndexedCandidateCoverage({
    index,
    def,
    exportedNames,
    candidateFiles,
    scannedFiles,
    truncated,
    strategies: describeReferenceStrategies({
      languageId: parsedContext.sup.id,
      phpQualifiedNames,
      sameFileOccurrence: {
        // Only C/C++ function definitions need this strategy: their names self-scope-register,
        // so sibling same-file call sites stay invisible to the scope layer. Parameters and
        // local variables already collect every same-file occurrence lexically, so marking the
        // strategy applicable for them would report a false `strategy_unavailable`.
        applicable:
          (parsedContext.sup.id === "c" || parsedContext.sup.id === "cpp") && def.kind === SymbolKind.Function,
        // `executed` means the required enclosing/module scan ran, not that it found uses. A
        // binding that exists only inside the function's own scope cannot see sibling calls.
        executed: sameFileOccurrenceExecuted(scope, localBinding),
      },
    }),
  });

  return {
    status: "ok",
    definition: def,
    references: refs,
    referenceCoverage,
    ...(provenance ? { provenance } : {}),
  };
}

function sameFileOccurrenceExecuted(scope: ScopeIndex, binding: Binding | undefined): boolean {
  if (!binding || binding.occurrencesComplete === false) return false;
  let mapped = false;
  let hasEnclosingFunctionBinding = false;
  for (const candidate of scope.allScopes) {
    const scopedBinding = candidate.map.get(binding.canonicalName);
    if (scopedBinding === binding) {
      mapped = true;
      if (candidate.kind !== "function") return true;
    } else if (candidate.kind !== "function" && scopedBinding?.kind === "function") {
      hasEnclosingFunctionBinding = true;
    }
  }
  // C prototypes and definitions share occurrences through an extra binding that is not the
  // scope map's canonical entry. That extra declaration still proves the enclosing scan ran.
  return !mapped && binding.kind === "function" && hasEnclosingFunctionBinding;
}

function shouldScanVerifiedReferences(
  def: SymbolDef,
  phpQualifiedNames: readonly string[],
  parsedContext: ParsedFileContext,
): boolean {
  if (phpQualifiedNames.length) return false;
  if (!supportsReceiverMemberNavigation(parsedContext.sup.id)) return false;
  return isReceiverMemberDefinition(def, parsedContext);
}

function shouldUseLocalNameAsExportFallback(def: SymbolDef, parsedContext: ParsedFileContext): boolean {
  return !isReceiverMemberDefinition(def, parsedContext);
}

function isReceiverMemberDefinition(def: SymbolDef, parsedContext: ParsedFileContext): boolean {
  if (def.isMember) return true;
  if (def.kind !== SymbolKind.Function) {
    return false;
  }
  const start = def.range.start;
  const position = {
    row: start.line - 1,
    column: start.column - 1,
  };
  let current: SyntaxNodeLike | null = parsedContext.tree.rootNode.descendantForPosition(position, position);
  let sawRustImplFunction = false;
  while (current) {
    if (
      current.type === "method_definition" ||
      current.type === "method_signature" ||
      current.type === "abstract_method_signature" ||
      current.type === "method_declaration" ||
      current.type === "method"
    ) {
      return true;
    }
    if (parsedContext.sup.id === "rust" && current.type === "function_item") {
      sawRustImplFunction = true;
    }
    if (sawRustImplFunction && current.type === "impl_item") {
      return true;
    }
    if (current.type === "function_declaration" || current.type === "program") {
      return false;
    }
    current = current.parent;
  }
  return false;
}

export async function collectNamespaceMemberRefs(
  file: string,
  ns: string,
  member: string,
  parsedContext?: ParsedFileContext,
  languageExtensions?: LanguageExtensionMap,
): Promise<Range[]> {
  const parsed = parsedContext ?? (await ensureParsedContext(file, undefined, languageExtensions));
  const sup = parsed.sup;
  const source = parsed.source;
  const tree = parsed.tree;
  const ranges: Range[] = [];

  const walk = (node: SyntaxNodeLike): void => {
    if (isMemberAccessNode(sup, node)) {
      const { object: obj, property: prop } = getMemberAccessParts(sup, node);
      if (obj && prop && isMemberObjectIdentifier(obj.type) && isMemberReferencePropertyIdentifier(sup, prop.type)) {
        const objectName = sliceText(obj, source);
        const propertyName = sliceText(prop, source);
        if (objectName === ns && propertyName === member) {
          ranges.push(toRange(prop));
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
