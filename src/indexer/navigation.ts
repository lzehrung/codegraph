import { supportForFile, type LanguageExtensionMap, type LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { ensureParsedContext, type ParsedFileContext } from "./parse-context.js";
import { resolveMemberAccessDefinition, supportsReceiverMemberResolution } from "./navigation-goto.js";
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
  normalizePhpQualifiedReference,
} from "./navigation-php.js";
import {
  buildPhpQualifiedNames,
  collectVerifiedNamedNodeReferences,
  getCachedScope,
  getCachedReferenceCandidateFiles,
  getCandidateReferenceNames,
  hasExpandedNamedImport,
} from "./navigation-references.js";
import { resolveExport, resolveImported } from "./navigation-resolve.js";
import { extractEnclosingBlock, extractLineContext, rangeContains, sameDef } from "./reference-context.js";
import { DEFAULT_REF_CONTEXT_LINES } from "./shared.js";
import { type ScopeIndex } from "./scope.js";
import { type FileId, type Range } from "../types.js";
import { resolveImportSpecifier } from "../util/resolution.js";
import { fileIdentityKey } from "../util/paths.js";
import { sliceText, toRange } from "../util/ast.js";
import {
  getMemberAccessParts,
  isMemberAccessNode,
  isMemberObjectIdentifier,
  isMemberReferencePropertyIdentifier,
} from "../util/memberAccess.js";
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
              if (!sup.nodeTypes.identifier.includes(receiver.type)) return null;
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

  return {
    status: "not_found",
    reason: "No matching local or imported definition",
  };
}

function isUnresolvedReceiverMemberProperty(sup: LanguageSupport, node: SyntaxNodeLike): boolean {
  const parent = node.parent;
  if (!parent || !supportsReceiverMemberResolution(sup.id) || !isMemberAccessNode(sup, parent)) {
    return false;
  }
  const { property } = getMemberAccessParts(sup, parent);
  return !!property && node.id === property.id;
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

  const sqlReferences = await findSqlReferences(index, def);
  if (sqlReferences) return sqlReferences;

  const definitionFile = def.file;
  const parsedDef = index.parsed?.get(fileIdentityKey(definitionFile));
  const parsedContext = await ensureParsedContext(definitionFile, parsedDef, index.languageExtensions);

  const mod = index.byFile.get(fileIdentityKey(definitionFile));
  if (!mod) return { status: "not_found", reason: "Module not found" };

  const scope = getCachedScope(index, definitionFile, mod, parsedContext);
  const refs: Reference[] = [];
  const maxReferences =
    typeof opts?.maxReferences === "number" && opts.maxReferences > 0 ? opts.maxReferences : undefined;
  const seenRefs = new Set<string>();
  const hasReachedMaxReferences = (): boolean => maxReferences !== undefined && refs.length >= maxReferences;
  const pushRef = (ref: Reference): void => {
    const key = `${fileIdentityKey(ref.file)}:${ref.range.start.line}:${ref.range.start.column}`;
    if (seenRefs.has(key)) return;
    seenRefs.add(key);
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
      if (hasReachedMaxReferences()) break;
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
  if (index.bloomFilters && phpQualifiedNames.length) {
    candidateFiles = candidateFiles.filter((candidateFile) => {
      const module = index.byFile.get(fileIdentityKey(candidateFile));
      if (!module) return true;
      const filter = index.bloomFilters?.get(fileIdentityKey(candidateFile));
      if (!filter) return true;

      // Bloom filters contain names normalized by the candidate file's language, so probes must use that rule.
      const normalizeIdentifier =
        supportForFile(candidateFile, index.languageExtensions)?.normalizeIdentifier ?? ((name) => name);
      const aliases = getCandidateReferenceNames(module, definitionFile, exportedNameSet);
      if (!aliases.length) {
        return [...exportedNames, ...phpQualifiedNames].some((candidateName) =>
          filter.mightContain(normalizeIdentifier(candidateName)),
        );
      }
      return aliases.some((alias) => filter.mightContain(normalizeIdentifier(alias)));
    });
  }

  for (const fileId of candidateFiles) {
    if (hasReachedMaxReferences()) break;
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

    for (const entry of module.exports) {
      if (hasReachedMaxReferences()) break;
      if (entry.type !== "reexport") continue;
      const resolved = resolveExport(index, entry.fromModule, entry.sourceSpecifier);
      if (resolved?.kind !== "resolved" || !sameDef(resolved.def, def, index.languageExtensions)) continue;
      const remainingReferences = maxReferences !== undefined ? Math.max(0, maxReferences - refs.length) : undefined;
      const ranges = await collectVerifiedNamedNodeReferences(
        index,
        fileId,
        entry.sourceSpecifier,
        def,
        (params, parsed) => goToDefinition(index, params, parsed),
        remainingReferences,
      );
      for (const { range, provenance, via } of ranges) {
        if (hasReachedMaxReferences()) break;
        if (!via?.reexport) continue;
        pushRef({ file: fileId, range, via, ...(provenance ? { provenance } : {}) });
      }
    }

    for (const imp of module.imports) {
      if (hasReachedMaxReferences()) break;
      const targetFile = typeof imp.resolved === "string" ? imp.resolved : undefined;
      if (!targetFile) continue;

      for (const exportedName of exportedNames) {
        if (hasReachedMaxReferences()) break;
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
            if (hasReachedMaxReferences()) break;
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
          const remainingReferences =
            maxReferences !== undefined ? Math.max(0, maxReferences - refs.length) : undefined;
          const ranges = await collectVerifiedNamedNodeReferences(
            index,
            fileId,
            exportedName,
            def,
            (params, parsed) => goToDefinition(index, params, parsed),
            remainingReferences,
          );
          for (const { range, provenance, via } of ranges) {
            if (hasReachedMaxReferences()) break;
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
          const matchesDef = hit?.kind === "resolved" && sameDef(hit.def, def, index.languageExtensions);
          if (!matchesDef) continue;
          if (fileIdentityKey(targetFile) !== fileIdentityKey(definitionFile)) {
            const remainingReferences =
              maxReferences !== undefined ? Math.max(0, maxReferences - refs.length) : undefined;
            const ranges = await collectVerifiedNamedNodeReferences(
              index,
              fileId,
              imp.local,
              def,
              (params, parsed) => goToDefinition(index, params, parsed),
              remainingReferences,
            );
            for (const { range, provenance, via } of ranges) {
              if (hasReachedMaxReferences()) break;
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

    if (phpQualifiedNames.length) {
      const remainingReferences = maxReferences !== undefined ? Math.max(0, maxReferences - refs.length) : undefined;
      for (const candidateName of [...exportedNames, ...phpQualifiedNames]) {
        if (hasReachedMaxReferences()) break;
        const ranges = await collectVerifiedNamedNodeReferences(
          index,
          fileId,
          candidateName,
          def,
          (params, parsed) => goToDefinition(index, params, parsed),
          remainingReferences,
        );
        for (const { range, provenance, via } of ranges) {
          if (hasReachedMaxReferences()) break;
          pushRef({ file: fileId, range, ...(via ? { via } : {}), ...(provenance ? { provenance } : {}) });
        }
      }
    }
  }

  if (shouldScanVerifiedReferences(def, phpQualifiedNames, parsedContext)) {
    for (const fileId of Array.from(index.byFile.values(), (module) => module.file).sort((left, right) =>
      left.localeCompare(right),
    )) {
      if (hasReachedMaxReferences()) break;
      const filter = index.bloomFilters?.get(fileIdentityKey(fileId));
      // Bloom filters contain names normalized by the candidate file's language, so probes must use that rule.
      const canonicalName =
        supportForFile(fileId, index.languageExtensions)?.normalizeIdentifier(def.localName) ?? def.localName;
      if (filter && !filter.mightContain(canonicalName)) continue;
      const remainingReferences = maxReferences !== undefined ? Math.max(0, maxReferences - refs.length) : undefined;
      const ranges = await collectVerifiedNamedNodeReferences(
        index,
        fileId,
        def.localName,
        def,
        (params, parsed) => goToDefinition(index, params, parsed),
        remainingReferences,
      );
      for (const { range, provenance, via } of ranges) {
        if (hasReachedMaxReferences()) break;
        pushRef({ file: fileId, range, ...(via ? { via } : {}), ...(provenance ? { provenance } : {}) });
      }
    }
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

  return {
    status: "ok",
    definition: def,
    references: refs,
    ...(provenance ? { provenance } : {}),
  };
}

function shouldScanVerifiedReferences(
  def: SymbolDef,
  phpQualifiedNames: readonly string[],
  parsedContext: ParsedFileContext,
): boolean {
  if (def.kind !== SymbolKind.Function || phpQualifiedNames.length) {
    return false;
  }
  if (!supportsReceiverMemberResolution(parsedContext.sup.id)) {
    return false;
  }
  return isReceiverMethodDefinition(def, parsedContext);
}

function shouldUseLocalNameAsExportFallback(def: SymbolDef, parsedContext: ParsedFileContext): boolean {
  return !isReceiverMethodDefinition(def, parsedContext);
}

function isReceiverMethodDefinition(def: SymbolDef, parsedContext: ParsedFileContext): boolean {
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
