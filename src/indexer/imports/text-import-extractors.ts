import { CSHARP_IDENTIFIER_SOURCE, JAVA_IDENTIFIER_SOURCE, KOTLIN_IDENTIFIER_SOURCE } from "../../util/identifiers.js";
import {
  parsePhpImportStatement,
  parseRustImportStatements,
  rustImportKeywordOffset,
  scanRustImportStatements,
  type ParsedRustImportStatement,
} from "../../languages/import-statement-parsers.js";
import { isRustCfgTestStatement } from "../../util/rust-test-modules.js";
import { extractRustModPathAttribute, rustGraphModuleSpecifier } from "../../util/resolution/rust.js";
import type { ModuleSpecifier } from "../../util/specifiers.js";
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

/** A language's text import extractor used by its binding-fallback path. */
export type TextImportExtractor = (source: string, sink: TextImportSink, context: TextImportExtractionContext) => void;

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
    const prefix = match[0].slice(0, match[0].indexOf(rawSpecifier));
    const suffix = match[0].slice(match[0].indexOf(rawSpecifier) + rawSpecifier.length);
    sink.specifier({
      spec,
      typeOnly: false,
      ...(suffix.includes("*") && !prefix.includes("static") ? { jvmPackageWildcard: true } : {}),
    });
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
    const suffix = match[0].slice(match[0].indexOf(rawSpecifier) + rawSpecifier.length);
    sink.specifier({ spec, typeOnly: false, ...(suffix.includes("*") ? { jvmPackageWildcard: true } : {}) });
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
