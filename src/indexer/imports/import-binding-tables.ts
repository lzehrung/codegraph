import {
  parseCsharpUsingDirective,
  parseJavaImportStatement,
  parseKotlinImportStatement,
  parsePhpImportStatement,
  parseRustImportStatements,
  rustImportKeywordOffset,
  type ParsedRustImportStatement,
} from "../../languages/import-statement-parsers.js";
import { CSHARP_IDENTIFIER_SOURCE } from "../../util/identifiers.js";
import { isRustCfgTestStatement } from "../../util/rust-test-modules.js";
import { resolveCsharpNamespaceImportPaths } from "../../util/resolution/csharp.js";
import { extractRustModPathAttribute, resolveRustImportPath } from "../../util/resolution/rust.js";
import { attributeNamedBindingRanges, maskImportBindingTrivia } from "./binding-ranges.js";
import type { ImportBinding } from "../types.js";
import type { ImportBindingSink, ImportResolver, ResolvedImportTarget } from "./context.js";

/**
 * Per-language import-binding registry for statement overrides and implicit native-capture
 * mapping. Rows are keyed by language id and live next to `language-specific.ts` because that
 * file is the only dispatch consumer this wave.
 *
 * One row owns the statement handler, the implicit mapper, and the flags those paths used to
 * spell as `languageId === "..."` chains: trivia masking, JVM/C# dot normalization, Rust
 * statement-key offsets, C# `alwaysAliased` range attribution, and Rust's reduced-mode rescan.
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
  wildcard?: boolean;
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
  /** Include the statement start offset in the override de-dupe key (Rust). */
  statementKeyUsesOffset?: true;
  /** Named-range attribution treats unaliased `local === imported` as two tokens (C#). */
  alwaysAliased?: true;
  /** Reduced-mode text bindings re-run even when native already produced some (Rust). */
  rescanTextBindings?: true;
  /** Why the language declares no statement override. */
  statementOmittedReason?: string;
  /** Why the language declares no implicit mapper. */
  implicitOmittedReason?: string;
};

type ParsedJvmImportStatement =
  | { kind: "star"; from: string }
  | { kind: "named"; from: string; imported: string; explicitAlias?: boolean };

function pushCsharpOverride(
  context: LanguageSpecificImportContext,
  parsed: NonNullable<ReturnType<typeof parseCsharpUsingDirective>>,
  typeOnly: boolean,
  fromValue: string,
  resolved: ResolvedImportTarget,
): void {
  if (parsed.alias) {
    const fromParts = parsed.from.split(".");
    const imported = fromParts[fromParts.length - 1] ?? parsed.alias;
    context.pushBinding({
      kind: "named",
      local: parsed.alias,
      imported,
      from: fromValue,
      explicitAlias: true,
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

const CSHARP_EXTERN_ALIAS_PATTERN = new RegExp(String.raw`^extern\s+alias\s+(${CSHARP_IDENTIFIER_SOURCE})\s*;$`, "u");

async function applyCsharpStatementOverride(
  context: LanguageSpecificImportContext,
  normalizedStmt: string,
  typeOnly: boolean,
): Promise<boolean> {
  const externAlias = normalizedStmt.match(CSHARP_EXTERN_ALIAS_PATTERN)?.[1];
  if (externAlias) {
    // `extern alias X;` names a compiler-provided alias for an assembly's extern alias. It has no
    // first-party or package target, so it stays an unresolved namespace binding and produces no
    // dependency edge: the graph query does not treat it as an import specifier.
    context.pushBinding({ kind: "namespace", localNS: externAlias, from: externAlias });
    return true;
  }

  const parsed = parseCsharpUsingDirective(normalizedStmt);
  if (!parsed) return false;

  // A target that is itself a declared namespace is a namespace alias, even when the alias is
  // written in alias form. Resolving it here keeps the local name a namespace so member
  // navigation can reach the declaring file instead of treating the last segment as a type.
  // A namespace split across several files has no single target, so it keeps the local alias
  // as an unresolved namespace rather than claiming one of the declaring files.
  const namespaceTargets = await resolveCsharpNamespaceImportPaths(context.projectRoot, parsed.from, context.file);
  if (parsed.alias && namespaceTargets.length) {
    context.pushBinding({
      kind: "namespace",
      localNS: parsed.alias,
      from: parsed.from,
      ...(namespaceTargets.length === 1 ? { resolved: namespaceTargets[0]!.replace(/\\/g, "/") } : {}),
      typeOnly,
    });
    return true;
  }

  let fromValue = parsed.from;
  let resolved = await context.resolveFrom(fromValue);
  if (typeof resolved !== "string" && namespaceTargets.length === 1) {
    resolved = namespaceTargets[0]!.replace(/\\/g, "/");
  }
  if (parsed.alias) {
    const fromParts = parsed.from.split(".");
    if (typeof resolved !== "string" && fromParts.length > 1) {
      const fallbackFrom = fromParts.slice(0, -1).join(".");
      if (fallbackFrom) {
        const fallbackResolved = await context.resolveFrom(fallbackFrom);
        if (typeof fallbackResolved === "string") {
          fromValue = fallbackFrom;
          resolved = fallbackResolved;
        }
      }
    }
  }
  pushCsharpOverride(context, parsed, typeOnly, fromValue, resolved);
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
  parsed: { kind: "star"; from: string } | { kind: "named"; from: string; imported: string; explicitAlias?: boolean },
  local: string | undefined,
  typeOnly: boolean,
): Promise<boolean> {
  const resolved = await context.resolveFrom(parsed.from);
  if (parsed.kind === "star") {
    context.pushBinding({
      kind: "star",
      from: parsed.from,
      resolved,
      typeOnly,
    });
    return true;
  }

  context.pushBinding({
    kind: "named",
    local: local ?? parsed.imported,
    imported: parsed.imported,
    from: parsed.from,
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
  if (pathAttribute) {
    const attributed = await resolveRustImportPath(
      context.projectRoot,
      context.file,
      from,
      pathAttribute,
      statementStartIndex,
    );
    if (attributed) return attributed.replace(/\\/g, "/");
    return { external: from };
  }
  return context.resolveFrom(from);
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
  alwaysAliased: boolean | undefined,
): void {
  if (stmtStartIndex !== undefined && source !== undefined) {
    attributeNamedBindingRanges({
      bindings: [binding],
      fromIndex: 0,
      text: maskImportBindingTrivia(stmtText, context.languageId),
      textStartIndex: stmtStartIndex,
      source,
      ...(alwaysAliased !== undefined ? { alwaysAliased } : {}),
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
      undefined,
    );
  }
}

function appendCsharpImplicitBinding(
  context: LanguageSpecificImportContext,
  { from, resolved, typeOnly, stmtText, stmtStartIndex, source, alias }: ImplicitImportBindingArgs,
): void {
  if (alias) {
    const fromParts = from.split(".");
    const imported = fromParts[fromParts.length - 1] ?? alias;
    pushNamedImplicitBinding(
      context,
      { kind: "named", local: alias, imported, from, explicitAlias: true, resolved, typeOnly },
      stmtText,
      stmtStartIndex,
      source,
      IMPORT_BINDING_ROWS.csharp!.alwaysAliased,
    );
  } else {
    context.pushBinding({ kind: "star", from, resolved, typeOnly });
  }
}

function appendRubyImplicitBinding(
  context: LanguageSpecificImportContext,
  { from, resolved }: ImplicitImportBindingArgs,
): void {
  context.pushBinding({ kind: "star", from, resolved });
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
        undefined,
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
        undefined,
      );
  }
}

function appendSwiftImplicitBinding(
  context: LanguageSpecificImportContext,
  { from, resolved, typeOnly, stmtText, stmtStartIndex, source }: ImplicitImportBindingArgs,
): void {
  const parts = from.split(".");
  const last = parts[parts.length - 1];
  if (!last) return;
  if (parts.length === 1) {
    context.pushBinding({ kind: "namespace", localNS: last, from, resolved, typeOnly });
    context.pushBinding({ kind: "star", from, resolved, typeOnly });
  } else {
    pushNamedImplicitBinding(
      context,
      { kind: "named", local: last, imported: last, from, resolved, typeOnly },
      stmtText,
      stmtStartIndex,
      source,
      undefined,
    );
  }
}

function appendZigImplicitBinding(
  context: LanguageSpecificImportContext,
  { from, resolved, typeOnly, alias }: ImplicitImportBindingArgs,
): void {
  if (alias) context.pushBinding({ kind: "namespace", localNS: alias, from, resolved, typeOnly });
}

function appendIncludeStarImplicitBinding(
  context: LanguageSpecificImportContext,
  { from, resolved, typeOnly }: ImplicitImportBindingArgs,
): void {
  context.pushBinding({ kind: "star", from, resolved, typeOnly });
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
    appendImplicit: appendCsharpImplicitBinding,
    maskTrivia: true,
    normalizeDots: true,
    alwaysAliased: true,
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
