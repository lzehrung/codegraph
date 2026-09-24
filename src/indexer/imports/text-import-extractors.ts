import {
  CSHARP_IDENTIFIER_SOURCE,
  JAVA_IDENTIFIER_SOURCE,
  KOTLIN_IDENTIFIER_SOURCE,
  XID_IDENTIFIER_SOURCE,
} from "../../util/identifiers.js";
import {
  parsePhpImportStatement,
  parseRustImportStatements,
  rustImportKeywordOffset,
  scanRustImportStatements,
  type ParsedRustImportStatement,
} from "../../languages/import-statement-parsers.js";
import { isRustCfgTestStatement } from "../../util/rust-test-modules.js";
import { extractRustModPathAttribute, rustGraphModuleSpecifier } from "../../util/resolution/rust.js";
import { extractPythonSpecifiers, type ModuleSpecifier } from "../../util/specifiers.js";
import { maskTrivia } from "../../util/trivia.js";
import { maskImportBindingTrivia } from "./binding-ranges.js";

/**
 * A statement the indexer must resolve into an import binding.
 *
 * `raw` is the exact source slice so parsers that read string payloads (Rust `#[path = "..."]`,
 * PHP `include` expressions) keep them: the discovery pass masks trivia, but the parse pass
 * must see the real text at the offsets that pass proved are code.
 */
export type TextImportBindingRequest = {
  raw: string;
  start: number;
};

export type TextImportSink = {
  /** Adds a module specifier to the file graph. */
  specifier: (specifier: ModuleSpecifier) => void;
  /** Requests a resolved binding for the statement that starts at `start`. */
  binding: (request: TextImportBindingRequest) => void;
};

export type TextImportExtractionContext = {
  /** Source file path, for parsers that resolve file-relative specifiers (PHP includes). */
  file?: string;
};

/**
 * One text import extractor: given the source text and a sink, emit every specifier it can prove
 * and, where the language has a statement parser, the statements whose bindings the indexer
 * resolves. Both consumers run the same extractor over the same source, so the graph path and the
 * binding path can no longer disagree about which imports a file has.
 */
export type TextImportExtractor = (source: string, sink: TextImportSink, context: TextImportExtractionContext) => void;

const QUOTED_VALUE_QUOTES = ['"', "'"] as const;
const GO_IMPORT_QUOTES = ['"', "`"] as const;

/**
 * Values of the quoted literals in `text[from, to)`.
 *
 * `text` must be the comment-only mask (`maskStrings: false`), not the fully masked source: the
 * discovery passes prove a statement is real code, and this pass reads the string payload it
 * contains. A quote inside a comment cannot forge a value because comments are blanked here.
 */
function scanQuotedValues(
  text: string,
  from: number,
  to: number,
  quotes: readonly string[],
): Array<{ value: string; start: number; end: number }> {
  const out: Array<{ value: string; start: number; end: number }> = [];
  for (let index = from; index < to; index += 1) {
    const ch = text[index];
    if (ch === undefined || !quotes.includes(ch)) continue;
    const close = text.indexOf(ch, index + 1);
    if (close < 0 || close >= to) break;
    out.push({ value: text.slice(index + 1, close), start: index, end: close + 1 });
    index = close;
  }
  return out;
}

/** Index of the `close` delimiter matching the `open` delimiter at `index`, or -1. */
function matchingDelimiterIndex(masked: string, index: number, open: string, close: string): number {
  let depth = 0;
  for (let cursor = index; cursor < masked.length; cursor += 1) {
    const ch = masked[cursor];
    if (ch === open) {
      depth += 1;
      continue;
    }
    if (ch !== close) continue;
    depth -= 1;
    if (depth === 0) return cursor;
  }
  return -1;
}

function lineEndAt(text: string, index: number): number {
  const newline = text.indexOf("\n", index);
  return newline < 0 ? text.length : newline;
}

const JAVA_DOTTED_SOURCE = String.raw`${JAVA_IDENTIFIER_SOURCE}(?:[\t ]*\.[\t ]*${JAVA_IDENTIFIER_SOURCE})*`;
const JAVA_IMPORT_STATEMENT_PATTERN = new RegExp(
  String.raw`^[\t ]*import[\t ]+(?:static[\t ]+)?(${JAVA_DOTTED_SOURCE})(?:[\t ]*\.[\t ]*\*)?[\t ]*;`,
  "gmu",
);

function extractJavaImports(source: string, sink: TextImportSink): void {
  if (!source.includes("import")) return;
  const masked = maskImportBindingTrivia(source, "java");
  for (const match of masked.matchAll(JAVA_IMPORT_STATEMENT_PATTERN)) {
    const rawSpecifier = match[1];
    if (!rawSpecifier || match.index === undefined) continue;
    const spec = rawSpecifier.replace(/\s+/gu, "");
    if (!spec) continue;
    sink.specifier({ spec, typeOnly: false });
    sink.binding({ raw: source.slice(match.index, match.index + match[0].length), start: match.index });
  }
}

const KOTLIN_DOTTED_SOURCE = String.raw`${KOTLIN_IDENTIFIER_SOURCE}(?:[\t ]*\.[\t ]*${KOTLIN_IDENTIFIER_SOURCE})*`;
const KOTLIN_IMPORT_STATEMENT_PATTERN = new RegExp(
  String.raw`^[\t ]*import[\t ]+(${KOTLIN_DOTTED_SOURCE})(?:[\t ]*\.[\t ]*\*)?(?:[\t ]+as[\t ]+${KOTLIN_IDENTIFIER_SOURCE})?[\t ]*;?[\t ]*$`,
  "gmu",
);

function extractKotlinImports(source: string, sink: TextImportSink): void {
  if (!source.includes("import")) return;
  const masked = maskImportBindingTrivia(source, "kotlin");
  for (const match of masked.matchAll(KOTLIN_IMPORT_STATEMENT_PATTERN)) {
    const rawSpecifier = match[1];
    if (!rawSpecifier || match.index === undefined) continue;
    const spec = rawSpecifier.replace(/\s+/gu, "");
    if (!spec) continue;
    sink.specifier({ spec, typeOnly: false });
    sink.binding({ raw: source.slice(match.index, match.index + match[0].length), start: match.index });
  }
}

const CSHARP_DOTTED_SOURCE = String.raw`${CSHARP_IDENTIFIER_SOURCE}(?:[\t ]*\.[\t ]*${CSHARP_IDENTIFIER_SOURCE})*`;
const CSHARP_USING_STATEMENT_PATTERN = new RegExp(
  String.raw`^[\t ]*(?:global[\t ]+)?using[\t ]+(?:${CSHARP_IDENTIFIER_SOURCE}[\t ]*=[\t ]*)?(?:static[\t ]+)?(${CSHARP_DOTTED_SOURCE})[\t ]*;`,
  "gmu",
);

function extractCsharpImports(source: string, sink: TextImportSink): void {
  if (!source.includes("using")) return;
  const masked = maskImportBindingTrivia(source, "csharp");
  for (const match of masked.matchAll(CSHARP_USING_STATEMENT_PATTERN)) {
    const rawSpecifier = match[1];
    if (!rawSpecifier || match.index === undefined) continue;
    const spec = rawSpecifier.replace(/\s+/gu, "");
    if (!spec) continue;
    sink.specifier({ spec, typeOnly: false });
    sink.binding({ raw: source.slice(match.index, match.index + match[0].length), start: match.index });
  }
}

const PHP_USE_STATEMENT_PATTERN = /^[\t ]*use[\t ]+/gmu;
const PHP_INCLUDE_STATEMENT_PATTERN = /^[\t ]*(?:require_once|include_once|require|include)[\t ]+/gmu;

function pushPhpStatement(
  source: string,
  start: number,
  end: number,
  sink: TextImportSink,
  context: TextImportExtractionContext,
): void {
  const raw = source.slice(start, end);
  const parsedList = parsePhpImportStatement(raw, context.file);
  if (!parsedList.length) return;
  for (const parsed of parsedList) {
    if (parsed.kind === "include") {
      sink.specifier({ spec: parsed.from, typeOnly: false });
      continue;
    }
    sink.specifier({ spec: parsed.from, typeOnly: false, phpImportType: parsed.importType });
  }
  sink.binding({ raw, start });
}

function extractPhpImports(source: string, sink: TextImportSink, context: TextImportExtractionContext): void {
  if (!source.includes("use") && !source.includes("require") && !source.includes("include")) return;
  const masked = maskImportBindingTrivia(source, "php");

  // A namespace `use` declaration is only valid at namespace scope. Tracking the brace depth of
  // real code keeps a class-body trait `use SomeTrait;` from being reported as an import; a
  // braced namespace's `use` is deliberately left out rather than guessed at.
  let braceDepth = 0;
  let scannedThrough = 0;
  for (const match of masked.matchAll(PHP_USE_STATEMENT_PATTERN)) {
    if (match.index === undefined) continue;
    for (; scannedThrough < match.index; scannedThrough += 1) {
      const ch = masked[scannedThrough];
      if (ch === "{") braceDepth += 1;
      else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    }
    const end = masked.indexOf(";", match.index + match[0].length);
    if (end < 0) continue;
    // Skip the whole statement when advancing, so a grouped `use A\{B, C};` cannot raise depth.
    scannedThrough = end + 1;
    if (braceDepth !== 0) continue;
    pushPhpStatement(source, match.index, end + 1, sink, context);
  }

  // `include`-family expressions are valid inside function bodies, so they are not depth-filtered.
  for (const match of masked.matchAll(PHP_INCLUDE_STATEMENT_PATTERN)) {
    if (match.index === undefined) continue;
    const end = masked.indexOf(";", match.index + match[0].length);
    if (end < 0) continue;
    pushPhpStatement(source, match.index, end + 1, sink, context);
  }
}

export function rustSpecifierForParsedImport(
  parsed: ParsedRustImportStatement,
  source: string,
  statementStartIndex?: number,
): ModuleSpecifier {
  if (parsed.kind === "module" && !parsed.isExternCrate) {
    const pathAttribute = parsed.pathAttribute ?? extractRustModPathAttribute(source, parsed.from, statementStartIndex);
    return {
      spec: rustGraphModuleSpecifier(source, parsed.from, statementStartIndex),
      typeOnly: false,
      ...(pathAttribute ? { pathAttribute } : {}),
      ...(statementStartIndex !== undefined ? { statementStartIndex } : {}),
    };
  }
  if (parsed.kind !== "member") {
    return { spec: parsed.from, typeOnly: false };
  }
  const root = parsed.from.split("::", 1)[0] ?? "";
  if (root === "crate" || root === "self" || root === "super") {
    return { spec: parsed.from, raw: `${parsed.from}::${parsed.imported}`, typeOnly: false };
  }
  return { spec: parsed.from, typeOnly: false };
}

function extractRustImports(source: string, sink: TextImportSink): void {
  if (!source.includes("use") && !source.includes("mod") && !source.includes("crate")) return;
  const masked = maskImportBindingTrivia(source, "rust");
  for (const statement of scanRustImportStatements(masked)) {
    const raw = source.slice(statement.start, statement.start + statement.text.length);
    const keywordOffset = rustImportKeywordOffset(raw);
    const keywordIndex = keywordOffset >= 0 ? statement.start + keywordOffset : statement.start;
    const keywordText = keywordOffset >= 0 ? raw.slice(keywordOffset) : raw;
    if (isRustCfgTestStatement(source, keywordText, keywordIndex)) continue;
    const parsedList = parseRustImportStatements(raw);
    if (!parsedList.length) continue;
    for (const parsed of parsedList) {
      sink.specifier(rustSpecifierForParsedImport(parsed, source, statement.start));
    }
    sink.binding({ raw, start: statement.start });
  }
}

function extractPythonImports(source: string, sink: TextImportSink): void {
  if (!source.includes("import")) return;
  for (const spec of extractPythonSpecifiers(source)) sink.specifier({ spec });
}

const GO_IMPORT_KEYWORD_PATTERN = /^[\t ]*import\b/gmu;

function extractGoImports(source: string, sink: TextImportSink): void {
  if (!source.includes("import")) return;
  const masked = maskImportBindingTrivia(source, "go");
  const commentsOnly = maskTrivia(source, "go", { maskStrings: false });
  for (const match of masked.matchAll(GO_IMPORT_KEYWORD_PATTERN)) {
    if (match.index === undefined) continue;
    const afterKeyword = match.index + match[0].length;
    let cursor = afterKeyword;
    while (cursor < masked.length && (masked[cursor] === " " || masked[cursor] === "\t")) cursor += 1;
    if (source[cursor] === "(") {
      const close = matchingDelimiterIndex(masked, cursor, "(", ")");
      if (close < 0) continue;
      for (const literal of scanQuotedValues(commentsOnly, cursor + 1, close, GO_IMPORT_QUOTES)) {
        const spec = literal.value.trim();
        if (spec) sink.specifier({ spec, typeOnly: false });
      }
      continue;
    }
    const literal = scanQuotedValues(commentsOnly, cursor, lineEndAt(commentsOnly, cursor), GO_IMPORT_QUOTES)[0];
    const spec = literal?.value.trim();
    if (spec) sink.specifier({ spec, typeOnly: false });
  }
}

const RUBY_REQUIRE_PATTERN = /^[\t ]*(autoload|require_relative|require|load)\b/gmu;
const RUBY_AUTOLOAD_PREFIX_PATTERN = /^[\t ]*\(?[\t ]*:?[\p{L}_][\p{L}\p{Nd}_]*[\t ]*,[\t ]*$/u;
const RUBY_DIRECT_ARGUMENT_PREFIX_PATTERN = /^[\t ]*\(?[\t ]*$/;

function extractRubyImports(source: string, sink: TextImportSink): void {
  if (!source.includes("require") && !source.includes("load") && !source.includes("autoload")) return;
  const masked = maskImportBindingTrivia(source, "ruby");
  const commentsOnly = maskTrivia(source, "ruby", { maskStrings: false });
  for (const match of masked.matchAll(RUBY_REQUIRE_PATTERN)) {
    if (match.index === undefined) continue;
    const afterKeyword = match.index + match[0].length;
    const to = lineEndAt(commentsOnly, afterKeyword);
    const literal = scanQuotedValues(commentsOnly, afterKeyword, to, QUOTED_VALUE_QUOTES)[0];
    if (!literal) continue;
    const prefix = commentsOnly.slice(afterKeyword, literal.start);
    const expectedPrefix = match[1] === "autoload" ? RUBY_AUTOLOAD_PREFIX_PATTERN : RUBY_DIRECT_ARGUMENT_PREFIX_PATTERN;
    if (!expectedPrefix.test(prefix)) continue;
    const spec = literal.value.trim();
    if (spec) sink.specifier({ spec, typeOnly: false });
  }
}

const C_INCLUDE_PATTERN = /^[\t ]*#[\t ]*include[\t ]+/gmu;
const CPP_HEADER_UNIT_IMPORT_PATTERN = /^[\t ]*(?:export[\t ]+)?import[\t ]+/gmu;
const C_INCLUDE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*/;

function extractCFamilySpecifier(
  commentsOnly: string,
  from: number,
  to: number,
  sink: TextImportSink,
  allowMacro: boolean,
): void {
  let cursor = from;
  while (cursor < to && (commentsOnly[cursor] === " " || commentsOnly[cursor] === "\t")) cursor += 1;
  const token = commentsOnly[cursor];
  if (token === '"') {
    const literal = scanQuotedValues(commentsOnly, cursor, to, ['"'])[0];
    const spec = literal?.value.trim();
    if (spec) sink.specifier({ spec, typeOnly: false, includeForm: "literal" });
    return;
  }
  if (token === "<") {
    const angle = /^<([^>\n]+)>/.exec(commentsOnly.slice(cursor, to));
    const spec = angle?.[1]?.trim();
    if (spec) sink.specifier({ spec, typeOnly: false, includeForm: "angle" });
    return;
  }
  if (!allowMacro) return;
  const identifier = C_INCLUDE_IDENTIFIER_PATTERN.exec(commentsOnly.slice(cursor, to));
  if (!identifier) return;
  // A lone identifier is an object-like macro include. Anything after it, above all the
  // argument list of a function-like `MACRO("x.h")`, is not the include path, so the
  // occurrence yields no specifier instead of the string nested in the invocation.
  if (commentsOnly.slice(cursor + identifier[0].length, to).trim()) return;
  sink.specifier({ spec: identifier[0], typeOnly: false, includeForm: "macro" });
}

function extractCIncludeImports(source: string, sink: TextImportSink): void {
  if (!source.includes("#")) return;
  const masked = maskImportBindingTrivia(source, "c");
  const commentsOnly = maskTrivia(source, "c", { maskStrings: false });
  for (const match of masked.matchAll(C_INCLUDE_PATTERN)) {
    if (match.index === undefined) continue;
    const from = match.index + match[0].length;
    // Every occurrence is classified by its own first token: the specifier text cannot prove
    // the form (`#include "HEADER"` and `#include HEADER` both spell `HEADER`).
    extractCFamilySpecifier(commentsOnly, from, lineEndAt(commentsOnly, from), sink, true);
  }
}

function extractCppImports(source: string, sink: TextImportSink): void {
  extractCIncludeImports(source, sink);
  if (!source.includes("import")) return;
  const masked = maskImportBindingTrivia(source, "cpp");
  const commentsOnly = maskTrivia(source, "cpp", { maskStrings: false });
  for (const match of masked.matchAll(CPP_HEADER_UNIT_IMPORT_PATTERN)) {
    if (match.index === undefined) continue;
    const from = match.index + match[0].length;
    // Quoted and angle header units follow include resolution. A bare target is a named module,
    // not a preprocessor macro, and remains external unless the module resolver proves it.
    extractCFamilySpecifier(commentsOnly, from, lineEndAt(commentsOnly, from), sink, false);
  }
}

const SWIFT_MODULE_SOURCE = String.raw`${XID_IDENTIFIER_SOURCE}(?:\.${XID_IDENTIFIER_SOURCE})*`;
const SWIFT_IMPORT_PATTERN = new RegExp(
  String.raw`^[\t ]*(?:@[A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?[\t ]+)*import[\t ]+(?:(?:typealias|struct|class|enum|protocol|let|var|func)[\t ]+)?(${SWIFT_MODULE_SOURCE})[\t ]*$`,
  "gmu",
);

function extractSwiftImports(source: string, sink: TextImportSink): void {
  if (!source.includes("import")) return;
  const masked = maskImportBindingTrivia(source, "swift");
  for (const match of masked.matchAll(SWIFT_IMPORT_PATTERN)) {
    const spec = match[1];
    if (!spec) continue;
    sink.specifier({ spec, typeOnly: false });
  }
}

const ZIG_IMPORT_PATTERN = /@import[\t ]*\(/g;

function extractZigImports(source: string, sink: TextImportSink): void {
  if (!source.includes("@import")) return;
  const masked = maskImportBindingTrivia(source, "zig");
  const commentsOnly = maskTrivia(source, "zig", { maskStrings: false });
  for (const match of masked.matchAll(ZIG_IMPORT_PATTERN)) {
    if (match.index === undefined) continue;
    const open = match.index + match[0].length - 1;
    const close = matchingDelimiterIndex(masked, open, "(", ")");
    const literal = scanQuotedValues(commentsOnly, open + 1, close < 0 ? commentsOnly.length : close, ['"'])[0];
    const spec = literal?.value.trim();
    if (spec) sink.specifier({ spec, typeOnly: false });
  }
}

/**
 * Text import extractors keyed by language id. Every entry has the same shape, so adding a
 * language is one registry row and no consumer branch.
 */
const TEXT_IMPORT_EXTRACTORS: Record<string, TextImportExtractor | undefined> = {
  java: extractJavaImports,
  kotlin: extractKotlinImports,
  rust: extractRustImports,
  csharp: extractCsharpImports,
  php: extractPhpImports,
  python: extractPythonImports,
  go: extractGoImports,
  ruby: extractRubyImports,
  c: extractCIncludeImports,
  cpp: extractCppImports,
  swift: extractSwiftImports,
  zig: extractZigImports,
};

/** Languages whose extractor also emits binding requests the indexer can resolve. */
const TEXT_IMPORT_BINDING_LANGUAGES: Record<string, true | undefined> = {
  java: true,
  kotlin: true,
  rust: true,
  csharp: true,
  php: true,
};

export function hasTextImportBindings(languageId: string): boolean {
  return !!TEXT_IMPORT_BINDING_LANGUAGES[languageId];
}

/** Module specifiers a language's text extractor can prove, in source order. */
export function collectTextImportSpecifiers(
  languageId: string,
  source: string,
  context?: TextImportExtractionContext,
): ModuleSpecifier[] {
  const extractor = TEXT_IMPORT_EXTRACTORS[languageId];
  if (!extractor) return [];
  const out: ModuleSpecifier[] = [];
  extractor(source, { specifier: (specifier) => out.push(specifier), binding: () => {} }, context ?? {});
  return out;
}

/** Binding requests a language's text extractor can prove, in source order. */
export function collectTextImportBindingRequests(
  languageId: string,
  source: string,
  context?: TextImportExtractionContext,
): TextImportBindingRequest[] {
  const extractor = TEXT_IMPORT_EXTRACTORS[languageId];
  if (!extractor) return [];
  const out: TextImportBindingRequest[] = [];
  extractor(source, { specifier: () => {}, binding: (request) => out.push(request) }, context ?? {});
  return out;
}
