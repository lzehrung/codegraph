import { type LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { ensureParsedContext, type ParsedFileContext } from "./parse-context.js";
import { resolveMemberAccessDefinition } from "./navigation-goto.js";
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
import { isJsTsLanguage } from "../languages/js-family.js";
import { resolveImportSpecifier } from "../util/resolution.js";
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

export async function goToDefinition(index: ProjectIndex, req: GoToRequest): Promise<GoToResult> {
  const { file, line, column } = req;
  const mod = index.byFile.get(file);
  if (!mod) return { status: "not_found", reason: "File not indexed" };

  const sqlResult = await goToSqlDefinition(index, req);
  if (sqlResult) return sqlResult;

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
    const declNameNode = findDeclarationNameNode(sup, node);
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
    const scopeIndex = getOrBuildScopeIndex(index, file, source, sup, lang, mod, tree);
    const local = findClosestBinding(scopeIndex, file, name, node);
    if (local) {
      return okGoToResult(index, local, {
        resolution: "exact",
        confidence: "high",
      });
    }

    if (sup.supportsCrossModuleSymbols) {
      const resolvedName = resolveNamedDefinition(index, mod, file, name);
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
    const module = index.byFile.get(req.file);
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
  const parsedDef = index.parsed?.get(definitionFile);
  const parsedContext = await ensureParsedContext(definitionFile, parsedDef);

  const mod = index.byFile.get(definitionFile);
  if (!mod) return { status: "not_found", reason: "Module not found" };

  const scope = getCachedScope(index, definitionFile, mod, parsedContext);
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
  if (!exportedNames.length && shouldUseLocalNameAsExportFallback(def, parsedContext)) {
    exportedNames.push(def.localName);
  }

  const exportedNameSet = new Set(exportedNames);
  const phpQualifiedNames = await buildPhpQualifiedNames(index, definitionFile, def);

  let candidateFiles = getCachedReferenceCandidateFiles(index, def, exportedNames, !!phpQualifiedNames.length);
  if (index.bloomFilters && phpQualifiedNames.length) {
    candidateFiles = candidateFiles.filter((candidateFile) => {
      const module = index.byFile.get(candidateFile);
      if (!module) return true;
      const filter = index.bloomFilters?.get(candidateFile);
      if (!filter) return true;

      const aliases = getCandidateReferenceNames(module, definitionFile, exportedNameSet);
      if (!aliases.length) {
        return [...exportedNames, ...phpQualifiedNames].some((candidateName) => filter.mightContain(candidateName));
      }
      return aliases.some((alias) => filter.mightContain(alias));
    });
  }

  for (const fileId of candidateFiles) {
    if (hasReachedMaxReferences()) break;
    const module = index.byFile.get(fileId);
    if (!module) continue;

    let scopeIndex: ScopeIndex | null = null;
    let candidateParsedContext: ParsedFileContext | null = null;
    const ensureCandidateParsed = async (): Promise<ParsedFileContext> => {
      if (!candidateParsedContext) {
        const parsedEntry = index.parsed?.get(fileId);
        candidateParsedContext = await ensureParsedContext(fileId, parsedEntry);
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
          const parsed = await ensureCandidateParsed();
          const ranges = await collectNamespaceMemberRefs(fileId, imp.localNS, exportedName, parsed);
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
          const ranges = await collectVerifiedNamedNodeReferences(
            index,
            fileId,
            exportedName,
            def,
            (params) => goToDefinition(index, params),
            remainingReferences,
          );
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

    if (phpQualifiedNames.length) {
      const remainingReferences = maxReferences !== undefined ? Math.max(0, maxReferences - refs.length) : undefined;
      for (const candidateName of [...exportedNames, ...phpQualifiedNames]) {
        if (hasReachedMaxReferences()) break;
        const ranges = await collectVerifiedNamedNodeReferences(
          index,
          fileId,
          candidateName,
          def,
          (params) => goToDefinition(index, params),
          remainingReferences,
        );
        for (const range of ranges) {
          if (hasReachedMaxReferences()) break;
          pushRef({ file: fileId, range });
        }
      }
    }
  }

  if (shouldScanVerifiedReferences(def, phpQualifiedNames, parsedContext)) {
    for (const fileId of index.byFile.keys()) {
      if (hasReachedMaxReferences()) break;
      const filter = index.bloomFilters?.get(fileId);
      if (filter && !filter.mightContain(def.localName)) continue;
      const remainingReferences = maxReferences !== undefined ? Math.max(0, maxReferences - refs.length) : undefined;
      const ranges = await collectVerifiedNamedNodeReferences(
        index,
        fileId,
        def.localName,
        def,
        (params) => goToDefinition(index, params),
        remainingReferences,
      );
      for (const range of ranges) {
        if (hasReachedMaxReferences()) break;
        pushRef({ file: fileId, range });
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
  if (!isJsTsLanguage(parsedContext.sup.id)) {
    return false;
  }
  return isJsTsMethodDefinition(def, parsedContext);
}

function shouldUseLocalNameAsExportFallback(def: SymbolDef, parsedContext: ParsedFileContext): boolean {
  if (!isJsTsLanguage(parsedContext.sup.id)) {
    return true;
  }
  return !isJsTsMethodDefinition(def, parsedContext);
}

function isJsTsMethodDefinition(def: SymbolDef, parsedContext: ParsedFileContext): boolean {
  if (def.kind !== SymbolKind.Function) {
    return false;
  }
  const start = def.range.start;
  const position = {
    row: start.line - 1,
    column: start.column - 1,
  };
  let current: SyntaxNodeLike | null = parsedContext.tree.rootNode.descendantForPosition(position, position);
  while (current) {
    if (
      current.type === "method_definition" ||
      current.type === "method_signature" ||
      current.type === "abstract_method_signature"
    ) {
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
): Promise<Range[]> {
  const parsed = parsedContext ?? (await ensureParsedContext(file, undefined));
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
