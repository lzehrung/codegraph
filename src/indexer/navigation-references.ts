import { supportForFileWithoutHeaderSample, type LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { FileId, Range } from "../types.js";
import { fileIdentityKey } from "../util/paths.js";
import { sliceText, toRange } from "../util/ast.js";
import { getMemberAccessParts, isMemberAccessNode } from "../util/member-access.js";
import {
  classifyReceiver,
  declaresMembers,
  receiverConstructorExpression,
} from "../graphs/symbol-graph-detailed/receiver-calls.js";
import { ensureParsedContext, type ParsedFileContext } from "./parse-context.js";
import { sameDef } from "./reference-context.js";
import {
  canonicalPhpReferenceNames,
  comparePhpReferenceNames,
  getPhpQualifiedReference,
  inferPhpQualifiedReferenceImportType,
  isInsidePhpUseDeclaration,
  isPhpQualifiedReferenceNode,
  phpLastIdentifierSegment,
  readPhpNamespaceFromRange,
  selectFirstExistingPhpCanonicalName,
} from "./navigation-php.js";
import { isKeywordReceiver } from "../util/member-access-tables.js";
import { candidateFilesImportingTarget } from "./reference-candidates.js";
import { buildScopeIndexFromSource, type ScopeIndex } from "./scope.js";
import { resolveExport, resolveImported } from "./navigation-resolve.js";
import {
  SymbolKind,
  type ExportEntry,
  type ImportBindingRole,
  type ModuleIndex,
  type ProjectIndex,
  type ReferenceCoverage,
  type ReferenceCoverageReason,
  type ResolutionProvenance,
  type SymbolDef,
} from "./types.js";
import type { ImportBinding } from "./import-types.js";
import { ECMASCRIPT_IDENTIFIER_SOURCE, foldPhpIdentifierCase } from "../util/identifiers.js";

const EXPORT_FROM_PATTERN = new RegExp(String.raw`\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(["'])([^"']+)\2`, "gu");
const NAMESPACE_EXPORT_PATTERN = new RegExp(
  String.raw`\bexport\s*\*\s*as\s*(${ECMASCRIPT_IDENTIFIER_SOURCE})\s*from\s*(["'])([^"']+)\2`,
  "gu",
);
const EXPORT_FROM_SPECIFIER_PATTERN = new RegExp(String.raw`^(${ECMASCRIPT_IDENTIFIER_SOURCE})`, "u");

type ReexportEntry = Extract<ExportEntry, { type: "reexport" }>;

type ExportFromIdentifier = {
  isExportFrom: boolean;
  sourceSpecifier?: string;
  entry?: ReexportEntry;
};

export function exportFromIdentifier(
  index: ProjectIndex,
  fileId: string,
  range: Range,
  parsed: ParsedFileContext,
): ExportFromIdentifier | null {
  if (!parsed.sup.supportsExportFromReferences) return null;
  const startIndex = range.start.index;
  if (typeof startIndex !== "number") return null;
  const moduleIndex = index.byFile.get(fileIdentityKey(fileId));
  if (!moduleIndex) return null;

  EXPORT_FROM_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EXPORT_FROM_PATTERN.exec(parsed.source))) {
    const listText = match[1]!;
    const listOffset = match[0].indexOf(listText);
    if (listOffset < 0) continue;
    const listStart = match.index + listOffset;
    let itemOffset = 0;
    for (const item of listText.split(",")) {
      const leadingWhitespace = item.search(/\S/);
      if (leadingWhitespace < 0) {
        itemOffset += item.length + 1;
        continue;
      }
      const itemText = item.trim();
      const itemStart = listStart + itemOffset + leadingWhitespace;
      const itemEnd = itemStart + itemText.length;
      if (startIndex < itemStart || startIndex >= itemEnd) {
        itemOffset += item.length + 1;
        continue;
      }

      const sourceMatch = EXPORT_FROM_SPECIFIER_PATTERN.exec(itemText);
      if (!sourceMatch) return { isExportFrom: true };
      const sourceSpecifier = sourceMatch[1]!;
      const sourceEnd = itemStart + sourceSpecifier.length;
      if (startIndex >= sourceEnd) return { isExportFrom: true };
      const fromSpecifier = match[3]!;
      const matchingEntries = moduleIndex.exports.filter(
        (candidate): candidate is ReexportEntry =>
          candidate.type === "reexport" && candidate.sourceSpecifier === sourceSpecifier,
      );
      const entry =
        matchingEntries.find(
          (candidate) => candidate.moduleSpecifier === fromSpecifier || candidate.fromModule === fromSpecifier,
        ) ?? (matchingEntries.length === 1 ? matchingEntries[0] : undefined);
      return { isExportFrom: true, sourceSpecifier, ...(entry ? { entry } : {}) };
    }
    itemOffset += listText.length + 1;
  }
  NAMESPACE_EXPORT_PATTERN.lastIndex = 0;
  while ((match = NAMESPACE_EXPORT_PATTERN.exec(parsed.source))) {
    const namespace = match[1]!;
    const namespaceStart = match.index + match[0].indexOf(namespace);
    if (startIndex >= namespaceStart && startIndex < namespaceStart + namespace.length) {
      return { isExportFrom: true };
    }
  }
  return null;
}

export function getCachedScope(
  index: ProjectIndex,
  fileId: string,
  moduleIndex: ModuleIndex,
  parsedCtx: {
    source: string;
    sup: LanguageSupport;
    tree: SyntaxTreeLike;
  },
): ScopeIndex {
  const fileKey = fileIdentityKey(fileId);
  const cachedScope = index.scopeCache.get(fileKey);
  if (cachedScope) {
    for (const binding of cachedScope.all) {
      binding.occurrences = binding.occurrences.filter(
        (occurrence) => !exportFromIdentifier(index, fileId, occurrence, parsedCtx)?.isExportFrom,
      );
    }
    return cachedScope;
  }
  const scopeIndex = buildScopeIndexFromSource(fileId, parsedCtx.source, parsedCtx.sup, moduleIndex.imports, {
    tree: parsedCtx.tree,
  });
  for (const binding of scopeIndex.all) {
    binding.occurrences = binding.occurrences.filter(
      (occurrence) => !exportFromIdentifier(index, fileId, occurrence, parsedCtx)?.isExportFrom,
    );
  }
  index.scopeCache.set(fileKey, scopeIndex);
  return scopeIndex;
}
/**
 * The authoritative PHP spellings of a definition: `Namespace\Name`, or the bare `Name` for a
 * global-namespace declaration. These are the names a reference must resolve to, so they keep
 * the declaration's own case. A global-namespace declaration is still addressable by its bare
 * name and by the fully-qualified `\Name` spelling, so the global-name scan must run for it;
 * returning `[]` here left a global PHP symbol on the importer-narrowed path, which never scans
 * a consumer that has no `use` statement.
 */
async function readPhpDefinitionNames(index: ProjectIndex, definitionFile: string, def: SymbolDef): Promise<string[]> {
  try {
    const definitionParsed = await ensureParsedContext(
      definitionFile,
      index.parsed?.get(fileIdentityKey(definitionFile)),
      index.languageExtensions,
    );
    if (definitionParsed.sup.id !== "php") {
      return [];
    }
    const phpNamespace = readPhpNamespaceFromRange(definitionParsed.tree, definitionParsed.source, def.range);
    return [phpNamespace ? `${phpNamespace}\\${def.localName}` : def.localName];
  } catch {
    return [];
  }
}

export async function buildPhpQualifiedNames(
  index: ProjectIndex,
  definitionFile: string,
  def: SymbolDef,
): Promise<string[]> {
  // Keep one canonical spelling. Case-variant consumers are admitted during the single AST
  // walk by comparePhpReferenceNames; extra folded probes would multiply whole-file scans.
  return readPhpDefinitionNames(index, definitionFile, def);
}

function definitionIdentityKey(def: SymbolDef): string {
  return `${fileIdentityKey(def.file)}:${def.range.start.index ?? `${def.range.start.line}:${def.range.start.column}`}`;
}

const phpCanonicalNamesCache = new WeakMap<ProjectIndex, Map<string, string[]>>();
const phpNameEquivalenceGaps = new WeakMap<ProjectIndex, Set<string>>();
const phpIndexedNamesByKindCache = new WeakMap<ProjectIndex, Map<string, string[]>>();

async function phpCanonicalDefinitionNames(index: ProjectIndex, def: SymbolDef): Promise<string[]> {
  let perIndex = phpCanonicalNamesCache.get(index);
  if (!perIndex) {
    perIndex = new Map();
    phpCanonicalNamesCache.set(index, perIndex);
  }
  const key = definitionIdentityKey(def);
  const cached = perIndex.get(key);
  if (cached) return cached;
  const canonicalNames = (await readPhpDefinitionNames(index, def.file, def)).map((name) => name.replace(/^\\+/, ""));
  perIndex.set(key, canonicalNames);
  return canonicalNames;
}

async function phpIndexedCanonicalNames(index: ProjectIndex, kind: SymbolKind): Promise<string[]> {
  let perIndex = phpIndexedNamesByKindCache.get(index);
  if (!perIndex) {
    perIndex = new Map();
    phpIndexedNamesByKindCache.set(index, perIndex);
  }
  const cached = perIndex.get(kind);
  if (cached) return cached;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const moduleIndex of index.byFile.values()) {
    for (const local of moduleIndex.locals) {
      if (local.kind !== kind || local.isMember) continue;
      for (const canonicalName of await phpCanonicalDefinitionNames(index, local)) {
        const folded = foldPhpIdentifierCase(canonicalName);
        if (seen.has(folded)) continue;
        seen.add(folded);
        names.push(canonicalName);
      }
    }
  }
  perIndex.set(kind, names);
  return names;
}

function markPhpNameEquivalenceGap(index: ProjectIndex, def: SymbolDef): void {
  let gaps = phpNameEquivalenceGaps.get(index);
  if (!gaps) {
    gaps = new Set();
    phpNameEquivalenceGaps.set(index, gaps);
  }
  gaps.add(definitionIdentityKey(def));
}

const PHP_OWN_RECEIVER_KEYWORDS = new Set(["$this", "self", "static"]);

const PHP_TYPE_CONTAINER_TYPES = new Set([
  "class_declaration",
  "interface_declaration",
  "trait_declaration",
  "enum_declaration",
]);

async function phpOwnerInfo(
  index: ProjectIndex,
  def: SymbolDef,
): Promise<{ owner: SymbolDef; containerStart: number; containerEnd: number } | null> {
  const module = index.byFile.get(fileIdentityKey(def.file));
  if (!module) return null;
  const parsed = await ensureParsedContext(
    def.file,
    index.parsed?.get(fileIdentityKey(def.file)),
    index.languageExtensions,
  );
  const start = def.range.start;
  const position = { row: Math.max(0, start.line - 1), column: Math.max(0, start.column - 1) };
  let current: SyntaxNodeLike | null = parsed.tree.rootNode.descendantForPosition(position, position);
  while (current) {
    if (PHP_TYPE_CONTAINER_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName("name");
      const className = nameNode ? sliceText(nameNode, parsed.source) : null;
      if (!className) return null;
      const owner =
        module.locals.find(
          (local) =>
            local.localName === className &&
            local.range.start.index === nameNode?.startIndex &&
            (local.kind === SymbolKind.Class ||
              local.kind === SymbolKind.Interface ||
              local.kind === SymbolKind.TypeAlias),
        ) ?? null;
      if (!owner) return null;
      return { owner, containerStart: current.startIndex, containerEnd: current.endIndex };
    }
    current = current.parent;
  }
  return null;
}

function phpMemberAccessProperty(
  node: SyntaxNodeLike,
  parsed: ParsedFileContext,
): { object: SyntaxNodeLike; property: SyntaxNodeLike; parent: SyntaxNodeLike } | null {
  const parent = node.parent;
  if (!parent || !isMemberAccessNode(parsed.sup, parent)) return null;
  const parts = getMemberAccessParts(parsed.sup, parent);
  if (!parts.property || !parts.object) return null;
  const isProperty =
    parts.property === node ||
    (parts.property.id !== undefined && parts.property.id === node.id) ||
    (parts.property.startIndex === node.startIndex && parts.property.endIndex === node.endIndex);
  if (!isProperty) return null;
  if (parts.object.startIndex === parts.property.startIndex) return null;
  return { object: parts.object, property: parts.property, parent };
}

async function phpCaseInsensitiveReceiverMemberMatch(
  index: ProjectIndex,
  fileId: string,
  node: SyntaxNodeLike,
  parsed: ParsedFileContext,
  expectedDef: SymbolDef,
): Promise<"matched" | "unverified" | "skip"> {
  const access = phpMemberAccessProperty(node, parsed);
  if (!access) return "skip";
  const propertyText = sliceText(access.property, parsed.source);
  const comparison = comparePhpReferenceNames(propertyText, expectedDef.localName, {
    symbolKind: expectedDef.kind,
  });
  if (comparison !== "equivalent") return "skip";
  const exactSpelling = propertyText === expectedDef.localName;
  const ownerInfo = await phpOwnerInfo(index, expectedDef);
  if (!ownerInfo) return exactSpelling ? "skip" : "unverified";
  const owner = ownerInfo.owner;

  const receiverName = sliceText(access.object, parsed.source);
  if (PHP_OWN_RECEIVER_KEYWORDS.has(receiverName)) {
    if (
      fileIdentityKey(fileId) === fileIdentityKey(expectedDef.file) &&
      node.startIndex >= ownerInfo.containerStart &&
      node.startIndex <= ownerInfo.containerEnd
    ) {
      return "matched";
    }
    return exactSpelling ? "skip" : "unverified";
  }
  if (isKeywordReceiver(parsed.sup.id, receiverName)) {
    return exactSpelling ? "skip" : "unverified";
  }

  const constructor = receiverConstructorExpression(access.object, parsed.source, parsed.sup);
  const typeNode = constructor ?? (access.parent.type === "scoped_call_expression" ? access.object : null);
  if (!typeNode) return exactSpelling ? "skip" : "unverified";

  const ownerNames = await phpCanonicalDefinitionNames(index, owner);
  const imports = index.byFile.get(fileIdentityKey(fileId))?.imports;
  const typeNames = canonicalPhpReferenceNames(
    sliceText(typeNode, parsed.source),
    parsed.source,
    parsed.tree,
    typeNode,
    {
      ...(imports ? { imports } : {}),
      role: "class",
    },
  );
  const matchesOwner = typeNames.some((typeName) =>
    ownerNames.some(
      (ownerName) => comparePhpReferenceNames(typeName, ownerName, { symbolKind: SymbolKind.Class }) === "equivalent",
    ),
  );
  if (matchesOwner) return "matched";
  return "skip";
}

function matchesPhpFallbackDefinition(
  node: SyntaxNodeLike,
  parsed: ParsedFileContext,
  expectedDef: SymbolDef,
): boolean {
  if (expectedDef.isMember) return false;
  const parent = node.parent;
  if (parent && isMemberAccessNode(parsed.sup, parent)) {
    const property = getMemberAccessParts(parsed.sup, parent).property;
    if (
      property &&
      (property === node ||
        (property.id !== undefined && property.id === node.id) ||
        (property.startIndex === node.startIndex && property.endIndex === node.endIndex))
    ) {
      return false;
    }
  }

  const referenceKind = inferPhpQualifiedReferenceImportType(node);

  if (expectedDef.kind === SymbolKind.Function) return referenceKind === "function";
  if (
    expectedDef.kind === SymbolKind.Class ||
    expectedDef.kind === SymbolKind.Interface ||
    expectedDef.kind === SymbolKind.TypeAlias
  ) {
    return referenceKind === "class";
  }
  return false;
}

async function collectNamedNodeReferences(
  index: ProjectIndex,
  fileId: string,
  symbolName: string,
  symbolKind?: string,
): Promise<{
  matched: Array<{ range: Range; node: SyntaxNodeLike }>;
  parsed: ParsedFileContext;
  nameEquivalenceUnavailable: boolean;
} | null> {
  try {
    const parsedEntry = index.parsed?.get(fileIdentityKey(fileId));
    const parsed = await ensureParsedContext(fileId, parsedEntry, index.languageExtensions);
    const identifierTypes = new Set<string>([
      ...parsed.sup.nodeTypes.identifier,
      ...(parsed.sup.nodeTypes.propertyIdentifier ?? []),
      "constant",
      "type_identifier",
      "field_identifier",
    ]);
    const canonicalSymbolName = parsed.sup.normalizeIdentifier(symbolName);
    const isPhp = parsed.sup.id === "php";
    const matched: Array<{ range: Range; node: SyntaxNodeLike }> = [];
    let nameEquivalenceUnavailable = false;
    const moduleIndex = index.byFile.get(fileIdentityKey(fileId));
    const importDeclarationKeys = importBindingDeclarationRangeKeys(moduleIndex);
    const walk = (node: SyntaxNodeLike): void => {
      if (identifierTypes.has(node.type)) {
        const text = parsed.sup.normalizeIdentifier(sliceText(node, parsed.source));
        let isMatch: boolean;
        if (!isPhp) {
          isMatch = text === canonicalSymbolName;
        } else if (
          (node.type === "name" || node.type === "namespace_name") &&
          isPhpQualifiedReferenceNode(node.parent)
        ) {
          isMatch = false;
        } else {
          const comparisonText =
            node.type === "qualified_name" || node.type === "relative_name" ? phpLastIdentifierSegment(text) : text;
          const comparison = comparePhpReferenceNames(comparisonText, phpLastIdentifierSegment(canonicalSymbolName), {
            caseSensitiveForm: node.type === "variable_name" || node.type === "constant",
            ...(symbolKind ? { symbolKind } : {}),
          });
          if (comparison === "unverified") nameEquivalenceUnavailable = true;
          isMatch = comparison === "equivalent";
        }
        if (isMatch) {
          const range = toRange(node);
          if (!importDeclarationKeys.has(rangeIdentityKey(range)) && !(isPhp && isInsidePhpUseDeclaration(node))) {
            matched.push({ range, node });
          }
        }
      }
      for (const child of node.namedChildren) {
        walk(child);
      }
    };
    walk(parsed.tree.rootNode);
    return { matched, parsed, nameEquivalenceUnavailable };
  } catch {
    return null;
  }
}

export type VerifiedNamedNodeReference = {
  range: Range;
  provenance?: ResolutionProvenance;
  via?: { reexport: true };
};
type ReferenceDefinitionResolver = (
  params: { file: string; line: number; column: number },
  parsed: ParsedFileContext,
) => Promise<{ status: string; definition?: SymbolDef; provenance?: ResolutionProvenance }>;

async function receiverProofUnavailable(
  fileId: FileId,
  parsed: ParsedFileContext,
  range: Range,
  resolveDefinition: ReferenceDefinitionResolver,
): Promise<boolean> {
  const position = {
    row: range.start.line - 1,
    column: range.start.column - 1,
  };
  const nameNode = parsed.tree.rootNode.descendantForPosition(position, position);
  let current: SyntaxNodeLike | null = nameNode.parent;
  while (current) {
    if (isMemberAccessNode(parsed.sup, current)) {
      const { object, property } = getMemberAccessParts(parsed.sup, current);
      if (!object || !property || property.startIndex !== range.start.index) return false;
      const receiver = classifyReceiver(parsed.sup, object, parsed.source, new Map(), current.startIndex, current);
      if (receiver) return false;
      const receiverRange = toRange(object);
      const resolvedReceiver = await resolveDefinition(
        {
          file: fileId,
          line: receiverRange.start.line,
          column: receiverRange.start.column,
        },
        parsed,
      );
      return !(
        resolvedReceiver.status === "ok" &&
        resolvedReceiver.definition &&
        declaresMembers(resolvedReceiver.definition)
      );
    }
    current = current.parent;
  }
  return false;
}

export async function collectVerifiedNamedNodeReferences(
  index: ProjectIndex,
  fileId: string,
  symbolName: string,
  expectedDef: SymbolDef,
  resolveDefinition: ReferenceDefinitionResolver,
  maxVerified?: number,
  includeReference?: (reference: VerifiedNamedNodeReference) => boolean,
  onReceiverProofUnavailable?: (file: FileId) => void,
  equivalentDefinitions: readonly SymbolDef[] = [],
): Promise<VerifiedNamedNodeReference[]> {
  const collected = await collectNamedNodeReferences(index, fileId, symbolName, expectedDef.kind);
  if (!collected) return [];
  const { matched, parsed, nameEquivalenceUnavailable } = collected;
  if (nameEquivalenceUnavailable) markPhpNameEquivalenceGap(index, expectedDef);
  const phpCanonicalNames = parsed.sup.id === "php" ? await phpCanonicalDefinitionNames(index, expectedDef) : undefined;
  const phpExistingFunctionNames =
    phpCanonicalNames && expectedDef.kind === SymbolKind.Function
      ? await phpIndexedCanonicalNames(index, expectedDef.kind)
      : undefined;
  const verified: VerifiedNamedNodeReference[] = [];
  const matchesExpectedDefinition = (definition: SymbolDef): boolean =>
    sameDef(definition, expectedDef, index.languageExtensions) ||
    equivalentDefinitions.some((equivalent) => sameDef(definition, equivalent, index.languageExtensions));
  const candidateFileKey = fileIdentityKey(fileId);
  const equivalentDefinitionsInFile = equivalentDefinitions.filter(
    (equivalent) => fileIdentityKey(equivalent.file) === candidateFileKey,
  );
  const isEquivalentDeclarationRange = (range: Range): boolean =>
    equivalentDefinitionsInFile.some((equivalent) => {
      const startMatches =
        range.start.index !== undefined && equivalent.range.start.index !== undefined
          ? range.start.index === equivalent.range.start.index
          : range.start.line === equivalent.range.start.line && range.start.column === equivalent.range.start.column;
      const endMatches =
        range.end.index !== undefined && equivalent.range.end.index !== undefined
          ? range.end.index === equivalent.range.end.index
          : range.end.line === equivalent.range.end.line && range.end.column === equivalent.range.end.column;
      return startMatches && endMatches;
    });
  const pushVerified = (reference: VerifiedNamedNodeReference): void => {
    if (!includeReference || includeReference(reference)) verified.push(reference);
  };
  for (const { range, node } of matched) {
    if (maxVerified !== undefined && maxVerified > 0 && verified.length >= maxVerified) {
      break;
    }
    if (isEquivalentDeclarationRange(range)) {
      pushVerified({ range });
      continue;
    }
    const exportFrom = exportFromIdentifier(index, fileId, range, parsed);
    if (exportFrom?.entry) {
      const reexported = resolveExport(index, exportFrom.entry.fromModule, exportFrom.entry.sourceSpecifier);
      if (reexported?.kind === "resolved") {
        if (matchesExpectedDefinition(reexported.def)) {
          pushVerified({ range, via: { reexport: true } });
        }
        continue;
      }
    }
    const resolved = await resolveDefinition(
      {
        file: fileId,
        line: range.start.line,
        column: range.start.column,
      },
      parsed,
    );
    if (resolved.status === "ok" && resolved.definition) {
      if (matchesExpectedDefinition(resolved.definition)) {
        pushVerified({
          range,
          ...(exportFrom?.isExportFrom ? { via: { reexport: true } } : {}),
          ...(resolved.provenance ? { provenance: resolved.provenance } : {}),
        });
      }
      continue;
    }
    if (onReceiverProofUnavailable && (await receiverProofUnavailable(fileId, parsed, range, resolveDefinition))) {
      onReceiverProofUnavailable(fileId);
    }
    if (parsed.sup.id === "php" && expectedDef.isMember) {
      const memberMatch = await phpCaseInsensitiveReceiverMemberMatch(index, fileId, node, parsed, expectedDef);
      if (memberMatch === "matched") {
        pushVerified({ range, ...(exportFrom?.isExportFrom ? { via: { reexport: true } } : {}) });
      } else if (memberMatch === "unverified") {
        markPhpNameEquivalenceGap(index, expectedDef);
      }
      continue;
    }
    // PHP names are case-insensitive, but a namespace spelling alone cannot prove a member or
    // distinguish a class reference from a function call. Restrict the fallback to syntax whose
    // role matches the namespace-level definition.
    if (phpCanonicalNames && matchesPhpFallbackDefinition(node, parsed, expectedDef)) {
      const rawText = getPhpQualifiedReference(node, parsed.source) ?? sliceText(node, parsed.source);
      const imports = index.byFile.get(fileIdentityKey(fileId))?.imports;
      const role = inferPhpQualifiedReferenceImportType(node);
      const candidates = canonicalPhpReferenceNames(rawText, parsed.source, parsed.tree, node, {
        ...(imports ? { imports } : {}),
        ...(role ? { role } : {}),
      });
      const existingNames = phpExistingFunctionNames ?? phpCanonicalNames;
      const selectedCandidate = selectFirstExistingPhpCanonicalName(candidates, existingNames, expectedDef.kind);
      let matchedCanonical: string | undefined;
      if (selectedCandidate) {
        matchedCanonical = phpCanonicalNames.find(
          (canonicalName) =>
            comparePhpReferenceNames(selectedCandidate, canonicalName, { symbolKind: expectedDef.kind }) ===
            "equivalent",
        );
      }
      if (matchedCanonical) {
        // A qualified path proves the namespace, but a bare case-variant `name` could also be a
        // same-named constant, so the equivalence is unproven for that form and coverage says so
        // instead of silently returning a short list.
        if (!isPhpQualifiedReferenceNode(node)) {
          const lastSegment = matchedCanonical.split("\\").pop() ?? matchedCanonical;
          const bareText = sliceText(node, parsed.source).trim();
          if (bareText !== lastSegment && foldPhpIdentifierCase(bareText) === foldPhpIdentifierCase(lastSegment)) {
            markPhpNameEquivalenceGap(index, expectedDef);
          }
        }
        pushVerified({ range, ...(exportFrom?.isExportFrom ? { via: { reexport: true } } : {}) });
      }
    }
  }
  return verified;
}

export function getCandidateReferenceNames(
  moduleIndex: ModuleIndex,
  definitionFile: string,
  exportedNameSet: Set<string>,
): string[] {
  const names = new Set<string>();
  let hasDirectImport = false;

  for (const imp of moduleIndex.imports) {
    const resolved = typeof imp.resolved === "string" ? imp.resolved : undefined;
    if (!resolved || fileIdentityKey(resolved) !== fileIdentityKey(definitionFile)) continue;
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
}

export function hasExpandedNamedImport(moduleIndex: ModuleIndex, targetFile: string, symbolName: string): boolean {
  const targetKey = fileIdentityKey(targetFile);
  return moduleIndex.imports.some(
    (candidate) =>
      candidate.kind === "named" &&
      candidate.local === symbolName &&
      candidate.imported === symbolName &&
      typeof candidate.resolved === "string" &&
      fileIdentityKey(candidate.resolved) === targetKey,
  );
}

const referenceCandidateCache = new WeakMap<ProjectIndex, Map<string, string[]>>();

function referenceCandidateCacheKey(index: ProjectIndex, def: SymbolDef, exportedNames: readonly string[]): string {
  const normalizeIdentifier =
    supportForFileWithoutHeaderSample(def.file, index.languageExtensions)?.normalizeIdentifier ?? ((name) => name);
  const sortedNames = exportedNames.map(normalizeIdentifier).sort();
  return `${fileIdentityKey(def.file)}::${def.range.start.index ?? 0}::canonical::${sortedNames.join("\0")}`;
}

function importCanReferenceDefinition(
  index: ProjectIndex,
  imp: ImportBinding,
  def: SymbolDef,
  exportedNames: readonly string[],
): boolean {
  const targetFile = typeof imp.resolved === "string" ? imp.resolved : undefined;
  if (!targetFile) return false;

  const resolvesToDefinition = (exportedName: string): boolean => {
    const hit = resolveExport(index, targetFile, exportedName);
    if (hit?.kind === "resolved") {
      return sameDef(hit.def, def, index.languageExtensions);
    }
    return imp.kind === "namespace" && fileIdentityKey(targetFile) === fileIdentityKey(def.file);
  };

  if (imp.kind === "named") {
    return resolvesToDefinition(imp.imported);
  }
  if (imp.kind === "default") {
    return resolvesToDefinition("default");
  }
  if (imp.kind === "star") {
    return exportedNames.some((exportedName) => {
      const result = resolveImported(index, imp, exportedName);
      return !!result && !("namespace" in result) && sameDef(result, def, index.languageExtensions);
    });
  }
  return exportedNames.some((exportedName) => resolvesToDefinition(exportedName));
}

function moduleExportProbeNames(
  index: ProjectIndex,
  moduleIndex: ModuleIndex,
  exportedNames: readonly string[],
  visited: ReadonlySet<string> = new Set(),
): string[] {
  const names = new Set(exportedNames);
  const nextVisited = new Set([...visited, fileIdentityKey(moduleIndex.file)]);
  for (const entry of moduleIndex.exports) {
    if (entry.type === "reexport" || entry.type === "namespaceReexport") {
      names.add(entry.exportedAs);
      continue;
    }
    if (entry.type === "exportStar") {
      const targetModule = index.byFile.get(fileIdentityKey(entry.fromModule));
      if (!targetModule || nextVisited.has(fileIdentityKey(targetModule.file))) continue;
      for (const exportedName of moduleExportProbeNames(index, targetModule, exportedNames, nextVisited)) {
        names.add(exportedName);
      }
    }
  }
  return [...names];
}

function filesExportingDefinition(index: ProjectIndex, def: SymbolDef, exportedNames: readonly string[]): string[] {
  const files = new Map<string, string>([[fileIdentityKey(def.file), def.file]]);
  for (const moduleIndex of index.byFile.values()) {
    const fileId = moduleIndex.file;
    if (fileIdentityKey(fileId) === fileIdentityKey(def.file) || !moduleIndex.exports.length) continue;
    for (const exportedName of moduleExportProbeNames(index, moduleIndex, exportedNames)) {
      const resolved = resolveExport(index, fileId, exportedName);
      if (resolved?.kind === "resolved" && sameDef(resolved.def, def, index.languageExtensions)) {
        files.set(fileIdentityKey(fileId), fileId);
        break;
      }
    }
    if (
      moduleIndex.exports.some(
        (entry) =>
          entry.type === "reexport" &&
          exportedNames.includes(entry.sourceSpecifier) &&
          resolveExport(index, entry.fromModule, entry.sourceSpecifier)?.kind !== "resolved",
      )
    ) {
      files.set(fileIdentityKey(fileId), fileId);
    }
  }
  return [...files.values()];
}

function getIndexedReferenceCandidateFiles(
  index: ProjectIndex,
  def: SymbolDef,
  exportedNames: readonly string[],
): readonly string[] | undefined {
  if (!index.referenceCandidates) return undefined;
  const files = new Map<string, string>();
  for (const exportingFile of filesExportingDefinition(index, def, exportedNames)) {
    for (const importingFile of candidateFilesImportingTarget(index.referenceCandidates, exportingFile) ?? []) {
      files.set(fileIdentityKey(importingFile), importingFile);
    }
  }
  for (const moduleIndex of index.byFile.values()) {
    const fileId = moduleIndex.file;
    if (fileIdentityKey(fileId) === fileIdentityKey(def.file) || files.has(fileIdentityKey(fileId))) continue;
    if (
      moduleIndex.imports.some(
        (imp) =>
          (imp.kind === "star" || imp.kind === "namespace") &&
          importCanReferenceDefinition(index, imp, def, exportedNames),
      )
    ) {
      files.set(fileIdentityKey(fileId), fileId);
    }
  }
  return [...files.values()].sort((left, right) => left.localeCompare(right));
}

export function getCachedReferenceCandidateFiles(
  index: ProjectIndex,
  def: SymbolDef,
  exportedNames: readonly string[],
  hasGlobalNameReferences: boolean,
): string[] {
  if (hasGlobalNameReferences) {
    // Callers only set this for a PHP definition (`buildPhpQualifiedNames` returns names for no
    // other language), and PHP's global-namespace fallback can be referenced from any PHP file
    // without an import, so the import-graph narrowing below cannot apply. Every other language
    // is still a sound, source-free rejection: a PHP symbol can never be referenced from a file
    // whose own language a different parser owns.
    return Array.from(index.byFile.values(), (module) => module.file)
      .filter((file) => supportForFileWithoutHeaderSample(file, index.languageExtensions)?.id === "php")
      .sort((left, right) => left.localeCompare(right));
  }

  let cache = referenceCandidateCache.get(index);
  if (!cache) {
    cache = new Map();
    referenceCandidateCache.set(index, cache);
  }

  const key = referenceCandidateCacheKey(index, def, exportedNames);
  const cached = cache.get(key);
  if (cached) return cached;

  const candidates = new Map<string, string>();
  if (def.isMember) candidates.set(fileIdentityKey(def.file), def.file);
  const candidateFileEntries =
    getIndexedReferenceCandidateFiles(index, def, exportedNames) ??
    Array.from(index.byFile.values(), (module) => module.file);
  const exportingFileIds = filesExportingDefinition(index, def, exportedNames);
  const exportingFiles = new Set(exportingFileIds.map((file) => fileIdentityKey(file)));
  for (const fileId of exportingFileIds) {
    if (fileIdentityKey(fileId) !== fileIdentityKey(def.file)) {
      candidates.set(fileIdentityKey(fileId), fileId);
    }
  }
  for (const fileId of candidateFileEntries) {
    if (fileIdentityKey(fileId) === fileIdentityKey(def.file)) continue;
    const moduleIndex = index.byFile.get(fileIdentityKey(fileId));
    if (!moduleIndex) continue;
    if (
      moduleIndex.imports.some((imp) => {
        if (typeof imp.resolved !== "string") return false;
        return (
          exportingFiles.has(fileIdentityKey(imp.resolved)) ||
          importCanReferenceDefinition(index, imp, def, exportedNames)
        );
      })
    ) {
      candidates.set(fileIdentityKey(fileId), fileId);
    }
  }

  const sorted = [...candidates.values()].sort((left, right) => left.localeCompare(right));
  cache.set(key, sorted);
  return sorted;
}

/**
 * The single precedence table for reference-coverage reasons, shared by the direct
 * indexed-candidate builder and the bounded reference lookup cache. Existing reasons keep
 * their established relative order so current expectations stay stable; the two strategy
 * reasons sit after the file-level reasons they refine and before `truncated`, because a
 * skipped collection strategy is a correctness gap while `truncated` only reflects the
 * caller's own requested bound.
 */
export const REFERENCE_COVERAGE_REASON_ORDER: readonly ReferenceCoverageReason[] = [
  "parser_degraded",
  "unresolved_import",
  "strategy_unavailable",
  "name_equivalence_unavailable",
  "truncated",
];

/**
 * A reference-collection strategy a definition's language and shape require. Coverage reports
 * `strategy_unavailable` when an applicable strategy never ran, so a reference set that is
 * missing sites because a scan was skipped can no longer claim `state: "complete"`.
 *
 * Applicability is a capability fact about the definition's language, not a result fact: a
 * strategy that legitimately produced nothing (an export with no same-file uses) is still
 * `executed`, while a strategy the language cannot run is applicable-but-not-executed.
 */
export type ReferenceStrategyId = "same_file_occurrence" | "php_qualified_name";

export type ReferenceStrategyReport = {
  applicable: readonly ReferenceStrategyId[];
  executed: readonly ReferenceStrategyId[];
};

export function describeReferenceStrategies(args: {
  languageId: string;
  /** PHP global/qualified probe names produced for the definition; empty for other languages. */
  phpQualifiedNames: readonly string[];
  /**
   * Same-file occurrence scan facts, for a language whose scope layer cannot register the
   * declaration's occurrences. Omit for languages that do register them; omitting a strategy
   * never reports it as unavailable.
   */
  sameFileOccurrence?: { applicable: boolean; executed: boolean };
}): ReferenceStrategyReport {
  const applicable: ReferenceStrategyId[] = [];
  const executed: ReferenceStrategyId[] = [];
  if (args.sameFileOccurrence?.applicable) {
    applicable.push("same_file_occurrence");
    if (args.sameFileOccurrence.executed) executed.push("same_file_occurrence");
  }
  if (args.languageId === "php") {
    // Every PHP definition is addressable by its global or namespace-qualified spelling, so
    // the qualified-name scan is required; the receiver scan is not the PHP strategy.
    applicable.push("php_qualified_name");
    if (args.phpQualifiedNames.length) executed.push("php_qualified_name");
  }
  return { applicable, executed };
}

type ImportBindingRanges = {
  importedRange: Range | undefined;
  localRange: Range | undefined;
};

export function rangeIdentityKey(range: Range): string {
  return `${range.start.line}:${range.start.column}:${range.start.index ?? ""}:${range.end.line}:${range.end.column}:${range.end.index ?? ""}`;
}

export function referenceSiteKey(file: string, range: Range): string {
  return `${fileIdentityKey(file)}:${rangeIdentityKey(range)}`;
}

export function rangesEqual(left: Range | undefined, right: Range | undefined): boolean {
  if (!left || !right) return false;
  return rangeIdentityKey(left) === rangeIdentityKey(right);
}

function bindingTokenRanges(imp: ImportBinding): ImportBindingRanges {
  if (imp.kind === "named") {
    return { importedRange: imp.importedRange, localRange: imp.localRange };
  }
  if (imp.kind === "default" || imp.kind === "namespace") {
    return { importedRange: undefined, localRange: imp.localRange };
  }
  return { importedRange: undefined, localRange: undefined };
}

export function importBindingReferenceSites(
  imp: ImportBinding,
): Array<{ range: Range; importBinding: ImportBindingRole }> {
  const sites: Array<{ range: Range; importBinding: ImportBindingRole }> = [];
  if (imp.kind === "named") {
    const { importedRange, localRange } = bindingTokenRanges(imp);
    if (importedRange) {
      sites.push({ range: importedRange, importBinding: "imported" });
    } else if (localRange && imp.local === imp.imported) {
      sites.push({ range: localRange, importBinding: "imported" });
    }
    if (localRange && !rangesEqual(localRange, importedRange)) {
      sites.push({ range: localRange, importBinding: "local" });
    }
  } else if (imp.kind === "default") {
    const { localRange } = bindingTokenRanges(imp);
    if (localRange) {
      sites.push({ range: localRange, importBinding: "local" });
    }
  }
  return sites;
}

export function importBindingIdentityVerificationSites(
  imp: ImportBinding,
): Array<{ range: Range; importBinding: ImportBindingRole }> {
  const sites = importBindingReferenceSites(imp);
  if (imp.kind !== "named" || imp.local === imp.imported) {
    return sites;
  }
  const localSites = sites.filter((site) => site.importBinding === "local");
  return localSites.length > 0 ? localSites : sites;
}

export function importBindingDeclarationRangeKeys(moduleIndex: ModuleIndex | undefined): Set<string> {
  const keys = new Set<string>();
  if (!moduleIndex) return keys;
  for (const imp of moduleIndex.imports) {
    const { importedRange, localRange } = bindingTokenRanges(imp);
    if (importedRange) keys.add(rangeIdentityKey(importedRange));
    if (localRange) keys.add(rangeIdentityKey(localRange));
  }
  return keys;
}

function structurallyExportsDefinition(
  index: ProjectIndex,
  moduleFile: string,
  exportedName: string,
  def: SymbolDef,
  definitionExportedNames: readonly string[],
  visited: Set<string> = new Set(),
): boolean {
  const normalizeIdentifier =
    supportForFileWithoutHeaderSample(moduleFile, index.languageExtensions)?.normalizeIdentifier ?? ((name) => name);
  const canonicalName = normalizeIdentifier(exportedName);
  const fileKey = fileIdentityKey(moduleFile);
  const visitKey = `${fileKey}::${canonicalName}`;
  if (visited.has(visitKey)) return false;
  visited.add(visitKey);
  if (
    fileKey === fileIdentityKey(def.file) &&
    definitionExportedNames.some((name) => normalizeIdentifier(name) === canonicalName)
  ) {
    return true;
  }
  const moduleIndex = index.byFile.get(fileKey);
  if (!moduleIndex) return false;
  for (const entry of moduleIndex.exports) {
    if (entry.type === "local") {
      if (
        normalizeIdentifier(entry.exportedAs) === canonicalName &&
        sameDef(entry.target, def, index.languageExtensions)
      ) {
        return true;
      }
      continue;
    }
    if (entry.type === "reexport" && normalizeIdentifier(entry.exportedAs) === canonicalName) {
      if (
        structurallyExportsDefinition(
          index,
          entry.fromModule,
          entry.sourceSpecifier || exportedName,
          def,
          definitionExportedNames,
          visited,
        )
      ) {
        return true;
      }
    } else if (
      entry.type === "exportStar" &&
      structurallyExportsDefinition(index, entry.fromModule, exportedName, def, definitionExportedNames, visited)
    ) {
      return true;
    }
  }
  return false;
}

function isUnresolvedIndexedImport(
  index: ProjectIndex,
  imp: ImportBinding,
  def: SymbolDef,
  exportedNames: readonly string[],
): boolean {
  if (typeof imp.resolved !== "string") return false;
  let importedName: string;
  if (imp.kind === "named") importedName = imp.imported;
  else if (imp.kind === "default") importedName = "default";
  else return false;
  if (!structurallyExportsDefinition(index, imp.resolved, importedName, def, exportedNames)) return false;
  return !importCanReferenceDefinition(index, imp, def, exportedNames);
}

function parserDegradedCandidateFiles(
  index: ProjectIndex,
  scannedFiles: readonly string[],
): { files: FileId[]; hasUnlistedCandidate: boolean } {
  const report = index.buildReport?.backend?.parser;
  if (!report) return { files: [], hasUnlistedCandidate: false };
  const scanned = new Set(scannedFiles.map((file) => fileIdentityKey(file)));
  const listed = new Set(report.files.map((entry) => fileIdentityKey(entry.file)));
  const affected: FileId[] = [];
  const seen = new Set<string>();
  for (const entry of report.files) {
    const key = fileIdentityKey(entry.file);
    if (!scanned.has(key) || seen.has(key)) continue;
    seen.add(key);
    affected.push(entry.file);
  }
  let hasUnlistedCandidate = false;
  if (report.total > report.files.length) {
    for (const fileKey of scanned) {
      if (listed.has(fileKey)) continue;
      hasUnlistedCandidate = true;
      break;
    }
  }
  return { files: affected, hasUnlistedCandidate };
}

export function buildIndexedCandidateCoverage(args: {
  index: ProjectIndex;
  def: SymbolDef;
  exportedNames: readonly string[];
  candidateFiles: readonly string[];
  scannedFiles: readonly string[];
  truncated: boolean;
  /**
   * Reference strategies applicable to this definition and the subset that actually ran.
   * Optional so existing callers compile unchanged; without it coverage keeps its historical
   * file-count behavior. When supplied, an applicable strategy absent from `executed` reports
   * `strategy_unavailable`.
   */
  strategies?: ReferenceStrategyReport;
  strategyUnavailableFiles?: readonly FileId[];
}): ReferenceCoverage {
  const {
    index,
    def,
    exportedNames,
    candidateFiles,
    scannedFiles,
    truncated,
    strategies,
    strategyUnavailableFiles = [],
  } = args;
  const reasons: ReferenceCoverageReason[] = [];
  const affectedFiles: FileId[] = [];
  const affectedSeen = new Set<string>();
  const addAffected = (file: FileId): void => {
    const key = fileIdentityKey(file);
    if (affectedSeen.has(key)) return;
    affectedSeen.add(key);
    affectedFiles.push(file);
  };

  const degraded = parserDegradedCandidateFiles(index, scannedFiles);
  if (degraded.files.length || degraded.hasUnlistedCandidate) {
    reasons.push("parser_degraded");
    for (const file of degraded.files) addAffected(file);
  }

  const unresolvedFiles: FileId[] = [];
  for (const fileId of candidateFiles) {
    const moduleIndex = index.byFile.get(fileIdentityKey(fileId));
    if (!moduleIndex) continue;
    if (moduleIndex.imports.some((imp) => isUnresolvedIndexedImport(index, imp, def, exportedNames))) {
      unresolvedFiles.push(fileId);
    }
  }
  if (unresolvedFiles.length) {
    reasons.push("unresolved_import");
    for (const file of unresolvedFiles) addAffected(file);
  }
  if (strategyUnavailableFiles.length) {
    reasons.push("strategy_unavailable");
    for (const file of strategyUnavailableFiles) addAffected(file);
  }

  if (strategies) {
    const executed = new Set(strategies.executed);
    if (strategies.applicable.some((strategy) => !executed.has(strategy))) {
      reasons.push("strategy_unavailable");
    }
  }

  if (phpNameEquivalenceGaps.get(index)?.has(definitionIdentityKey(def))) {
    reasons.push("name_equivalence_unavailable");
  }

  if (truncated) reasons.push("truncated");

  if (!reasons.length) {
    return { scope: "indexed_candidates", state: "complete" };
  }
  return {
    scope: "indexed_candidates",
    state: "partial",
    reasons: REFERENCE_COVERAGE_REASON_ORDER.filter((reason) => reasons.includes(reason)),
    ...(affectedFiles.length ? { affectedFiles } : {}),
  };
}
