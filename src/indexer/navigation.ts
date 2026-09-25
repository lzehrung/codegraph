import { cTagRole } from "../languages/definitions/c.js";
import { supportForFileWithoutHeaderSample, type LanguageExtensionMap, type LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { ensureParsedContext, type ParsedFileContext } from "./parse-context.js";
import { getCompilationUnitPeers, IMPLICIT_UNIT_LANGUAGES } from "./compilation-units.js";
import {
  csharpAliasQualifiedLookupName,
  findCsharpPartialTypeEquivalents,
  innermostNamespaceImport,
  resolveMemberAccessDefinition,
  sharedOwnerMemberUnitComplete,
  resolveImplicitSelfMember,
  supportsReceiverMemberNavigation,
} from "./navigation-goto.js";
import {
  csharpLookupName,
  findClosestBinding,
  findClosestScopeBinding,
  findDeclarationNameNode,
  getOrBuildScopeIndex,
  resolveNamedDefinition,
} from "./navigation-local.js";
import { createNavigationProvenance, okGoToResult } from "./navigation-provenance.js";
import {
  findPhpImportAlias,
  getPhpQualifiedReference,
  inferPhpQualifiedReferenceImportType,
  isPhpCaseInsensitiveSymbolKind,
  normalizePhpQualifiedReference,
  phpLastIdentifierSegment,
} from "./navigation-php.js";
import {
  buildIndexedCandidateCoverage,
  buildPhpQualifiedNames,
  cppCanonicalStructuralExport,
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
import { resolveExport, resolveImported, resolvePhpExportByImportType } from "./navigation-resolve.js";
import { extractEnclosingBlock, extractLineContext, rangeContains, sameDef } from "./reference-context.js";
import { DEFAULT_REF_CONTEXT_LINES } from "./shared.js";
import type { ScopeIndex } from "./scope.js";
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
  cppOutOfLineOwnerPath,
  cppOutOfLineMemberName,
  cppOutOfLineMemberDeclarationNode,
  cppQualifiedNameSegments,
} from "../graphs/symbol-graph-detailed/receiver-calls.js";
import { cppBindingCallableShape, cppCallableShapeForNode, cppEquivalentCallableBindings } from "./cpp-callables.js";
import type { Binding } from "./scope-types.js";
import {
  cppUsingDeclarationTarget,
  resolveCppCallableBindings,
  resolveCppCollidingBinding,
  resolveCppQualifiedMemberContainer,
  resolveVisibleCppCallableNameAsync,
} from "./navigation-cpp.js";
import {
  type FindReferencesResult,
  type GoToRequest,
  type GoToResult,
  type ImportBinding,
  type ModuleIndex,
  type ProjectIndex,
  type Reference,
  type ResolutionProvenance,
  type SymbolDef,
  SymbolKind,
} from "./types.js";
import { findSqlReferences, goToSqlDefinition } from "../sql/navigation.js";

export { resolveExport, resolveImported } from "./navigation-resolve.js";
const CPP_MEMBER_CONTAINER_TYPES = new Set(["class_specifier", "struct_specifier", "union_specifier"]);

function phpImportTypeAtPosition(
  imports: readonly ImportBinding[],
  line: number,
  column: number,
): "class" | "function" | "const" | undefined {
  for (const imp of imports) {
    if (imp.kind !== "named" || imp.mechanism !== "php") continue;
    if (
      importBindingReferenceSites(imp).some((site) => rangeContains(site.range, { row: line + 1, column: column + 1 }))
    ) {
      return imp.phpImportType ?? "class";
    }
  }
  return undefined;
}

function phpImportMatchesDefinition(imp: ImportBinding, def: SymbolDef): boolean {
  if (imp.kind !== "named" || imp.mechanism !== "php") return true;
  const importType = imp.phpImportType ?? "class";
  if (importType === "function") return def.kind === SymbolKind.Function;
  if (importType === "const") return def.kind === SymbolKind.Variable;
  return def.kind === SymbolKind.Class || def.kind === SymbolKind.Interface || def.kind === SymbolKind.TypeAlias;
}

async function resolvePhpAliasDefinition(
  index: ProjectIndex,
  mod: ModuleIndex,
  file: FileId,
  localName: string,
  importType: "class" | "function" | "const",
): Promise<{ def: SymbolDef; targetFile: FileId } | null> {
  const imp = findPhpImportAlias(mod.imports, localName, importType);
  if (!imp) return null;
  let targetFile = typeof imp.resolved === "string" ? imp.resolved : undefined;
  if (!targetFile && index.projectRoot) {
    const resolved = await resolveImportSpecifier(index.projectRoot, file, imp.from, "php", {
      phpImportType: importType,
    });
    if (typeof resolved === "string") targetFile = resolved;
  }
  if (!targetFile) return null;
  const resolved = resolveImported(index, { ...imp, resolved: targetFile }, imp.imported);
  if (!resolved || "namespace" in resolved) return null;
  return { def: resolved, targetFile };
}

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

  const phpImportType =
    sup.id === "php"
      ? (phpImportTypeAtPosition(mod.imports, pos.row, pos.column) ?? inferPhpQualifiedReferenceImportType(node))
      : undefined;

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
    let memberAccessNode: SyntaxNodeLike | null = null;
    if (node.parent && isMemberAccessNode(sup, node.parent)) {
      memberAccessNode = node.parent;
    } else if (
      node.parent?.type === "template_function" &&
      node.parent.parent &&
      isMemberAccessNode(sup, node.parent.parent)
    ) {
      memberAccessNode = node.parent.parent;
    }
    if (sup.id === "cpp") {
      while (memberAccessNode?.parent && isMemberAccessNode(sup, memberAccessNode.parent)) {
        memberAccessNode = memberAccessNode.parent;
      }
    }
    const scopeIndex = memberAccessNode ? getOrBuildScopeIndex(index, file, source, sup, mod, tree) : null;
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
              const receiverName = sliceText(receiver, source);
              const binding = findClosestScopeBinding(scopeIndex, receiverName, receiver, sup);
              if (
                binding?.kind === "importDefault" ||
                binding?.kind === "importNamed" ||
                binding?.kind === "namespace"
              ) {
                return null;
              }
              return findClosestBinding(scopeIndex, file, receiverName, receiver, sup, source);
            },
          }
        : {}),
    });
    if (memberAccessResult) {
      return memberAccessResult;
    }
    if (sup.id === "cpp" && scopeIndex && memberAccessNode) {
      const qualifiedName = cppQualifiedNameSegments(memberAccessNode, source).join("::");
      const qualifiedBindings = scopeIndex.cppQualifiedFunctionBindings.get(qualifiedName);
      if (qualifiedBindings) {
        const target = resolveCppCallableBindings(file, qualifiedBindings, node, source);
        if (!target) return { status: "not_found", reason: "Ambiguous C++ overload" };
        return okGoToResult(index, target, {
          resolution: "exact",
          confidence: "high",
        });
      }
      const visibleQualified = await resolveVisibleCppCallableNameAsync(index, mod, qualifiedName, node, source, {
        file,
        parsed: { source, tree, sup },
      });
      if (visibleQualified !== undefined) {
        if (!visibleQualified) return { status: "not_found", reason: "Ambiguous C++ overload" };
        return okGoToResult(index, visibleQualified, {
          resolution: "exact",
          confidence: "high",
        });
      }
      const qualifiedDefinition = resolveNamedDefinition(index, mod, file, sup, qualifiedName);
      if (qualifiedDefinition) return qualifiedDefinition;
    }
    if (isUnresolvedReceiverMemberProperty(sup, node)) {
      return { status: "not_found", reason: "No matching receiver member definition" };
    }
  }

  if (sup.id === "php" && phpQualifiedReference && index.projectRoot) {
    const normalizedQualifiedReference = normalizePhpQualifiedReference(phpQualifiedReference, source, tree, node);
    if (normalizedQualifiedReference?.includes("\\")) {
      const qualifiedImportType = phpImportType;
      const resolvedTarget = await resolveImportSpecifier(
        index.projectRoot,
        file,
        normalizedQualifiedReference,
        "php",
        {
          ...(qualifiedImportType ? { phpImportType: qualifiedImportType } : {}),
        },
      );
      if (typeof resolvedTarget === "string") {
        const exportedName = normalizedQualifiedReference.split("\\").filter(Boolean).pop() ?? null;
        if (exportedName) {
          const hit = resolvePhpExportByImportType(index, resolvedTarget, exportedName, qualifiedImportType);
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
    const lookupName = sup.id === "csharp" ? csharpLookupName(node, source, name) : name;
    const csharpExportName =
      sup.id === "csharp" ? csharpAliasQualifiedLookupName(node, source, lookupName, mod.imports) : lookupName;
    if (sup.id === "php") {
      const alias = await resolvePhpAliasDefinition(index, mod, file, name, phpImportType ?? "const");
      if (alias) {
        return okGoToResult(index, alias.def, {
          via: { importedFrom: alias.targetFile, exportedName: alias.def.localName },
          resolution: "import",
          confidence: "high",
        });
      }
    }
    const scopeIndex = getOrBuildScopeIndex(index, file, source, sup, mod, tree);
    const closestBinding = findClosestScopeBinding(scopeIndex, lookupName, node, sup);
    const usingTarget =
      sup.id === "cpp" && closestBinding ? cppUsingDeclarationTarget(closestBinding, source) : undefined;
    if (usingTarget) {
      const visible = await resolveVisibleCppCallableNameAsync(index, mod, usingTarget, node, source, {
        file,
        parsed: { source, tree, sup },
      });
      if (visible) return okGoToResult(index, visible, { resolution: "import", confidence: "high" });
      if (visible === undefined) {
        const target = resolveNamedDefinition(index, mod, file, sup, usingTarget);
        if (target) return target;
      }
      return { status: "not_found", reason: "No unique C++ using-declaration target" };
    }
    const cppCollision =
      sup.id === "cpp" && closestBinding ? resolveCppCollidingBinding(file, closestBinding, node, source) : undefined;
    if (cppCollision !== undefined) {
      if (!cppCollision) return { status: "not_found", reason: "Ambiguous C++ overload" };
      return okGoToResult(index, cppCollision, {
        resolution: "exact",
        confidence: "high",
      });
    }
    const local = findClosestBinding(scopeIndex, file, lookupName, node, sup, source);
    if (
      sup.id === "swift" &&
      local &&
      closestBinding &&
      scopeIndex.allScopes[0]?.map.get(closestBinding.canonicalName) === closestBinding
    ) {
      // Method-local bindings still win; only module-level names yield to proven members.
      const member = await resolveImplicitSelfMember(index, mod, node, lookupName, source, sup.id);
      if (member) return okGoToResult(index, member, { resolution: "member-access", confidence: "medium" });
    }
    if (local) {
      return okGoToResult(index, local, {
        resolution: "exact",
        confidence: "high",
      });
    }
    if (sup.id === "cpp" && closestBinding?.kind === "function" && cppBindingCallableShape(closestBinding)) {
      return { status: "not_found", reason: "Ambiguous C++ overload" };
    }

    if (sup.id === "cpp") {
      const visible = await resolveVisibleCppCallableNameAsync(index, mod, name, node, source, {
        file,
        parsed: { source, tree, sup },
      });
      if (visible !== undefined) {
        if (!visible) return { status: "not_found", reason: "Ambiguous C++ overload" };
        return okGoToResult(index, visible, {
          resolution: "exact",
          confidence: "high",
        });
      }
    }

    if (sup.supportsCrossModuleSymbols) {
      let cNamespace: "tag" | "ordinary" | undefined;
      if (sup.id === "c") cNamespace = cTagRole(node) ? "tag" : "ordinary";
      const resolvedName = resolveNamedDefinition(
        index,
        mod,
        file,
        sup,
        sup.id === "csharp" ? csharpExportName : lookupName,
        cNamespace,
        node.startIndex,
      );
      if (sup.id === "swift" || sup.id === "csharp") {
        // Inside a type, a proven member takes precedence over a same-named module name. C#
        // partial members declared in another file reach this path only as invocation callees.
        const visible = await resolveImplicitSelfMember(index, mod, node, lookupName, source, sup.id);
        if (visible) return okGoToResult(index, visible, { resolution: "member-access", confidence: "medium" });
        if (sup.id === "swift" && resolvedName?.status === "ok" && resolvedName.definition.isMember) {
          return { status: "not_found", reason: "No matching Swift member definition" };
        }
      }
      if (resolvedName) return resolvedName;
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
    parent.type === "alias_qualified_name" ||
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

/**
 * Proven equivalent callable definition family for one definition site.
 *
 * Returns the incoming definition first — enriched to its indexed SymbolDef when the definition
 * file's module.locals holds an exact identity match (same file, kind, localName, and full range
 * span), restoring metadata such as `isMember` — followed by every equivalent
 * declaration/definition that reference collection itself proves: same-scope prototype/definition
 * pairs (C and C++), namespace-qualified equivalents, the in-class declaration for out-of-line
 * member definitions, and out-of-line definitions for in-class member declarations linked through
 * the export index. Matching stays conservative: candidates must already exist in the definition
 * file's scope bindings or the export index with a proven signature; no name-only or arity-only
 * equivalence is introduced, and overload sets are never collapsed.
 *
 * `parsedContext` is optional; when omitted the definition file is parsed on demand. Definitions
 * outside C/C++ return just the enriched definition.
 */
export async function getCppEquivalentCallableDefinitions(
  index: ProjectIndex,
  def: SymbolDef,
  parsedContext?: ParsedFileContext,
): Promise<SymbolDef[]> {
  const family = await cppEquivalentCallableFamily(index, def, parsedContext);
  return [family.definition, ...family.equivalents];
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
  if (def.cTag) {
    const canonical = await goToDefinition(index, {
      file: def.file,
      line: def.range.start.line,
      column: def.range.start.column,
    });
    if (canonical.status === "ok") {
      def = canonical.definition;
      provenance = canonical.provenance;
    }
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
  let cNamespace: "tag" | "ordinary" | undefined;
  if (parsedContext.sup.id === "c") cNamespace = def.cTag ? "tag" : "ordinary";
  const exportOptions = cNamespace ? { cNamespace } : undefined;

  const mod = index.byFile.get(fileIdentityKey(definitionFile));
  if (!mod) return { status: "not_found", reason: "Module not found" };

  const refs: Reference[] = [];
  const seenRefs = new Map<string, number>();
  const collectionLimit = maxReferences !== undefined ? maxReferences + 1 : undefined;
  const hasReachedCollectionLimit = (): boolean => collectionLimit !== undefined && refs.length >= collectionLimit;
  const remainingCollectionSlots = (): number | undefined =>
    collectionLimit !== undefined ? Math.max(0, collectionLimit - refs.length) : undefined;
  const referenceMetadataRank = (ref: Reference): number => {
    if (ref.via?.importBinding === "imported") return 2;
    return ref.via?.namespaceMember ? 1 : 0;
  };
  const pushRef = (ref: Reference): void => {
    if (!includeReference(ref)) return;
    const key = referenceSiteKey(ref.file, ref.range);
    const existingIndex = seenRefs.get(key);
    if (existingIndex !== undefined) {
      const existing = refs[existingIndex]!;
      if (referenceMetadataRank(ref) > referenceMetadataRank(existing)) {
        refs[existingIndex] = ref;
      }
      return;
    }
    if (hasReachedCollectionLimit()) return;
    seenRefs.set(key, refs.length);
    refs.push(ref);
  };

  const family = await cppEquivalentCallableFamily(index, def, parsedContext);
  const definition = family.definition;
  const referenceDef = family.referenceDef;
  const localBinding = family.localBinding;
  pushRef({ file: definitionFile, range: definition.range });
  const receiverMemberDefinition = isReceiverMemberDefinition(definition, parsedContext, !!family.receiverOwner);
  const csharpPartialEquivalents =
    parsedContext.sup.id === "csharp" &&
    !definition.isMember &&
    (definition.kind === SymbolKind.Class ||
      definition.kind === SymbolKind.Interface ||
      definition.kind === SymbolKind.TypeAlias)
      ? await findCsharpPartialTypeEquivalents(index, definition)
      : [];
  const equivalentDefinitions = [...family.equivalents, ...csharpPartialEquivalents];
  for (const equivalent of equivalentDefinitions) {
    pushRef({ file: equivalent.file, range: equivalent.range });
  }
  const matchesReferenceDefinition = (candidate: SymbolDef): boolean =>
    sameDef(candidate, definition, index.languageExtensions) ||
    equivalentDefinitions.some((equivalent) => sameDef(candidate, equivalent, index.languageExtensions));

  const exportedNames: string[] = [];
  for (const candidate of [definition, ...equivalentDefinitions]) {
    const candidateModule = index.byFile.get(fileIdentityKey(candidate.file));
    for (const entry of candidateModule?.exports ?? []) {
      if (
        entry.type === "local" &&
        sameDef(entry.target, candidate, index.languageExtensions) &&
        !exportedNames.includes(entry.exportedAs)
      ) {
        exportedNames.push(entry.exportedAs);
      }
    }
  }
  if (!exportedNames.length && !receiverMemberDefinition) {
    exportedNames.push(definition.localName);
  }

  const exportedNameSet = new Set(exportedNames);
  const phpQualifiedNames = await buildPhpQualifiedNames(index, definitionFile, definition);
  const scansReceiverReferences = shouldScanVerifiedReferences(definition, parsedContext, receiverMemberDefinition);
  const scansNamespaceReferences =
    parsedContext.sup.id === "csharp" &&
    !definition.isMember &&
    (definition.kind === SymbolKind.Class ||
      definition.kind === SymbolKind.Interface ||
      definition.kind === SymbolKind.TypeAlias);
  const requiresSameFileVerifiedScan =
    ((parsedContext.sup.id === "c" || parsedContext.sup.id === "cpp") &&
      definition.kind === SymbolKind.Function &&
      !receiverMemberDefinition) ||
    scansNamespaceReferences;
  let sameFileVerifiedScanExecuted = false;
  if (localBinding && localBinding.occurrencesComplete !== false && !scansReceiverReferences) {
    for (const occurrence of localBinding.occurrences) {
      if (hasReachedCollectionLimit()) break;
      pushRef({ file: definitionFile, range: occurrence });
    }
  }
  if (requiresSameFileVerifiedScan && !hasReachedCollectionLimit()) {
    const ranges = await collectVerifiedNamedNodeReferences(
      index,
      definitionFile,
      referenceDef.localName,
      referenceDef,
      (params, parsed) => goToDefinition(index, params, parsed),
      remainingCollectionSlots(),
      verifiedReferenceFilter(definitionFile),
      undefined,
      equivalentDefinitions,
    );
    sameFileVerifiedScanExecuted = true;
    for (const { range, provenance, via } of ranges) {
      if (hasReachedCollectionLimit()) break;
      pushRef({
        file: definitionFile,
        range,
        ...(via ? { via } : {}),
        ...(provenance ? { provenance } : {}),
      });
    }
  }

  let candidateFiles = [
    ...new Map(
      [referenceDef, ...equivalentDefinitions]
        .flatMap((candidate) =>
          getCachedReferenceCandidateFiles(
            index,
            candidate,
            exportedNames,
            !!phpQualifiedNames.length,
            parsedContext.sup.id,
          ),
        )
        .map((candidateFile) => [fileIdentityKey(candidateFile), candidateFile]),
    ).values(),
  ].sort((left, right) => left.localeCompare(right));
  // Candidates that share a compilation unit with the definition (or an equivalent
  // declaration) can name it without an import edge; the per-candidate scan below treats
  // them as bare-name reference sources in addition to the import-derived branches.
  const unitPeerKeys = new Set<string>();
  for (const candidate of [referenceDef, ...equivalentDefinitions]) {
    for (const unitPeer of getCompilationUnitPeers(
      index,
      candidate.file,
      parsedContext.sup.id === "csharp" ? { csharpQualifiedName: true } : undefined,
    ).files) {
      unitPeerKeys.add(fileIdentityKey(unitPeer));
    }
  }
  // A bloom filter holds each candidate file's identifiers in that file's own spelling, and a
  // probe can only test one spelling. PHP resolves class, interface, trait, enum, and function
  // names case-insensitively, so `new \App\sErViCe()` must still match a `Service` definition.
  // `buildBloomFilterFromSource` stores every PHP file's identifiers both in their own spelling
  // and ASCII-case-folded, so folding the probe's last identifier segment here narrows those
  // kinds exactly instead of skipping narrowing and walking every indexed PHP file. Variables,
  // properties, and constants stay case-sensitive and probe with their own spelling.
  const phpCaseInsensitiveDefinition = phpQualifiedNames.length && isPhpCaseInsensitiveSymbolKind(definition.kind);
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
      return probeNames.some((candidateName) =>
        filter.mightContain(normalizeIdentifier(phpLastIdentifierSegment(candidateName))),
      );
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
        if (resolved?.kind === "resolved" && !matchesReferenceDefinition(resolved.def)) continue;
        const remainingReferences = remainingCollectionSlots();
        const ranges = await collectVerifiedNamedNodeReferences(
          index,
          fileId,
          entry.sourceSpecifier,
          definition,
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
      if (cNamespace && imp.kind === "named" && (imp.cNamespace ?? "ordinary") !== cNamespace) continue;
      const targetFile = typeof imp.resolved === "string" ? imp.resolved : undefined;
      const bindingSites = importBindingReferenceSites(imp);
      let verifiedBindingMatches: boolean | undefined;
      const bindingMatchesDefinition = async (): Promise<boolean> => {
        if (verifiedBindingMatches !== undefined) return verifiedBindingMatches;
        verifiedBindingMatches = false;
        if (!phpImportMatchesDefinition(imp, definition)) return verifiedBindingMatches;
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
          if (resolved.status === "ok" && matchesReferenceDefinition(resolved.definition)) {
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
        if (!hasReachedCollectionLimit() && imp.kind === "named") {
          const ranges = await collectVerifiedNamedNodeReferences(
            index,
            fileId,
            imp.local,
            definition,
            (params, parsed) => goToDefinition(index, params, parsed),
            remainingCollectionSlots(),
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
        }
        continue;
      }
      for (const exportedName of exportedNames) {
        if (hasReachedCollectionLimit()) break;
        if (imp.kind === "namespace") {
          const hit = resolveExport(index, targetFile, exportedName, exportOptions);
          const matchesDef =
            hit?.kind === "resolved"
              ? matchesReferenceDefinition(hit.def)
              : imp.kind === "namespace" &&
                [definition, ...equivalentDefinitions].some(
                  (candidate) => fileIdentityKey(targetFile) === fileIdentityKey(candidate.file),
                );
          if (!matchesDef) continue;
          const parsed = await ensureCandidateParsed();
          const ranges = await collectNamespaceMemberRefs(
            fileId,
            imp.localNS,
            exportedName,
            parsed,
            index.languageExtensions,
            imp,
            module.imports,
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
          const result = resolveImported(index, imp, exportedName, exportOptions);
          const matchesDef = !!result && !("namespace" in result) && matchesReferenceDefinition(result);
          if (
            !matchesDef &&
            !cppCanonicalStructuralExport(index, targetFile, exportedName, definition, parsedContext.sup.id)
          )
            continue;
          if (hasExpandedNamedImport(module, targetFile, exportedName)) {
            continue;
          }
          const remainingReferences = remainingCollectionSlots();
          const ranges = await collectVerifiedNamedNodeReferences(
            index,
            fileId,
            parsedContext.sup.id === "cpp" ? (exportedName.split("::").pop() ?? exportedName) : exportedName,
            definition,
            (params, parsed) => goToDefinition(index, params, parsed),
            remainingReferences,
            verifiedReferenceFilter(fileId),
            undefined,
            equivalentDefinitions,
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
          const hit = resolveExport(index, targetFile, exported, exportOptions);
          let matchesDef = hit?.kind === "resolved" && matchesReferenceDefinition(hit.def);
          let attributedByProof = matchesDef;
          if (!matchesDef && bindingSites.length) {
            matchesDef = await bindingMatchesDefinition();
            attributedByProof = matchesDef;
          }
          if (
            !matchesDef &&
            cppCanonicalStructuralExport(index, targetFile, exported, definition, parsedContext.sup.id)
          ) {
            // Recover candidates, but prove each overload call through goToDefinition.
            // Structural visibility alone cannot attribute the import token.
            matchesDef = true;
          }
          if (!matchesDef) continue;
          if (attributedByProof) {
            for (const site of bindingSites) {
              pushRef({
                file: fileId,
                range: site.range,
                via: { import: imp, importBinding: site.importBinding },
              });
            }
          }
          const scansQualifiedCppImport =
            parsedContext.sup.id === "cpp" && imp.kind === "named" && imp.local.includes("::");
          if (imp.kind === "named" || fileIdentityKey(targetFile) !== fileIdentityKey(definitionFile)) {
            const remainingReferences = remainingCollectionSlots();
            const ranges = await collectVerifiedNamedNodeReferences(
              index,
              fileId,
              scansQualifiedCppImport ? (imp.local.split("::").pop() ?? imp.local) : imp.local,
              definition,
              (params, parsed) => goToDefinition(index, params, parsed),
              remainingReferences,
              verifiedReferenceFilter(fileId),
              undefined,
              equivalentDefinitions,
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

    // A unit peer names the definition directly (Go and JVM package siblings, C# namespace
    // peers, Swift module siblings), with no import binding to attribute. The single bare-name
    // scan keeps reference sites in agreement with what bare-name resolution can prove.
    if (
      !definition.isMember &&
      fileIdentityKey(fileId) !== fileIdentityKey(definitionFile) &&
      unitPeerKeys.has(fileIdentityKey(fileId)) &&
      !hasReachedCollectionLimit()
    ) {
      const ranges = await collectVerifiedNamedNodeReferences(
        index,
        fileId,
        referenceDef.localName,
        definition,
        (params, parsed) => goToDefinition(index, params, parsed),
        remainingCollectionSlots(),
        verifiedReferenceFilter(fileId),
        undefined,
        equivalentDefinitions,
      );
      for (const { range, provenance, via } of ranges) {
        if (hasReachedCollectionLimit()) break;
        pushRef({ file: fileId, range, ...(via ? { via } : {}), ...(provenance ? { provenance } : {}) });
      }
    }

    if (phpQualifiedNames.length) {
      const remainingReferences = remainingCollectionSlots();
      const ranges = await collectVerifiedNamedNodeReferences(
        index,
        fileId,
        referenceDef.localName,
        referenceDef,
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

  const receiverProofUnavailableFiles = new Map<string, FileId>();
  const receiverScannedFiles: FileId[] = [];
  if (scansReceiverReferences) {
    for (const fileId of Array.from(index.byFile.values(), (module) => module.file).sort((left, right) =>
      left.localeCompare(right),
    )) {
      if (hasReachedCollectionLimit()) break;
      receiverScannedFiles.push(fileId);
      const filter = index.bloomFilters?.get(fileIdentityKey(fileId));
      const candidateSupport = supportForFileWithoutHeaderSample(fileId, index.languageExtensions);
      // Bloom filters store folded PHP identifiers in addition to their source spelling.
      const normalizedName = candidateSupport?.normalizeIdentifier(referenceDef.localName) ?? referenceDef.localName;
      const canonicalName =
        candidateSupport?.id === "php" && isPhpCaseInsensitiveSymbolKind(definition.kind)
          ? foldPhpIdentifierCase(normalizedName)
          : normalizedName;
      if (filter && !filter.mightContain(canonicalName)) continue;
      const remainingReferences = remainingCollectionSlots();
      const ranges = await collectVerifiedNamedNodeReferences(
        index,
        fileId,
        referenceDef.localName,
        referenceDef,
        (params, parsed) => goToDefinition(index, params, parsed),
        remainingReferences,
        verifiedReferenceFilter(fileId),
        (unavailableFile) => receiverProofUnavailableFiles.set(fileIdentityKey(unavailableFile), unavailableFile),
        equivalentDefinitions,
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
  // Top-level implicit-unit names and C# partial / Swift shared-owner members are both bounded
  // by the source-unit relation; an unproven boundary leaves their reference set partial.
  const implicitUnitComplete =
    !definition.isMember && IMPLICIT_UNIT_LANGUAGES[parsedContext.sup.id]
      ? getCompilationUnitPeers(
          index,
          definitionFile,
          parsedContext.sup.id === "csharp" ? { csharpQualifiedName: true } : undefined,
        ).complete
      : await sharedOwnerMemberUnitComplete(index, definition);
  const referenceCoverage = buildIndexedCandidateCoverage({
    index,
    def: definition,
    languageId: parsedContext.sup.id,
    exportedNames,
    candidateFiles,
    scannedFiles,
    truncated,
    strategies: describeReferenceStrategies({
      languageId: parsedContext.sup.id,
      phpQualifiedNames,
      sameFileOccurrence: {
        // C/C++ callable siblings and reopened C# namespace regions can refer to a
        // declaration without sharing its lexical scope. Verify those uses through
        // navigation; parameters and local variables remain lexical-only.
        applicable: requiresSameFileVerifiedScan,
        executed: sameFileVerifiedScanExecuted,
      },
      // An unproven compilation-unit boundary means the peer universe may extend beyond the
      // enumerated files, so coverage must not imply that every possible consumer was scanned.
      ...(implicitUnitComplete !== null
        ? { implicitUnitPeers: { applicable: true, executed: implicitUnitComplete } }
        : {}),
    }),
    strategyUnavailableFiles: [...receiverProofUnavailableFiles.values()],
  });

  return {
    status: "ok",
    definition,
    references: refs,
    referenceCoverage,
    ...(provenance ? { provenance } : {}),
  };
}

function syntaxNodeForDefinition(parsedContext: ParsedFileContext, def: SymbolDef): SyntaxNodeLike {
  const position = {
    row: def.range.start.line - 1,
    column: def.range.start.column - 1,
  };
  return parsedContext.tree.rootNode.descendantForPosition(position, position);
}

/**
 * Restores indexed metadata for definitions that arrive without it — impact fabricates reference
 * defs from changed-symbol projections, dropping fields such as `isMember`. Matching is exact
 * identity against the definition file's module.locals: same kind, localName, and full range span.
 * Definitions without byte indices or without a matching local are returned unchanged.
 */
function indexedDefinitionByIdentity(index: ProjectIndex, def: SymbolDef): SymbolDef {
  const mod = index.byFile.get(fileIdentityKey(def.file));
  if (!mod) return def;
  const startIndex = def.range.start.index;
  const endIndex = def.range.end.index;
  if (startIndex === undefined || endIndex === undefined) return def;
  return (
    mod.locals.find(
      (candidate) =>
        candidate.kind === def.kind &&
        candidate.localName === def.localName &&
        candidate.range.start.index === startIndex &&
        candidate.range.end.index === endIndex,
    ) ?? def
  );
}

/** Equivalence context shared by reference collection and getCppEquivalentCallableDefinitions. */
type CppEquivalentCallableFamily = {
  /** Incoming definition enriched to its indexed SymbolDef when module.locals holds an exact identity match. */
  definition: SymbolDef;
  /** Definition with the out-of-line member name normalized (Box::helper -> helper) for reference scans. */
  referenceDef: SymbolDef;
  /** Resolved receiver owner for out-of-line member definitions (e.g. Box for Box::helper). */
  receiverOwner: SymbolDef | null;
  /** Definition-file scope binding at the definition site, when that scope registers one. */
  localBinding: Binding | undefined;
  /** Proven equivalent declarations/definitions, excluding definition itself. */
  equivalents: SymbolDef[];
};

/**
 * Single calculation behind reference collection and getCppEquivalentCallableDefinitions: resolves
 * the receiver owner, the normalized reference name, the definition-site scope binding, and the
 * proven equivalent definition family for one callable definition site.
 */
async function cppEquivalentCallableFamily(
  index: ProjectIndex,
  def: SymbolDef,
  parsedContext?: ParsedFileContext,
): Promise<CppEquivalentCallableFamily> {
  const definition = indexedDefinitionByIdentity(index, def);
  const mod = index.byFile.get(fileIdentityKey(definition.file));
  if (!mod) {
    return { definition, referenceDef: definition, receiverOwner: null, localBinding: undefined, equivalents: [] };
  }
  const context =
    parsedContext ??
    (await ensureParsedContext(
      definition.file,
      index.parsed?.get(fileIdentityKey(definition.file)),
      index.languageExtensions,
    ));
  const definitionNameNode = syntaxNodeForDefinition(context, definition);
  const receiverOwner = await cppOutOfLineReceiverOwner(index, mod, definition, context, definitionNameNode);
  const memberName = receiverOwner ? cppOutOfLineMemberName(definitionNameNode, context.source, context.sup) : null;
  const referenceDef =
    memberName && memberName !== definition.localName ? { ...definition, localName: memberName } : definition;
  const normalizedLocalName = context.sup.normalizeIdentifier(referenceDef.localName);
  const scope = getCachedScope(index, definition.file, mod, context);
  const localBindings = scope.bindings.get(normalizedLocalName) ?? [];
  const localBinding = localBindings.find(
    (binding) => binding.def && binding.def.start.index === definition.range.start.index,
  );
  let sameFileFunctionBindings: readonly Binding[] = localBindings;
  if (context.sup.id === "cpp") {
    sameFileFunctionBindings = localBinding ? cppEquivalentCallableBindings(localBinding) : [];
  }
  const sameFileFunctionEquivalentDefinitions =
    (context.sup.id === "c" || context.sup.id === "cpp") && definition.kind === SymbolKind.Function
      ? sameFileFunctionBindings.flatMap((binding) => {
          const bindingRange = binding.def;
          if (!bindingRange || bindingRange.start.index === definition.range.start.index) return [];
          const local = mod.locals.find(
            (candidate) =>
              candidate.kind === SymbolKind.Function &&
              candidate.localName === definition.localName &&
              candidate.range.start.index === bindingRange.start.index &&
              candidate.range.end.index === bindingRange.end.index,
          );
          return local ? [local] : [];
        })
      : [];
  let equivalents: SymbolDef[];
  if (receiverOwner) {
    equivalents = await cppOutOfLineEquivalentDefinitions(
      index,
      referenceDef,
      context,
      definitionNameNode,
      receiverOwner,
    );
  } else if (definition.isMember && context.sup.id === "cpp") {
    equivalents = await cppInClassMemberEquivalentDefinitions(index, definition, context, definitionNameNode);
  } else if (context.sup.id === "cpp") {
    equivalents = [
      ...sameFileFunctionEquivalentDefinitions,
      ...(await cppNamespaceFunctionEquivalentDefinitions(index, definition, context, definitionNameNode)),
    ];
  } else {
    equivalents = sameFileFunctionEquivalentDefinitions;
  }
  return { definition, referenceDef, receiverOwner, localBinding, equivalents };
}

async function cppOutOfLineReceiverOwner(
  index: ProjectIndex,
  mod: ModuleIndex,
  def: SymbolDef,
  parsedContext: ParsedFileContext,
  definitionNameNode: SyntaxNodeLike,
): Promise<SymbolDef | null> {
  if (parsedContext.sup.id !== "cpp" || def.kind !== SymbolKind.Function) return null;
  const ownerPath = cppOutOfLineOwnerPath(definitionNameNode, parsedContext.source, parsedContext.sup);
  return ownerPath ? await resolveCppQualifiedMemberContainer(index, mod, ownerPath) : null;
}

async function cppOutOfLineEquivalentDefinitions(
  index: ProjectIndex,
  def: SymbolDef,
  parsedContext: ParsedFileContext,
  definitionNameNode: SyntaxNodeLike,
  owner: SymbolDef,
): Promise<SymbolDef[]> {
  const ownerModule = index.byFile.get(fileIdentityKey(owner.file));
  if (!ownerModule) return [];
  const ownerParsed = await ensureParsedContext(
    owner.file,
    index.parsed?.get(fileIdentityKey(owner.file)),
    index.languageExtensions,
  );
  const ownerNameNode = syntaxNodeForDefinition(ownerParsed, owner);
  const declaration = cppOutOfLineMemberDeclarationNode(
    definitionNameNode,
    def.localName,
    ownerNameNode,
    ownerParsed.source,
    parsedContext.sup,
  );
  if (!declaration) return [];
  const normalizedName = parsedContext.sup.normalizeIdentifier(def.localName);
  return ownerModule.locals.filter(
    (candidate) =>
      parsedContext.sup.normalizeIdentifier(candidate.localName) === normalizedName &&
      candidate.range.start.index === declaration.nameNode.startIndex,
  );
}

async function cppInClassMemberEquivalentDefinitions(
  index: ProjectIndex,
  def: SymbolDef,
  parsedContext: ParsedFileContext,
  definitionNameNode: SyntaxNodeLike,
): Promise<SymbolDef[]> {
  if (def.kind !== SymbolKind.Function) return [];
  const ownerSegments: string[][] = [];
  let current: SyntaxNodeLike | null = definitionNameNode.parent;
  while (current) {
    if (CPP_MEMBER_CONTAINER_TYPES.has(current.type) || current.type === "namespace_definition") {
      const name = current.childForFieldName("name");
      if (!name) return [];
      ownerSegments.unshift(cppQualifiedNameSegments(name, parsedContext.source));
    }
    current = current.parent;
  }
  const owners = ownerSegments.flat();
  if (!owners.length) return [];
  const qualifiedName = [...owners, def.localName].join("::");
  const expectedShape = cppCallableShapeForNode(definitionNameNode);
  if (!expectedShape) return [];

  const equivalents = new Map<string, SymbolDef>();
  for (const module of index.byFile.values()) {
    for (const entry of module.exports) {
      if (
        entry.type !== "local" ||
        entry.exportedAs !== qualifiedName ||
        entry.target.kind !== SymbolKind.Function ||
        sameDef(entry.target, def, index.languageExtensions)
      ) {
        continue;
      }
      const candidateParsed = await ensureParsedContext(
        entry.target.file,
        index.parsed?.get(fileIdentityKey(entry.target.file)),
        index.languageExtensions,
      );
      const candidateNode = syntaxNodeForDefinition(candidateParsed, entry.target);
      const candidateShape = cppCallableShapeForNode(candidateNode);
      if (!candidateShape) continue;
      let explicitSpecialization = false;
      let current: SyntaxNodeLike | null = candidateNode;
      while (current) {
        if (
          current.type === "template_declaration" &&
          /^\s*template\s*<\s*>/u.test(sliceText(current, candidateParsed.source))
        ) {
          explicitSpecialization = true;
          break;
        }
        current = current.parent;
      }
      const arityMatches =
        candidateShape.minArity === expectedShape.minArity && candidateShape.maxArity === expectedShape.maxArity;
      if (candidateShape.signature !== expectedShape.signature && !(explicitSpecialization && arityMatches)) {
        continue;
      }
      equivalents.set(referenceSiteKey(entry.target.file, entry.target.range), entry.target);
    }
  }
  return [...equivalents.values()];
}

function shouldScanVerifiedReferences(
  def: SymbolDef,
  parsedContext: ParsedFileContext,
  receiverMemberDefinition: boolean,
): boolean {
  if (parsedContext.sup.id === "php" && !isPhpCaseInsensitiveSymbolKind(def.kind)) return false;
  return supportsReceiverMemberNavigation(parsedContext.sup.id) && receiverMemberDefinition;
}
async function cppNamespaceFunctionEquivalentDefinitions(
  index: ProjectIndex,
  def: SymbolDef,
  parsedContext: ParsedFileContext,
  definitionNameNode: SyntaxNodeLike,
): Promise<SymbolDef[]> {
  if (parsedContext.sup.id !== "cpp" || def.kind !== SymbolKind.Function) return [];
  const ownerPath = cppOutOfLineOwnerPath(definitionNameNode, parsedContext.source, parsedContext.sup);
  const namespacePath: string[][] = [];
  if (!ownerPath) {
    let current = definitionNameNode.parent;
    while (current) {
      if (CPP_MEMBER_CONTAINER_TYPES.has(current.type)) return [];
      if (current.type === "namespace_definition") {
        const name = current.childForFieldName("name");
        if (!name) return [];
        namespacePath.unshift(cppQualifiedNameSegments(name, parsedContext.source));
      }
      current = current.parent;
    }
  }
  const owners = ownerPath ?? namespacePath.flat();
  if (!owners.length) return [];
  const memberName =
    cppOutOfLineMemberName(definitionNameNode, parsedContext.source, parsedContext.sup) ?? def.localName;
  const qualifiedName = [...owners, memberName].join("::");
  const expectedShape = cppCallableShapeForNode(definitionNameNode);
  if (!expectedShape) return [];

  const equivalents = new Map<string, SymbolDef>();
  for (const module of index.byFile.values()) {
    for (const entry of module.exports) {
      if (
        entry.type !== "local" ||
        entry.exportedAs !== qualifiedName ||
        entry.target.kind !== SymbolKind.Function ||
        sameDef(entry.target, def, index.languageExtensions)
      ) {
        continue;
      }
      const candidateParsed = await ensureParsedContext(
        entry.target.file,
        index.parsed?.get(fileIdentityKey(entry.target.file)),
        index.languageExtensions,
      );
      const candidateNode = syntaxNodeForDefinition(candidateParsed, entry.target);
      if (cppCallableShapeForNode(candidateNode)?.signature !== expectedShape.signature) continue;
      equivalents.set(referenceSiteKey(entry.target.file, entry.target.range), entry.target);
    }
  }
  return [...equivalents.values()];
}

function isReceiverMemberDefinition(
  def: SymbolDef,
  parsedContext: ParsedFileContext,
  hasCppOutOfLineOwner: boolean,
): boolean {
  if (def.isMember || hasCppOutOfLineOwner) return true;
  if (def.kind !== SymbolKind.Function) return false;
  let current: SyntaxNodeLike | null = syntaxNodeForDefinition(parsedContext, def);
  let sawCppFunction = false;
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
    if (parsedContext.sup.id === "cpp") {
      if (current.type === "function_definition") sawCppFunction = true;
      if (sawCppFunction && CPP_MEMBER_CONTAINER_TYPES.has(current.type)) return true;
    }
    if (parsedContext.sup.id === "rust" && current.type === "function_item") {
      sawRustImplFunction = true;
    }
    if (sawRustImplFunction && current.type === "impl_item") return true;
    if (current.type === "function_declaration" || current.type === "program") return false;
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
  namespaceImport?: Extract<ImportBinding, { kind: "namespace" }>,
  imports?: readonly ImportBinding[],
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
          const inAliasScope =
            sup.id !== "csharp" ||
            !namespaceImport ||
            !imports ||
            !namespaceImport.localRange ||
            innermostNamespaceImport(imports, objectName, obj) === namespaceImport;
          if (inAliasScope) ranges.push(toRange(prop));
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
