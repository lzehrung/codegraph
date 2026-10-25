import {
  parseJavaImportStatement,
  parseKotlinImportStatement,
  parsePhpImportStatement,
  parseRustImportStatements,
  rustImportKeywordOffset,
  type ParsedRustImportStatement,
} from "../../languages/import-statement-parsers.js";
import { supportForFileWithoutHeaderSample, type LanguageExtensionMap } from "../../languages.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../../languages/types.js";
import {
  csharpExternAlias,
  csharpHasGenericTypeOwner,
  csharpImportDirectiveAt,
  csharpUsingDirective,
  parseCsharpSyntaxTree,
  type CsharpUsingDirective,
} from "../../util/csharp-tree.js";
import { normalizeCsharpIdentifier, normalizeCsharpQualifiedName } from "../../util/identifiers.js";
import { isRustCfgTestStatement } from "../../util/rust-test-modules.js";
import { recordParserBackendDegradation } from "../../native/native-backend-report.js";
import { resolveCsharpDottedTypeImportPath, resolveCsharpNamespaceImportPaths } from "../../util/resolution/csharp.js";
import { extractRustModPathAttribute } from "../../util/resolution/rust.js";
import { collectLineStartOffsets } from "../../util/lines.js";
import { attributeNamedBindingRanges, maskImportBindingTrivia, sourceRangeFromOffsets } from "./binding-ranges.js";
import type { Range } from "../../types.js";
import type { CFamilyIncludeForm, RubyLoadForm } from "../../util/specifiers.js";
import type { BuildReport, ImportBinding } from "../types.js";
import type { ImportBindingSink, ImportResolver, ResolvedImportTarget } from "./context.js";

/**
 * Per-language import-binding registry for statement overrides and implicit native-capture
 * mapping. Rows are keyed by language id and live next to `language-specific.ts` because that
 * file is the only dispatch consumer this wave.
 *
 * One row owns the statement handler, the implicit mapper, and the flags those paths used to
 * spell as `languageId === "..."` chains: trivia masking, JVM dot normalization, C# syntax-tree
 * directive/range lookup, Rust statement-key offsets, and Rust's reduced-mode rescan.
 * `text-import-extractors.ts` stays the shared discovery source; this table does not re-scan.
 *
 * `tests/import-binding-tables.test.ts` asserts every registered language has a row, that an
 * omission names a reason, and that a capability row names a reason for each handler it lacks.
 */

export type LanguageSpecificImportContext = ImportBindingSink & {
  file: string;
  projectRoot: string;
  source: string;
  languageId: string;
  resolveFrom: ImportResolver;
  /** Active extension-to-language mapping, so a resolved file is classified as the language that parses it. */
  languageExtensions?: LanguageExtensionMap;
  /** Parsed native C# tree reused to resolve using-directive captures. */
  csharpTree?: SyntaxTreeLike | null;
  report?: BuildReport;
  getBindings: () => ImportBinding[];
  replaceBindings: (bindings: ImportBinding[]) => void;
};

export type ImplicitImportBindingArgs = {
  from: string;
  resolved: ResolvedImportTarget;
  typeOnly: boolean;
  stmtText: string;
  /** UTF-16 start index of `stmtText` within the source file, when known. */
  stmtStartIndex?: number;
  source?: string;
  alias?: string;
  /** UTF-16 range of the captured alias token, when the native alias capture proved it. */
  localRange?: Range;
  wildcard?: boolean;
  includeForm?: CFamilyIncludeForm;
  rubyLoadForm?: RubyLoadForm;
};

export type ApplyStatementImportOverride = (
  context: LanguageSpecificImportContext,
  parserStmt: string,
  typeOnly: boolean,
  statementStartIndex?: number,
) => Promise<boolean>;

export type AppendImplicitImportBinding = (
  context: LanguageSpecificImportContext,
  args: ImplicitImportBindingArgs,
) => void;

/**
 * How a statement override prepares text before the parser: mask trivia, mask only PHP `use`
 * statements (includes keep string payloads), or leave the trimmed source untouched (Rust).
 */
export type StatementTriviaMask = true | false | "use-keyword";

export type ImportBindingRow = {
  /** Why the language has no statement override and no implicit mapper. */
  omittedReason?: string;
  applyStatement?: ApplyStatementImportOverride;
  appendImplicit?: AppendImplicitImportBinding;
  /** Present only with `applyStatement`. */
  maskTrivia?: StatementTriviaMask;
  /** Collapse whitespace around `.` after masking (C#, Java, Kotlin). */
  normalizeDots?: true;
  /**
   * Include the statement start offset in the override de-dupe key (C#, Rust). Required when the
   * same statement text can appear in several scopes and each must keep its own range.
   */
  statementKeyUsesOffset?: true;
  /** Reduced-mode text bindings re-run even when native already produced some (Rust). */
  rescanTextBindings?: true;
  /** Why the language declares no statement override. */
  statementOmittedReason?: string;
  /** Why the language declares no implicit mapper. */
  implicitOmittedReason?: string;
};

type ParsedJvmImportStatement =
  | { kind: "star"; from: string; isStatic?: boolean }
  | { kind: "named"; from: string; imported: string; explicitAlias?: boolean; isStatic?: boolean };

function csharpNodeRange(node: SyntaxNodeLike, source: string, lineStarts: number[]): Range {
  let startIndex = node.startIndex;
  if (startIndex && source[startIndex - 1] === "@") startIndex -= 1;
  return sourceRangeFromOffsets(lineStarts, startIndex, node.endIndex);
}

function pushCsharpOverride(
  context: LanguageSpecificImportContext,
  parsed: CsharpUsingDirective,
  typeOnly: boolean,
  fromValue: string,
  resolved: ResolvedImportTarget,
  localRange?: Range,
  importedRange?: Range,
): void {
  if (parsed.alias) {
    const localStart = localRange?.start.index;
    const importedStart = importedRange?.start.index;
    const local =
      localStart === undefined ? parsed.alias.text : context.source.slice(localStart, parsed.alias.endIndex);
    const imported =
      importedStart === undefined ? parsed.leaf.text : context.source.slice(importedStart, parsed.leaf.endIndex);
    const typeSegments = parsed.csharpTypePath?.segments;
    const csharpGenericArity = typeSegments?.[typeSegments.length - 1]?.typeArgumentCount;
    context.pushBinding({
      kind: "named",
      local,
      imported,
      from: fromValue,
      explicitAlias: true,
      ...(localRange ? { localRange } : {}),
      ...(importedRange ? { importedRange } : {}),
      ...(csharpGenericArity !== undefined ? { csharpGenericArity } : {}),
      resolved,
      typeOnly,
    });
    return;
  }

  context.pushBinding({
    kind: "star",
    from: fromValue,
    resolved,
    typeOnly,
  });
}

function csharpTreeForContext(context: LanguageSpecificImportContext): SyntaxTreeLike | null {
  if (context.csharpTree !== undefined) return context.csharpTree;
  const support = supportForFileWithoutHeaderSample(context.file, context.languageExtensions);
  if (support?.id !== "csharp") return null;
  const parsed = parseCsharpSyntaxTree(context.source, support);
  if (!parsed.tree) {
    recordParserBackendDegradation(context.report, {
      file: context.file.replace(/\\/g, "/"),
      languageId: support.id,
      ...(parsed.fallbackReason ? { nativeFallbackReason: parsed.fallbackReason } : {}),
      ...(parsed.error ? { nativeError: parsed.error } : {}),
    });
  }
  return parsed.tree;
}

function csharpImportNodeForStatement(
  tree: SyntaxTreeLike | null,
  statementStartIndex: number | undefined,
  statementText: string,
): SyntaxNodeLike | null {
  if (statementStartIndex !== undefined) return csharpImportDirectiveAt(tree, statementStartIndex);
  if (!tree) return null;
  const stack: SyntaxNodeLike[] = [tree.rootNode];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (
      (node.type === "using_directive" || node.type === "extern_alias_directive") &&
      node.text.trim() === statementText.trim()
    ) {
      return node;
    }
    stack.push(...node.namedChildren);
  }
  return null;
}

async function applyCsharpStatementOverride(
  context: LanguageSpecificImportContext,
  normalizedStmt: string,
  typeOnly: boolean,
  statementStartIndex?: number,
): Promise<boolean> {
  const tree = csharpTreeForContext(context);
  const directive = csharpImportNodeForStatement(tree, statementStartIndex, normalizedStmt);
  if (!directive) return false;

  const externAlias = csharpExternAlias(directive);
  if (externAlias) {
    // An extern alias names a compiler-provided assembly alias, so it remains unresolved and
    // does not produce a dependency edge: the graph query does not treat it as an import.
    context.pushBinding({ kind: "namespace", localNS: externAlias, from: externAlias });
    return true;
  }

  const parsed = csharpUsingDirective(directive);
  if (!parsed) return false;
  const csharpTypePath = parsed.csharpTypePath;
  if (csharpTypePath && csharpHasGenericTypeOwner(csharpTypePath)) return true;
  if (parsed.isStatic && csharpTypePath?.segments.some((segment) => segment.typeArgumentCount !== undefined)) {
    return true;
  }
  if (!parsed.alias && !parsed.isStatic && !parsed.isGlobal && csharpTypePath) {
    const target = parsed.rawValue;
    context.pushBinding({ kind: "star", from: target, resolved: { external: target }, typeOnly });
    return true;
  }
  const lineStarts = parsed.alias ? collectLineStartOffsets(context.source) : undefined;
  const localRange = parsed.alias && lineStarts ? csharpNodeRange(parsed.alias, context.source, lineStarts) : undefined;
  const importedRange =
    parsed.alias && lineStarts ? csharpNodeRange(parsed.leaf, context.source, lineStarts) : undefined;
  if (parsed.alias && csharpTypePath) {
    const typeMatch = await resolveCsharpDottedTypeImportPath(
      context.projectRoot,
      csharpTypePath,
      context.file,
      context.languageExtensions,
      context.report,
    );
    let resolved: ResolvedImportTarget = { external: parsed.value };
    if (typeMatch.status === "found") resolved = typeMatch.file;
    pushCsharpOverride(context, parsed, typeOnly, parsed.value, resolved, localRange, importedRange);
    return true;
  }

  // Static imports bind to a declaring type only when exactly one file owns that type. A global
  // static using applies to the whole project, which module-local bindings cannot express.
  if (parsed.isStatic && !parsed.isGlobal) {
    const typeMatch = await resolveCsharpDottedTypeImportPath(
      context.projectRoot,
      parsed.csharpTypePath ?? parsed.value,
      context.file,
      context.languageExtensions,
      context.report,
    );
    const qualifiedType = normalizeCsharpQualifiedName(parsed.value).replace(/^global::/u, "");
    if (typeMatch.status === "found" && qualifiedType.includes(".")) {
      context.pushBinding({
        kind: "star",
        from: parsed.value,
        resolved: typeMatch.file.replace(/\\/g, "/"),
        typeOnly,
        staticMembersOf: qualifiedType,
      });
      return true;
    }
    if (parsed.csharpTypePath) {
      context.pushBinding({
        kind: "star",
        from: parsed.rawValue,
        resolved: { external: parsed.rawValue },
        typeOnly,
      });
      return true;
    }
  }

  // A target declared as a namespace remains a namespace alias, even when written with alias
  // syntax. Ambiguous namespaces stay unresolved rather than claiming one declaring file.
  const namespaceTargets = await resolveCsharpNamespaceImportPaths(
    context.projectRoot,
    parsed.value,
    context.file,
    context.languageExtensions,
    context.report,
  );
  if (parsed.alias && namespaceTargets.length) {
    context.pushBinding({
      kind: "namespace",
      localNS: normalizeCsharpIdentifier(parsed.alias.text),
      from: parsed.value,
      ...(namespaceTargets.length === 1 ? { resolved: namespaceTargets[0]!.replace(/\\/g, "/") } : {}),
      typeOnly,
      ...(localRange ? { localRange } : {}),
    });
    return true;
  }

  let fromValue = parsed.value;
  // A plain using names a namespace, which ordinary C# declares across many files. Bind it to a
  // representative declaring file; namespace-qualified export lookup reaches all files through
  // the compilation-unit relation. Path-like resolution applies only when no file declares it.
  let resolved: ResolvedImportTarget;
  if (parsed.alias) {
    resolved = await context.resolveFrom(fromValue);
  } else if (namespaceTargets.length) {
    resolved = namespaceTargets[0]!.replace(/\\/g, "/");
  } else {
    resolved = await context.resolveFrom(fromValue);
  }
  if (parsed.alias) {
    const fromParts = parsed.value.split(".");
    if (fromParts.length > 1) {
      const fallbackFrom = fromParts.slice(0, -1).join(".");
      if (fallbackFrom) {
        // A type alias names a type in a namespace. Resolve the type across every namespace file;
        // an ambiguous result stays external instead of selecting a path-like first match.
        const fallbackNamespaceTargets = await resolveCsharpNamespaceImportPaths(
          context.projectRoot,
          fallbackFrom,
          context.file,
          context.languageExtensions,
          context.report,
        );
        if (fallbackNamespaceTargets.length > 1) {
          const typeMatch = await resolveCsharpDottedTypeImportPath(
            context.projectRoot,
            parsed.value,
            context.file,
            context.languageExtensions,
            context.report,
          );
          if (typeMatch.status === "found") {
            fromValue = fallbackFrom;
            resolved = typeMatch.file;
          } else {
            fromValue = parsed.value;
            resolved = { external: parsed.value };
          }
        } else if (typeof resolved !== "string" && fallbackNamespaceTargets.length === 1) {
          const typeMatch = await resolveCsharpDottedTypeImportPath(
            context.projectRoot,
            parsed.value,
            context.file,
            context.languageExtensions,
            context.report,
          );
          if (typeMatch.status === "partial") {
            fromValue = parsed.value;
            resolved = { external: parsed.value };
          } else {
            fromValue = fallbackFrom;
            resolved = fallbackNamespaceTargets[0]!.replace(/\\/g, "/");
          }
        } else if (typeof resolved !== "string") {
          const fallbackResolved = await context.resolveFrom(fallbackFrom);
          if (typeof fallbackResolved === "string") {
            fromValue = fallbackFrom;
            resolved = fallbackResolved;
          }
        }
      }
    }
  }
  pushCsharpOverride(context, parsed, typeOnly, fromValue, resolved, localRange, importedRange);
  return true;
}

async function applyJavaStatementOverride(
  context: LanguageSpecificImportContext,
  normalizedStmt: string,
  typeOnly: boolean,
): Promise<boolean> {
  return await applyJvmStatementOverride(context, normalizedStmt, typeOnly, parseJavaImportStatement, (parsed) => {
    if (parsed.kind === "named") return parsed.imported;
    return undefined;
  });
}

async function applyKotlinStatementOverride(
  context: LanguageSpecificImportContext,
  normalizedStmt: string,
  typeOnly: boolean,
): Promise<boolean> {
  return await applyJvmStatementOverride(context, normalizedStmt, typeOnly, parseKotlinImportStatement, (parsed) => {
    if (parsed.kind === "named") return parsed.local;
    return undefined;
  });
}

async function applyJvmStatementOverride<TParsed extends ParsedJvmImportStatement>(
  context: LanguageSpecificImportContext,
  normalizedStmt: string,
  typeOnly: boolean,
  parseStatement: (statement: string) => TParsed | null,
  localNameFor: (parsed: TParsed) => string | undefined,
): Promise<boolean> {
  const parsed = parseStatement(normalizedStmt);
  if (!parsed) return false;
  return await pushJvmImportBinding(context, parsed, localNameFor(parsed), typeOnly);
}

async function pushJvmImportBinding(
  context: LanguageSpecificImportContext,
  parsed: ParsedJvmImportStatement,
  local: string | undefined,
  typeOnly: boolean,
): Promise<boolean> {
  const resolved = await context.resolveFrom(
    parsed.from,
    undefined,
    parsed.kind === "star" && !parsed.isStatic ? { jvmPackageWildcard: true } : undefined,
  );
  if (parsed.kind === "star") {
    context.pushBinding({
      kind: "star",
      from: parsed.from,
      resolved,
      ...(parsed.isStatic
        ? { jvmStaticWildcardName: parsed.from.slice(parsed.from.lastIndexOf(".") + 1) }
        : { jvmTypeWildcardName: parsed.from.slice(parsed.from.lastIndexOf(".") + 1) }),
      typeOnly,
    });
    return true;
  }

  context.pushBinding({
    kind: "named",
    local: local ?? parsed.imported,
    imported: parsed.imported,
    from: parsed.from,
    ...(parsed.isStatic && context.languageId === "java"
      ? { jvmStaticWildcardName: parsed.from.slice(parsed.from.lastIndexOf(".") + 1) }
      : {}),
    ...(parsed.explicitAlias ? { explicitAlias: true } : {}),
    resolved,
    typeOnly,
  });
  return true;
}

async function applyRustStatementOverride(
  context: LanguageSpecificImportContext,
  normalizedStmt: string,
  typeOnly: boolean,
  statementStartIndex?: number,
): Promise<boolean> {
  if (isRustTestOnlyStatement(context, normalizedStmt, statementStartIndex)) return true;

  const parsedList = parseRustImportStatements(normalizedStmt);
  if (!parsedList.length) return false;
  const seen = new Set(context.getBindings().map(rustBindingKey));
  await pushParsedRustImports(context, parsedList, typeOnly, statementStartIndex, seen);
  return true;
}

async function resolveRustParsedFrom(
  context: LanguageSpecificImportContext,
  from: string,
  pathAttribute?: string,
  statementStartIndex?: number,
): Promise<ResolvedImportTarget> {
  return context.resolveFrom(from, undefined, {
    ...(pathAttribute ? { pathAttribute } : {}),
    ...(statementStartIndex !== undefined ? { statementStartIndex } : {}),
  });
}

function rustBindingKey(binding: ImportBinding): string {
  const resolved = JSON.stringify(binding.resolved);
  if (binding.kind === "named") return `named:${binding.local}:${binding.imported}:${binding.from}:${resolved}`;
  if (binding.kind === "namespace") return `namespace:${binding.localNS}:${binding.from}:${resolved}`;
  if (binding.kind === "star") return `star:${binding.from}:${resolved}`;
  return JSON.stringify(binding);
}

function buildRustBinding(
  parsed: ParsedRustImportStatement,
  resolved: ResolvedImportTarget,
  typeOnly: boolean,
): ImportBinding {
  if (parsed.kind === "member") {
    return {
      kind: "named",
      local: parsed.local,
      imported: parsed.imported,
      from: parsed.from,
      ...(parsed.explicitAlias ? { explicitAlias: true } : {}),
      resolved,
      typeOnly,
    };
  }
  if (parsed.kind === "module") {
    return { kind: "namespace", localNS: parsed.local, from: parsed.from, resolved, typeOnly };
  }
  return { kind: "star", from: parsed.from, resolved, typeOnly };
}

async function pushParsedRustImports(
  context: LanguageSpecificImportContext,
  parsedList: ReturnType<typeof parseRustImportStatements>,
  typeOnly: boolean,
  statementStartIndex: number | undefined,
  seen: Set<string>,
): Promise<void> {
  const statementPathAttribute = extractRustModPathAttribute(context.source, undefined, statementStartIndex);
  for (const parsed of parsedList) {
    const pathAttribute =
      parsed.kind === "module" && !parsed.isExternCrate ? (parsed.pathAttribute ?? statementPathAttribute) : undefined;
    const resolved = await resolveRustParsedFrom(context, parsed.from, pathAttribute, statementStartIndex);
    const binding = buildRustBinding(parsed, resolved, typeOnly);
    const key = rustBindingKey(binding);
    if (seen.has(key)) continue;
    seen.add(key);
    context.pushBinding(binding);
  }
}

function isRustTestOnlyStatement(
  context: LanguageSpecificImportContext,
  normalizedStmt: string,
  statementStartIndex?: number,
): boolean {
  if (context.languageId !== "rust") return false;
  if (statementStartIndex !== undefined) {
    const keywordOffset = rustImportKeywordOffset(context.source.slice(statementStartIndex));
    const keywordIndex = keywordOffset >= 0 ? statementStartIndex + keywordOffset : statementStartIndex;
    const keywordText = keywordOffset >= 0 ? context.source.slice(keywordIndex) : normalizedStmt;
    return isRustCfgTestStatement(context.source, keywordText, keywordIndex);
  }
  return isRustCfgTestStatement(context.source, normalizedStmt, statementStartIndex);
}

async function applyPhpStatementOverride(
  context: LanguageSpecificImportContext,
  normalizedStmt: string,
  typeOnly: boolean,
): Promise<boolean> {
  const parsed = parsePhpImportStatement(normalizedStmt, context.file);
  if (!parsed.length) return false;

  for (const entry of parsed) {
    if (entry.kind === "include") {
      const resolved = await context.resolveFrom(entry.from);
      context.pushBinding({
        kind: "star",
        from: entry.from,
        resolved,
        typeOnly,
        mechanism: "php",
      });
      continue;
    }
    const resolved = await context.resolveFrom(entry.from, entry.importType);
    context.pushBinding({
      kind: "named",
      local: entry.local,
      imported: entry.imported,
      from: entry.from,
      ...(entry.explicitAlias ? { explicitAlias: true } : {}),
      phpImportType: entry.importType,
      resolved,
      typeOnly,
      mechanism: "php",
    });
  }
  return true;
}

function pushNamedImplicitBinding(
  context: LanguageSpecificImportContext,
  binding: ImportBinding,
  stmtText: string,
  stmtStartIndex: number | undefined,
  source: string | undefined,
): void {
  if (stmtStartIndex !== undefined && source !== undefined) {
    attributeNamedBindingRanges({
      bindings: [binding],
      fromIndex: 0,
      text: maskImportBindingTrivia(stmtText, context.languageId),
      textStartIndex: stmtStartIndex,
      source,
    });
  }
  context.pushBinding(binding);
}

function appendJavaImplicitBinding(
  context: LanguageSpecificImportContext,
  { from, resolved, typeOnly, stmtText, stmtStartIndex, source }: ImplicitImportBindingArgs,
): void {
  const parts = from.split(".");
  const last = parts[parts.length - 1];
  if (last === "*") {
    context.pushBinding({ kind: "star", from, resolved, typeOnly });
  } else if (last) {
    pushNamedImplicitBinding(
      context,
      { kind: "named", local: last, imported: last, from, resolved, typeOnly },
      stmtText,
      stmtStartIndex,
      source,
    );
  }
}

function appendRubyImplicitBinding(
  context: LanguageSpecificImportContext,
  { from, resolved, rubyLoadForm }: ImplicitImportBindingArgs,
): void {
  context.pushBinding({ kind: "star", from, resolved, ...(rubyLoadForm ? { rubyLoadForm } : {}) });
}

function appendGoImplicitBinding(
  context: LanguageSpecificImportContext,
  { from, resolved, alias }: ImplicitImportBindingArgs,
): void {
  if (alias === "_") return;
  if (alias === ".") {
    context.pushBinding({ kind: "star", from, resolved });
    return;
  }
  if (alias) {
    context.pushBinding({ kind: "namespace", localNS: alias, from, resolved });
    return;
  }
  const parts = from.replace(/"/g, "").split("/");
  const last = parts[parts.length - 1];
  if (last) context.pushBinding({ kind: "namespace", localNS: last, from, resolved });
}

function appendRustImplicitBinding(
  context: LanguageSpecificImportContext,
  { from, resolved, stmtText, stmtStartIndex, source }: ImplicitImportBindingArgs,
): void {
  if (stmtText.startsWith("mod ")) {
    context.pushBinding({ kind: "namespace", localNS: from, from, resolved });
  } else {
    const parts = from.split("::");
    const last = parts[parts.length - 1];
    if (!last) return;
    if (last === "*") {
      context.pushBinding({ kind: "star", from, resolved });
    } else {
      pushNamedImplicitBinding(
        context,
        { kind: "named", local: last, imported: last, from, resolved },
        stmtText,
        stmtStartIndex,
        source,
      );
    }
  }
}

function appendKotlinImplicitBinding(
  context: LanguageSpecificImportContext,
  { from, resolved, typeOnly, stmtText, stmtStartIndex, source, alias, wildcard }: ImplicitImportBindingArgs,
): void {
  if (wildcard || from.endsWith(".*")) {
    context.pushBinding({ kind: "star", from, resolved, typeOnly });
  } else {
    const parts = from.split(".");
    const imported = parts[parts.length - 1];
    if (imported)
      pushNamedImplicitBinding(
        context,
        {
          kind: "named",
          local: alias ?? imported,
          imported,
          from,
          ...(alias !== undefined ? { explicitAlias: true } : {}),
          resolved,
          typeOnly,
        },
        stmtText,
        stmtStartIndex,
        source,
      );
  }
}

function swiftModuleLocalRange(
  source: string | undefined,
  statementStartIndex: number | undefined,
  statementText: string,
  name: string,
): Range | undefined {
  if (!source || statementStartIndex === undefined || !name) return undefined;
  const masked = maskImportBindingTrivia(statementText, "swift");
  let found = -1;
  let searchFrom = 0;
  for (;;) {
    const index = masked.indexOf(name, searchFrom);
    if (index < 0) break;
    const before = index === 0 ? "" : masked[index - 1]!;
    const after = masked[index + name.length] ?? "";
    const boundary = /[^\p{L}\p{N}_]/u;
    if ((index === 0 || boundary.test(before)) && (after === "" || boundary.test(after))) found = index;
    searchFrom = index + name.length;
  }
  if (found < 0) return undefined;
  const startIndex = statementStartIndex + found;
  return sourceRangeFromOffsets(collectLineStartOffsets(source), startIndex, startIndex + name.length);
}

function appendSwiftImplicitBinding(
  context: LanguageSpecificImportContext,
  { from, resolved, typeOnly, stmtText, stmtStartIndex, source }: ImplicitImportBindingArgs,
): void {
  const parts = from.split(".");
  const last = parts[parts.length - 1];
  if (!last) return;
  if (parts.length === 1) {
    // The module name keeps its source range so `import Utils` stays an explicit namespace
    // binding. The companion star import has no range and remains the expansion source.
    const localRange = swiftModuleLocalRange(source, stmtStartIndex, stmtText, last);
    context.pushBinding({
      kind: "namespace",
      localNS: last,
      from,
      resolved,
      typeOnly,
      ...(localRange ? { localRange } : {}),
    });
    context.pushBinding({ kind: "star", from, resolved, typeOnly });
  } else {
    pushNamedImplicitBinding(
      context,
      { kind: "named", local: last, imported: last, from, resolved, typeOnly },
      stmtText,
      stmtStartIndex,
      source,
    );
  }
}

function appendZigImplicitBinding(
  context: LanguageSpecificImportContext,
  { from, resolved, typeOnly, alias, localRange }: ImplicitImportBindingArgs,
): void {
  if (!alias) return;
  context.pushBinding({
    kind: "namespace",
    localNS: alias,
    from,
    resolved,
    typeOnly,
    ...(localRange ? { localRange } : {}),
  });
}

function appendIncludeStarImplicitBinding(
  context: LanguageSpecificImportContext,
  { from, resolved, typeOnly, includeForm }: ImplicitImportBindingArgs,
): void {
  context.pushBinding({
    kind: "star",
    from,
    resolved,
    typeOnly,
    ...(includeForm ? { includeForm } : {}),
  });
}

const ECMASCRIPT_STATEMENT_OMITTED =
  "ECMAScript import bindings come from native captures and the JS text fallback, not a statement parser override.";
const ECMASCRIPT_IMPLICIT_OMITTED =
  "ECMAScript named/default/namespace/star bindings are emitted from native captures; implicit mapping is unused.";
const STYLESHEET_OMITTED = "Style language; import bindings are graph-only stylesheet specifiers, not this registry.";
const INCLUDE_STATEMENT_OMITTED =
  "C/C++ #include bindings are implicit star imports from native captures; there is no statement parser override.";

export const IMPORT_BINDING_ROWS: Record<string, ImportBindingRow> = {
  adoc: { omittedReason: "AsciiDoc document format; embedded code blocks parse as their own language." },
  astro: { omittedReason: "Astro document format; scripts parse as js/ts and templates as html." },
  c: {
    appendImplicit: appendIncludeStarImplicitBinding,
    statementOmittedReason: INCLUDE_STATEMENT_OMITTED,
  },
  cpp: {
    appendImplicit: appendIncludeStarImplicitBinding,
    statementOmittedReason: INCLUDE_STATEMENT_OMITTED,
  },
  css: { omittedReason: STYLESHEET_OMITTED },
  csharp: {
    applyStatement: applyCsharpStatementOverride,
    statementKeyUsesOffset: true,
    maskTrivia: false,
    implicitOmittedReason: "C# using-directive captures are handled by the native syntax-tree statement override.",
  },
  go: {
    appendImplicit: appendGoImplicitBinding,
    statementOmittedReason:
      "Go import bindings come from native captures plus implicit alias/blank/dot mapping; there is no statement parser override.",
  },
  hbs: { omittedReason: "Handlebars document format; embedded scripts parse as their own language." },
  html: { omittedReason: "Document format; embedded scripts parse as their own language." },
  java: {
    applyStatement: applyJavaStatementOverride,
    appendImplicit: appendJavaImplicitBinding,
    maskTrivia: true,
    normalizeDots: true,
  },
  js: {
    statementOmittedReason: ECMASCRIPT_STATEMENT_OMITTED,
    implicitOmittedReason: ECMASCRIPT_IMPLICIT_OMITTED,
  },
  kotlin: {
    applyStatement: applyKotlinStatementOverride,
    appendImplicit: appendKotlinImplicitBinding,
    maskTrivia: true,
    normalizeDots: true,
  },
  less: { omittedReason: STYLESHEET_OMITTED },
  markdown: { omittedReason: "Document format; fenced code blocks parse as their own language." },
  mdx: { omittedReason: "MDX document format; scripts parse as js/ts and templates as html." },
  php: {
    applyStatement: applyPhpStatementOverride,
    maskTrivia: "use-keyword",
    implicitOmittedReason: "PHP use and include statements are fully handled by the statement override.",
  },
  python: {
    omittedReason:
      "Python import bindings are collected in python.ts, not through statement overrides or implicit mapping.",
  },
  rst: { omittedReason: "reStructuredText document format; embedded code blocks parse as their own language." },
  ruby: {
    appendImplicit: appendRubyImplicitBinding,
    statementOmittedReason:
      "Ruby require/load/autoload bindings are implicit star imports from native captures; there is no statement parser override.",
  },
  rust: {
    applyStatement: applyRustStatementOverride,
    appendImplicit: appendRustImplicitBinding,
    maskTrivia: false,
    statementKeyUsesOffset: true,
    rescanTextBindings: true,
  },
  scss: { omittedReason: STYLESHEET_OMITTED },
  sql: { omittedReason: "Data language; no import-statement or implicit-binding dispatch." },
  terraform: {
    omittedReason: "A module call binds no local names; `module.<name>` resolves in src/terraform/.",
  },
  svelte: { omittedReason: "Svelte component format; script blocks parse as js/ts and templates as html." },
  swift: {
    appendImplicit: appendSwiftImplicitBinding,
    statementOmittedReason:
      "Swift import bindings are implicit namespace/star (or named) mappings from native captures; there is no statement parser override.",
  },
  ts: {
    statementOmittedReason: ECMASCRIPT_STATEMENT_OMITTED,
    implicitOmittedReason: ECMASCRIPT_IMPLICIT_OMITTED,
  },
  tsx: {
    statementOmittedReason: ECMASCRIPT_STATEMENT_OMITTED,
    implicitOmittedReason: ECMASCRIPT_IMPLICIT_OMITTED,
  },
  vue: { omittedReason: "Vue component format; script blocks parse as js/ts and templates as html." },
  zig: {
    appendImplicit: appendZigImplicitBinding,
    statementOmittedReason:
      "Zig @import bindings are implicit namespace mappings from the captured alias; there is no statement parser override.",
  },
};
