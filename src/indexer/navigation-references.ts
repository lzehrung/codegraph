import path from "node:path";
import { supportForFileWithoutHeaderSample, type LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { FileId, Range } from "../types.js";
import { fileIdentityKey, normalizePath } from "../util/paths.js";
import { sliceText, toRange } from "../util/ast.js";
import { getMemberAccessParts, isMemberAccessNode, isReceiverNameNode } from "../util/member-access.js";
import {
  classifyReceiver,
  declaresMembers,
  receiverConstructorExpression,
} from "../graphs/symbol-graph-detailed/receiver-calls.js";
import { provenClassifiedReceiverOmitsMember } from "./navigation-goto.js";
import { ensureParsedContext, type ParsedFileContext } from "./parse-context.js";
import { definitionIdentityKey, sameDef } from "./reference-context.js";
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
import { isKeywordReceiver, memberSyntaxNamesFreeFunction } from "../util/member-access-tables.js";
import { getCompilationUnitPeers, getPackageDeclarationName } from "./compilation-units.js";
import { isJvmPackageSymbolVisible } from "./declaration-visibility.js";
import { findClosestScopeBinding, getOrBuildScopeIndex } from "./navigation-local.js";
import { scopeNodesFor } from "./scope-nodes.js";
import { candidateFilesImportingTarget } from "./reference-candidates.js";
import type { Binding, ScopeIndex } from "./scope.js";
import { bindingKindToSymbolKind } from "./declarations.js";
import { javaKotlinFunctionOverloadIncludes, resolveExport, resolveImported } from "./navigation-resolve.js";
import { isAmbiguousResolutionReason } from "./ambiguous-resolution.js";
import {
  ensurePhpNamespaceSymbolIndex,
  phpNamespaceSymbolIndexFor,
  phpReferenceRoleMatchesKind,
} from "./php-namespace-symbols.js";
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
import { JAVA_UNICODE_ESCAPE_BLOOM_TOKEN } from "../util/bloom-filter.js";

const EXPORT_FROM_PATTERN = new RegExp(String.raw`\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(["'])([^"']+)\2`, "gu");
const NAMESPACE_EXPORT_PATTERN = new RegExp(
  String.raw`\bexport\s*\*\s*as\s*(${ECMASCRIPT_IDENTIFIER_SOURCE})\s*from\s*(["'])([^"']+)\2`,
  "gu",
);
const EXPORT_FROM_SPECIFIER_PATTERN = new RegExp(String.raw`^(${ECMASCRIPT_IDENTIFIER_SOURCE})`, "u");

type ReexportEntry = Extract<ExportEntry, { type: "reexport" }>;

const importClosureCache = new WeakMap<ProjectIndex, Map<string, ReadonlySet<string>>>();

/** File keys reachable from `file` through resolved imports and includes, including `file`. */
function importClosure(index: ProjectIndex, file: FileId): ReadonlySet<string> {
  let byFile = importClosureCache.get(index);
  if (!byFile) {
    byFile = new Map();
    importClosureCache.set(index, byFile);
  }
  const startKey = fileIdentityKey(file);
  const cached = byFile.get(startKey);
  if (cached) return cached;
  const reached = new Set<string>([startKey]);
  const startModule = index.byFile.get(startKey);
  const pending: ModuleIndex[] = startModule ? [startModule] : [];
  while (pending.length) {
    for (const imp of pending.pop()!.imports) {
      if (typeof imp.resolved !== "string") continue;
      const key = fileIdentityKey(imp.resolved);
      if (reached.has(key)) continue;
      reached.add(key);
      const moduleEntry = index.byFile.get(key);
      if (moduleEntry) pending.push(moduleEntry);
    }
  }
  byFile.set(startKey, reached);
  return reached;
}

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
  const keepOccurrence = (binding: Binding, occurrence: Range): boolean => {
    if (exportFromIdentifier(index, fileId, occurrence, parsedCtx)?.isExportFrom) return false;
    if (parsedCtx.sup.id !== "php" || !binding.def || occurrence.start.index === binding.def.start.index) return true;
    const kind = bindingKindToSymbolKind(binding.kind);
    if (kind === SymbolKind.Variable) return true;
    const start = occurrence.start.index;
    if (start === undefined) return true;
    const node = parsedCtx.tree.rootNode.descendantForIndex(start, start);
    return phpReferenceRoleMatchesKind(node, kind);
  };
  // One builder for the shared scope cache: it reuses the module's indexed callables.
  const scopeIndex = getOrBuildScopeIndex(index, fileId, parsedCtx.source, parsedCtx.sup, moduleIndex, parsedCtx.tree);
  for (const binding of scopeIndex.all) {
    binding.occurrences = binding.occurrences.filter((occurrence) => keepOccurrence(binding, occurrence));
  }
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

const phpCanonicalNamesCache = new WeakMap<ProjectIndex, Map<string, string[]>>();
const phpNameEquivalenceGaps = new WeakMap<ProjectIndex, Set<string>>();

async function phpCanonicalDefinitionNames(index: ProjectIndex, def: SymbolDef): Promise<string[]> {
  let perIndex = phpCanonicalNamesCache.get(index);
  if (!perIndex) {
    perIndex = new Map();
    phpCanonicalNamesCache.set(index, perIndex);
  }
  const key = definitionIdentityKey(def);
  const cached = perIndex.get(key);
  if (cached) return cached;
  const indexed = phpNamespaceSymbolIndexFor(index)?.canonicalByDefinition.get(key);
  if (indexed) {
    perIndex.set(key, [indexed]);
    return [indexed];
  }
  const canonicalNames = (await readPhpDefinitionNames(index, def.file, def)).map((name) => name.replace(/^\\+/, ""));
  perIndex.set(key, canonicalNames);
  return canonicalNames;
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
    const row = scopeNodesFor(parsed.sup.id);
    const walk = (node: SyntaxNodeLike): void => {
      if (identifierTypes.has(node.type)) {
        const text = parsed.sup.normalizeIdentifier(sliceText(node, parsed.source));
        let isMatch: boolean;
        if (!isPhp) {
          isMatch = text === canonicalSymbolName;
        } else if (
          (node.type === "name" || node.type === "namespace_name") &&
          (isPhpQualifiedReferenceNode(node.parent) ||
            (node.parent && identifierTypes.has(node.parent.type) && row.childSkipNameTypes?.has(node.type)))
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
) => Promise<{ status: string; definition?: SymbolDef; provenance?: ResolutionProvenance; reason?: string }>;

/** True when `range` is the property of a member-access expression, not a bare call. */
export function isMemberAccessPropertyRange(parsed: ParsedFileContext, range: Range): boolean {
  const startIndex = range.start.index;
  const node =
    startIndex !== undefined
      ? parsed.tree.rootNode.descendantForIndex(startIndex, range.end.index ?? startIndex)
      : parsed.tree.rootNode.descendantForPosition(
          { row: range.start.line - 1, column: range.start.column - 1 },
          { row: range.start.line - 1, column: range.start.column - 1 },
        );
  const parent = node.parent;
  if (!parent || !isMemberAccessNode(parsed.sup, parent)) return false;
  const property = getMemberAccessParts(parsed.sup, parent).property;
  return !!property && node.startIndex >= property.startIndex && node.endIndex <= property.endIndex;
}

/**
 * A member call on a local, parameter, field, or `this`/`self` cannot name a free function
 * in a language whose member syntax never calls one. A missing receiver, or a module or
 * namespace binding (`util.helper()`, `mod.thing()`), stays unproven.
 */
function freeFunctionMemberSiteIsProvenNonReference(
  index: ProjectIndex,
  fileId: FileId,
  parsed: ParsedFileContext,
  objectNode: SyntaxNodeLike,
  expectedDef: SymbolDef,
): boolean {
  if (expectedDef.isMember || expectedDef.kind !== SymbolKind.Function) return false;
  if (memberSyntaxNamesFreeFunction(parsed.sup.id)) return false;
  const receiverText = sliceText(objectNode, parsed.source).trim();
  if (isKeywordReceiver(parsed.sup.id, receiverText)) return true;
  if (!isReceiverNameNode(parsed.sup, objectNode.type)) return false;
  const mod = index.byFile.get(fileIdentityKey(fileId));
  if (!mod) return false;
  const binding = findClosestScopeBinding(
    getCachedScope(index, fileId, mod, parsed),
    receiverText,
    objectNode,
    parsed.sup,
  );
  return binding?.kind === "local" || binding?.kind === "param";
}

async function receiverProofUnavailable(
  index: ProjectIndex,
  fileId: FileId,
  parsed: ParsedFileContext,
  range: Range,
  resolveDefinition: ReferenceDefinitionResolver,
  expectedDef: SymbolDef,
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
      const receiver = classifyReceiver(
        parsed.sup,
        object,
        parsed.source,
        new Map(),
        current.startIndex,
        current,
        (callee) => {
          const mod = index.byFile.get(fileIdentityKey(fileId));
          if (!mod) return true;
          const scope = getCachedScope(index, fileId, mod, parsed);
          return !!findClosestScopeBinding(scope, sliceText(callee, parsed.source), callee, parsed.sup);
        },
      );
      // A recognized shape is not proof. Exclude it only when the type is a resolved
      // member-declaring definition, every supertype resolves, and none declare this member.
      let unavailable: boolean;
      if (receiver) {
        const omits = await provenClassifiedReceiverOmitsMember(
          index,
          fileId,
          parsed,
          current,
          object,
          sliceText(property, parsed.source),
        );
        unavailable = !omits;
      } else {
        const receiverRange = toRange(object);
        const resolvedReceiver = await resolveDefinition(
          {
            file: fileId,
            line: receiverRange.start.line,
            column: receiverRange.start.column,
          },
          parsed,
        );
        unavailable = !(
          resolvedReceiver.status === "ok" &&
          resolvedReceiver.definition &&
          declaresMembers(resolvedReceiver.definition)
        );
      }
      if (!unavailable) return false;
      return !freeFunctionMemberSiteIsProvenNonReference(index, fileId, parsed, object, expectedDef);
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
      ? (await ensurePhpNamespaceSymbolIndex(index)).functionNames
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
  let definitionVisible: boolean | undefined;
  const definitionVisibleHere = (): boolean => {
    if (definitionVisible === undefined) {
      const closure = importClosure(index, fileId);
      definitionVisible = [expectedDef, ...equivalentDefinitions].some((definition) =>
        closure.has(fileIdentityKey(definition.file)),
      );
    }
    return definitionVisible;
  };
  for (const { range, node } of matched) {
    if (maxVerified !== undefined && maxVerified > 0 && verified.length >= maxVerified) {
      break;
    }
    if (isEquivalentDeclarationRange(range)) {
      pushVerified({ range });
      continue;
    }
    if (parsed.sup.id === "c" && expectedDef.kind === SymbolKind.Function) {
      let enclosing = node.parent;
      while (enclosing && enclosing.type !== "field_declaration" && enclosing.type !== "translation_unit") {
        enclosing = enclosing.parent;
      }
      // A C struct function-pointer field is not a declaration or use of a free function.
      if (enclosing?.type === "field_declaration") continue;
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
    let recoveredByLanguageFallback = false;
    if (parsed.sup.id === "php" && expectedDef.isMember) {
      const memberMatch = await phpCaseInsensitiveReceiverMemberMatch(index, fileId, node, parsed, expectedDef);
      if (memberMatch === "matched") {
        pushVerified({ range, ...(exportFrom?.isExportFrom ? { via: { reexport: true } } : {}) });
        recoveredByLanguageFallback = true;
      } else if (memberMatch === "unverified") {
        markPhpNameEquivalenceGap(index, expectedDef);
      }
    } else if (phpCanonicalNames && matchesPhpFallbackDefinition(node, parsed, expectedDef)) {
      // PHP names are case-insensitive, but a namespace spelling alone cannot prove a member or
      // distinguish a class reference from a function call. Restrict the fallback to syntax whose
      // role matches the namespace-level definition.
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
        recoveredByLanguageFallback = true;
      }
    }
    // A same-name node that direct resolution and every language-specific fallback both failed
    // to place is not provably unrelated: report the file so coverage cannot silently claim
    // `complete` while this occurrence's status stays unknown. An ambiguous result (star
    // imports, C++ overloads, or using targets) is the same kind of gap when this definition
    // (or an equivalent declaration) is visible from this file: one of the candidates may be
    // it. A name with no binding at all is proven unrelated by scope and stays out.
    if (!recoveredByLanguageFallback && onReceiverProofUnavailable) {
      if (
        (isAmbiguousResolutionReason(resolved.reason) && definitionVisibleHere()) ||
        (await receiverProofUnavailable(index, fileId, parsed, range, resolveDefinition, expectedDef))
      ) {
        onReceiverProofUnavailable(fileId);
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

/** A package import may expose a child only along its exact dotted module path. */
export function pythonParentPackageNamespacePaths(
  moduleIndex: ModuleIndex,
  definitionFile: string,
): Array<{ namespace: string; importBinding: ImportBinding }> {
  const file = normalizePath(definitionFile);
  const basename = path.posix.basename(file);
  if (!file.endsWith(".py") && !file.endsWith(".pyi")) return [];
  const moduleStem =
    basename === "__init__.py" || basename === "__init__.pyi"
      ? path.posix.dirname(file)
      : file.slice(0, -path.posix.extname(file).length);
  const paths: Array<{ namespace: string; importBinding: ImportBinding }> = [];
  for (const imp of moduleIndex.imports) {
    if (imp.kind !== "namespace" || imp.mechanism !== "python" || typeof imp.resolved !== "string") continue;
    const target = normalizePath(imp.resolved);
    const targetName = path.posix.basename(target);
    const initializer = targetName === "__init__.py" || targetName === "__init__.pyi";
    if (!initializer && (target.endsWith(".py") || target.endsWith(".pyi"))) continue;
    const packageDirectory = initializer ? path.posix.dirname(target) : target;
    const child = path.posix.relative(packageDirectory, moduleStem);
    if (!child || child.startsWith("..") || path.posix.isAbsolute(child)) continue;
    const boundName = imp.from.includes(".") && !imp.explicitAlias ? imp.from : imp.localNS;
    paths.push({ namespace: boundName + "." + child.replaceAll("/", "."), importBinding: imp });
  }
  return paths;
}

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
  languageId: string,
): boolean {
  const targetFile = typeof imp.resolved === "string" ? imp.resolved : undefined;
  if (!targetFile) return false;
  let cNamespace: "tag" | "ordinary" | undefined;
  if (languageId === "c") cNamespace = def.cTag ? "tag" : "ordinary";
  const exportOptions = cNamespace ? { cNamespace } : undefined;
  if (cNamespace && imp.kind === "named" && (imp.cNamespace ?? "ordinary") !== cNamespace) return false;

  const resolvesToDefinition = (exportedName: string): boolean => {
    const hit = resolveExport(index, targetFile, exportedName, exportOptions);
    if (hit?.kind === "resolved") {
      return sameDef(hit.def, def, index.languageExtensions);
    }
    if (javaKotlinFunctionOverloadIncludes(index, targetFile, exportedName, def)) return true;
    if (cppCanonicalStructuralExport(index, targetFile, exportedName, def, languageId)) {
      return true;
    }
    return imp.kind === "namespace" && fileIdentityKey(targetFile) === fileIdentityKey(def.file);
  };

  if (imp.kind === "named") {
    if (resolvesToDefinition(imp.imported)) return true;
    // A python `from pkg import name` binds `name` from the package's own namespace; when the
    // package has no such export, Python's own import system falls back to treating `name` as
    // an implicit submodule attribute instead (the same fallback `resolveImported` applies at
    // consumption time). Reusing that fallback here keeps candidate-file discovery in agreement
    // with the goto/reference-collection consumers that already resolve through it.
    if (languageId !== "python") return false;
    const result = resolveImported(index, imp, imp.imported, exportOptions);
    return !!result && "namespace" in result && fileIdentityKey(result.namespace) === fileIdentityKey(def.file);
  }
  if (imp.kind === "default") {
    return resolvesToDefinition("default");
  }
  if (imp.kind === "star") {
    return exportedNames.some((exportedName) => {
      const result = resolveImported(index, imp, exportedName, exportOptions);
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

function filesExportingDefinition(
  index: ProjectIndex,
  def: SymbolDef,
  exportedNames: readonly string[],
  languageId: string,
): string[] {
  const files = new Map<string, string>([[fileIdentityKey(def.file), def.file]]);
  const namespaceLinks: Array<{ sourceFile: string; exportedAs: string; targetFile: string }> = [];
  for (const moduleIndex of index.byFile.values()) {
    const fileId = moduleIndex.file;
    for (const entry of moduleIndex.exports) {
      if (entry.type === "namespaceReexport") {
        namespaceLinks.push({ sourceFile: fileId, exportedAs: entry.exportedAs, targetFile: entry.fromModule });
      }
    }
    if (fileIdentityKey(fileId) === fileIdentityKey(def.file) || !moduleIndex.exports.length) continue;
    for (const exportedName of moduleExportProbeNames(index, moduleIndex, exportedNames)) {
      const resolved = resolveExport(index, fileId, exportedName);
      if (resolved?.kind === "resolved" && sameDef(resolved.def, def, index.languageExtensions)) {
        files.set(fileIdentityKey(fileId), fileId);
        break;
      }
      if (cppCanonicalStructuralExport(index, fileId, exportedName, def, languageId)) {
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
  // A namespace re-export can expose an inner symbol through a member chain even
  // though it does not export that symbol under its own name. Include consumers
  // only when the visible namespace alias really targets the exporting module.
  let grew = true;
  while (grew) {
    grew = false;
    for (const link of namespaceLinks) {
      const sourceKey = fileIdentityKey(link.sourceFile);
      if (files.has(sourceKey) || !files.has(fileIdentityKey(link.targetFile))) continue;
      const visible = resolveExport(index, link.sourceFile, link.exportedAs, { allowLocalFallback: false });
      if (visible?.kind !== "namespace" || fileIdentityKey(visible.file) !== fileIdentityKey(link.targetFile)) {
        continue;
      }
      files.set(sourceKey, link.sourceFile);
      grew = true;
    }
  }
  return [...files.values()];
}

function getIndexedReferenceCandidateFiles(
  index: ProjectIndex,
  def: SymbolDef,
  exportedNames: readonly string[],
  languageId: string,
): readonly string[] | undefined {
  if (!index.referenceCandidates) return undefined;
  const files = new Map<string, string>();
  for (const exportingFile of filesExportingDefinition(index, def, exportedNames, languageId)) {
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
          (imp.kind === "star" || imp.kind === "namespace" || (imp.kind === "named" && imp.mechanism === "python")) &&
          importCanReferenceDefinition(index, imp, def, exportedNames, languageId),
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
  languageId: string,
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

  const key = `${languageId}:${referenceCandidateCacheKey(index, def, exportedNames)}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const candidates = new Map<string, string>();
  if (def.isMember) candidates.set(fileIdentityKey(def.file), def.file);
  // Files sharing the definition's compilation unit can name it without any import edge (Go and
  // JVM packages, C# namespaces, Swift modules), so they bypass the import filter below. C#
  // also includes same-directory files that can reach the type only through a qualified name,
  // so dotted and `global::` uses are candidates even when the consumer declares unrelated
  // namespaces. Bare-name resolution still uses the related-namespace peer set.
  for (const unitPeer of getCompilationUnitPeers(
    index,
    def.file,
    languageId === "csharp" ? { csharpQualifiedName: true } : undefined,
  ).files) {
    if (fileIdentityKey(unitPeer) !== fileIdentityKey(def.file)) {
      candidates.set(fileIdentityKey(unitPeer), unitPeer);
    }
  }
  const candidateFileEntries =
    getIndexedReferenceCandidateFiles(index, def, exportedNames, languageId) ??
    Array.from(index.byFile.values(), (module) => module.file);
  const exportingFileIds = filesExportingDefinition(index, def, exportedNames, languageId);
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
          importCanReferenceDefinition(index, imp, def, exportedNames, languageId)
        );
      })
    ) {
      candidates.set(fileIdentityKey(fileId), fileId);
    }
  }

  // A fully package-qualified use needs no import, even from another compilation unit.
  // Probe both its package root and member name; Java Unicode escapes can hide either spelling.
  if (languageId === "java" || languageId === "kotlin") {
    const packageName = getPackageDeclarationName(index, def.file, languageId);
    const rootName = packageName?.split(".")[0];
    if (rootName) {
      const exported =
        def.isMember ||
        index.byFile
          .get(fileIdentityKey(def.file))
          ?.exports.some((entry) => entry.type === "local" && sameDef(entry.target, def, index.languageExtensions));
      if (exported) {
        for (const moduleIndex of index.byFile.values()) {
          const support = supportForFileWithoutHeaderSample(moduleIndex.file, index.languageExtensions);
          if (support?.id !== "java" && support?.id !== "kotlin") continue;
          const samePackage = getPackageDeclarationName(index, moduleIndex.file, support.id) === packageName;
          if (!isJvmPackageSymbolVisible(def, languageId, support.id, samePackage)) continue;
          const fileKey = fileIdentityKey(moduleIndex.file);
          if (candidates.has(fileKey)) continue;
          const filter = index.bloomFilters?.get(fileKey);
          const rootProbe = support.normalizeIdentifier(rootName);
          const nameProbe = support.normalizeIdentifier(def.localName);
          if (
            !filter ||
            (filter.mightContain(rootProbe) && filter.mightContain(nameProbe)) ||
            (support.id === "java" && filter.mightContain(JAVA_UNICODE_ESCAPE_BLOOM_TOKEN))
          ) {
            candidates.set(fileKey, moduleIndex.file);
          }
        }
      }
    }
  }
  // A plain package import does not prove its child's attribute, but a same-name use
  // through that package must be checked before coverage can claim completeness.
  if (languageId === "python" && !def.isMember) {
    for (const moduleIndex of index.byFile.values()) {
      if (pythonParentPackageNamespacePaths(moduleIndex, def.file).length) {
        candidates.set(fileIdentityKey(moduleIndex.file), moduleIndex.file);
      }
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
export type ReferenceStrategyId = "same_file_occurrence" | "php_qualified_name" | "implicit_unit_peers";

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
  /**
   * Implicit compilation-unit peer enumeration, for languages whose files can name each
   * other's top-level declarations without imports. `executed` is true only when the unit
   * boundary is proven complete, so a unit that may extend beyond the enumerated peers
   * reports `strategy_unavailable` instead of implying full candidate coverage.
   */
  implicitUnitPeers?: { applicable: boolean; executed: boolean };
}): ReferenceStrategyReport {
  const applicable: ReferenceStrategyId[] = [];
  const executed: ReferenceStrategyId[] = [];
  if (args.sameFileOccurrence?.applicable) {
    applicable.push("same_file_occurrence");
    if (args.sameFileOccurrence.executed) executed.push("same_file_occurrence");
  }
  if (args.implicitUnitPeers?.applicable) {
    applicable.push("implicit_unit_peers");
    if (args.implicitUnitPeers.executed) executed.push("implicit_unit_peers");
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
  } else if (imp.kind === "default" || imp.kind === "namespace") {
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

/** Recover C++ overload candidates through real exports, never the unresolved-import name shortcut. */
export function cppCanonicalStructuralExport(
  index: ProjectIndex,
  targetFile: string,
  exportedName: string,
  def: SymbolDef,
  languageId: string,
): boolean {
  if (languageId !== "cpp") return false;
  return structurallyExportsDefinition(index, targetFile, exportedName, def, []);
}

function isUnresolvedIndexedImport(
  index: ProjectIndex,
  imp: ImportBinding,
  def: SymbolDef,
  exportedNames: readonly string[],
  languageId: string,
): boolean {
  if (typeof imp.resolved !== "string") return false;
  let importedName: string;
  if (imp.kind === "named") importedName = imp.imported;
  else if (imp.kind === "default") importedName = "default";
  else return false;
  if (!structurallyExportsDefinition(index, imp.resolved, importedName, def, exportedNames)) return false;
  return !importCanReferenceDefinition(index, imp, def, exportedNames, languageId);
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
  languageId: string;
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
    languageId,
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
    if (moduleIndex.imports.some((imp) => isUnresolvedIndexedImport(index, imp, def, exportedNames, languageId))) {
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
