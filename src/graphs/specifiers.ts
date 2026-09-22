import { type LanguageSupport } from "../languages.js";
import {
  parseCsharpUsingDirective,
  parseKotlinImportStatement,
  parsePhpImportStatement,
  parseRustImportStatements,
} from "../languages/import-statement-parsers.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { logWithLevel, type LogLevel } from "../logging.js";
import { ProjectedSyntaxTree } from "../native/projected-tree.js";
import {
  getCompactImportsExecution,
  getNativeSyntaxTreeExecution,
  isNativeQueryAuthoritative,
  supportsReducedModeRegexRecovery,
  type CompactCapture,
  type CompactQueryResults,
  type NativeCapture,
  type NativeFallbackReason,
  type NativeQueryResults,
  type NativeRuntimeMode,
} from "../native/tree-sitter-native.js";
import {
  extractGraphOnlyModuleSpecifiers,
  extractHtmlAttributeSpecifiers,
  extractHtmlInlineScriptSpecifiers,
  extractHtmlStyleSpecifiers,
  isGraphOnlyLanguage,
} from "../document-links.js";
import { sliceText, unquote } from "../util/ast.js";
import { isRustCfgTestStatement, utf8ByteOffsetToStringIndex } from "../util/rust-test-modules.js";
import { rustStatementStartIndex } from "../util/resolution/rust.js";
import {
  collectTextImportSpecifiers,
  rustSpecifierForParsedImport,
} from "../indexer/imports/text-import-extractors.js";
import {
  cFamilyImportFormFromText,
  extractJsTsSpecifiers,
  isJsTsTypeOnlySpecifierStatement,
  type ModuleSpecifier,
} from "../util/specifiers.js";

export type FallbackImportExtractionReason =
  | "fast"
  | "reduced-mode"
  | "unavailable"
  | "unsupportedLanguage"
  | "query-error"
  | "query-empty";

export type FallbackImportExtractionEvent = {
  file?: string;
  language: string;
  reason: FallbackImportExtractionReason;
};

export type CollectModuleSpecifiersOptions = {
  tree?: SyntaxTreeLike;
  nativeQueries?: NativeQueryResults | null;
  compactNativeImports?: CompactQueryResults | null;
  fast?: boolean;
  file?: string;
  fastRegexDisabledLanguages?: string[];
  onFallbackImportExtraction?: (event: FallbackImportExtractionEvent) => void;
  native?: NativeRuntimeMode;
  logLevel?: LogLevel;
};

const HTML_LIKE_LANGUAGE_IDS = new Set(["html", "vue", "svelte"]);

function isHtmlLikeLanguage(languageId: string, filePath?: string): boolean {
  if (HTML_LIKE_LANGUAGE_IDS.has(languageId)) return true;
  return !!filePath && filePath.toLowerCase().endsWith(".astro");
}

function extractPhpQualifiedSpecifiersFromTree(source: string, tree: SyntaxTreeLike): ModuleSpecifier[] {
  const specifiers: ModuleSpecifier[] = [];
  const seen = new Set<string>();
  const isPhpQualifiedNameNode = (node: SyntaxNodeLike): boolean =>
    node.type === "qualified_name" || node.type === "relative_name";
  const findPhpQualifiedTarget = (node: SyntaxNodeLike): SyntaxNodeLike | null =>
    node.namedChildren.find(isPhpQualifiedNameNode) ?? node.child(0);
  const pushSpecifier = (spec: string | null, phpImportType: "class" | "function" | "const"): void => {
    const normalized = spec?.trim();
    if (!normalized || !normalized.includes("\\")) return;
    const key = `${phpImportType}::${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    specifiers.push({ spec: normalized, phpImportType });
  };

  const walk = (node: SyntaxNodeLike): void => {
    if (node.type === "object_creation_expression") {
      const target = findPhpQualifiedTarget(node);
      if (target) pushSpecifier(sliceText(target, source), "class");
    } else if (node.type === "scoped_call_expression") {
      const target = findPhpQualifiedTarget(node);
      if (target) pushSpecifier(sliceText(target, source), "class");
    } else if (node.type === "scoped_property_access_expression") {
      const target = findPhpQualifiedTarget(node);
      if (target) pushSpecifier(sliceText(target, source), "class");
    } else if (node.type === "class_constant_access_expression") {
      const target = findPhpQualifiedTarget(node);
      if (target) pushSpecifier(sliceText(target, source), "class");
    } else if (
      (node.type === "qualified_name" || node.type === "relative_name") &&
      node.parent?.type === "named_type"
    ) {
      pushSpecifier(sliceText(node, source), "class");
    }

    for (const child of node.namedChildren) {
      walk(child);
    }
  };

  walk(tree.rootNode);
  return specifiers;
}

function normalizeModuleSpecifiers(specifiers: ModuleSpecifier[]): ModuleSpecifier[] {
  return specifiers.map((entry) =>
    entry.typeOnly
      ? entry
      : {
          spec: entry.spec,
          ...(entry.raw !== undefined ? { raw: entry.raw } : {}),
          ...(entry.phpImportType ? { phpImportType: entry.phpImportType } : {}),
          ...(entry.resolutionKind ? { resolutionKind: entry.resolutionKind } : {}),
          ...(entry.exportCondition ? { exportCondition: entry.exportCondition } : {}),
          ...(entry.dropIfUnresolved ? { dropIfUnresolved: true } : {}),
          ...(entry.resolved ? { resolved: entry.resolved } : {}),
          ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
          ...(entry.pathAttribute ? { pathAttribute: entry.pathAttribute } : {}),
          ...(entry.statementStartIndex !== undefined ? { statementStartIndex: entry.statementStartIndex } : {}),
          ...(entry.includeForm ? { includeForm: entry.includeForm } : {}),
        },
  );
}

function moduleSpecifierKey(entry: ModuleSpecifier): string {
  return `${entry.spec}::${entry.typeOnly ? 1 : 0}::${entry.exportCondition ?? ""}::${entry.pathAttribute ?? ""}::${
    entry.includeForm ?? ""
  }`;
}

function appendUniqueSpecifiers(target: ModuleSpecifier[], incoming: ModuleSpecifier[], seen: Set<string>): void {
  for (const entry of incoming) {
    const key = moduleSpecifierKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(entry);
  }
}

function makeSeenSet(target: ModuleSpecifier[]): Set<string> {
  return new Set(target.map(moduleSpecifierKey));
}

function nativeCaptureStartIndex(
  source: string,
  capture: CompactCapture | NativeCapture | undefined,
): number | undefined {
  if (capture === undefined) return undefined;
  if ("startIndex" in capture && typeof capture.startIndex === "number") {
    return utf8ByteOffsetToStringIndex(source, capture.startIndex);
  }
  if (!("start" in capture)) return undefined;
  return utf8ByteOffsetToStringIndex(source, capture.start.index);
}

function extractCssUrlSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  const re = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)\s]+))\s*\)/gi;
  for (const match of source.matchAll(re)) {
    const spec = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!spec || spec.startsWith("#")) continue;
    out.push({ spec, resolutionKind: "document" });
  }
  return out;
}

// `/// <reference path="./other.ts" />` - a type-only file dependency directive.
// Distinct from `<reference lib="..." />`/`<reference types="..." />`, which name
// a TS lib or an @types package rather than a project-relative file, and are left
// unresolved (no `path=` attribute to extract). Triple-slash directives allow their
// attributes in any order (and other attributes may appear alongside `path=`), so
// this matches the whole tag first and then searches within it for `path=`,
// rather than requiring `path=` to be the first/only attribute.
const TRIPLE_SLASH_REFERENCE_TAG_PATTERN = /^\/\/\/\s*<reference\s+([^>]*?)\/>/gm;
const TRIPLE_SLASH_PATH_ATTRIBUTE_PATTERN = /\bpath\s*=\s*["']([^"']+)["']/;

function extractTripleSlashReferenceSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  for (const tagMatch of source.matchAll(TRIPLE_SLASH_REFERENCE_TAG_PATTERN)) {
    const attributes = tagMatch[1] ?? "";
    const spec = TRIPLE_SLASH_PATH_ATTRIBUTE_PATTERN.exec(attributes)?.[1]?.trim();
    if (!spec) continue;
    out.push({ spec, typeOnly: true });
  }
  return out;
}

// Triple-slash reference edges are a source-text scan, independent of whether
// the native query ran; apply it on every TS/TSX exit path (fast-mode regex
// recovery, the native-query happy path, and the query-unavailable/query-error
// regex-recovery fallback), not just the native-query path.
function appendTripleSlashReferencesForTs(support: LanguageSupport, source: string, out: ModuleSpecifier[]): void {
  if (support.id !== "ts" && support.id !== "tsx") return;
  appendUniqueSpecifiers(out, extractTripleSlashReferenceSpecifiers(source), makeSeenSet(out));
}

function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\r\n]/g, " "));
}

const CSS_IMPORT_SPECIFIER_PATTERN =
  /(?:^|[;{}])\s*@(import|use|forward)\s+(?:\([^)]*\)\s*)?(?:url\(\s*(?:"([^"]+)"|'([^']+)'|([^)\s]+))\s*\)|"([^"]+)"|'([^']+)')(?=\s*(?:[^;{}]*;|$))/gim;

function extractCssImportSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  const cleaned = stripCssComments(source);
  for (const match of cleaned.matchAll(CSS_IMPORT_SPECIFIER_PATTERN)) {
    const spec = (match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? "").trim();
    if (!spec) continue;
    out.push({ spec, typeOnly: false, resolutionKind: "stylesheet" });
  }
  return out;
}

function extractCssModuleSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  const cleaned = stripCssComments(source);
  const patterns = [
    /(?:^|[;{}])\s*composes\s*:\s*[^;{}]*?\bfrom\s+(?:"([^"]+)"|'([^']+)')/gim,
    /(?:^|[;{}])\s*@value\s+[^;{}]*?\bfrom\s+(?:"([^"]+)"|'([^']+)')/gim,
    /(?:^|[;{}])\s*@value\s+[A-Za-z_-][\w-]*\s*:\s*(?:"([^"]+)"|'([^']+)')/gim,
  ];
  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const spec = (match[1] ?? match[2] ?? "").trim();
      if (spec) out.push({ spec, typeOnly: false, resolutionKind: "stylesheet" });
    }
  }
  return out;
}

export function mapNativeExecutionFallbackReason(
  languageId: string,
  nativeFallbackReason: NativeFallbackReason | undefined,
  queryFailed: boolean,
  queryRan: boolean,
): FallbackImportExtractionReason {
  if (queryFailed || nativeFallbackReason === "queryFailure") {
    return "query-error";
  }
  if (nativeFallbackReason === "unsupportedLanguage") {
    return "unsupportedLanguage";
  }
  // An oversized source downgraded before execution is an availability limit, not an
  // empty query result.
  if (nativeFallbackReason === "sourceTooLarge") {
    return "unavailable";
  }
  if (nativeFallbackReason === "unavailable" || !queryRan) {
    return supportsReducedModeRegexRecovery(languageId) ? "reduced-mode" : "unavailable";
  }
  return "query-empty";
}

function resolveNativeImportMatches(
  support: LanguageSupport,
  source: string,
  opts: CollectModuleSpecifiersOptions | undefined,
): {
  matches: CompactQueryResults["imports"] | NativeQueryResults["imports"] | null;
  fallbackReason?: NativeFallbackReason;
} {
  const providedImports = opts?.compactNativeImports?.imports ?? opts?.nativeQueries?.imports;
  if (providedImports !== undefined) {
    return { matches: providedImports };
  }
  const execution = getCompactImportsExecution(source, support, opts?.native);
  return {
    matches: execution.results?.imports ?? null,
    ...(execution.fallbackReason ? { fallbackReason: execution.fallbackReason } : {}),
  };
}

export function collectModuleSpecifiersFromSource(
  support: LanguageSupport,
  source: string,
  opts?: CollectModuleSpecifiersOptions,
): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];

  const supportsRegexImportRecovery = supportsReducedModeRegexRecovery(support.id);
  const htmlLikeLanguage = isHtmlLikeLanguage(support.id, opts?.file);
  const graphOnlyLanguage = isGraphOnlyLanguage(support.id);
  const fastRegexDisabled = opts?.fastRegexDisabledLanguages?.includes(support.id);
  const reportFallback = (reason: FallbackImportExtractionReason) => {
    const event: FallbackImportExtractionEvent = {
      language: support.id,
      reason,
      ...(opts?.file ? { file: opts.file } : {}),
    };
    opts?.onFallbackImportExtraction?.(event);
  };
  if (graphOnlyLanguage) {
    reportFallback("unsupportedLanguage");
    return extractGraphOnlyModuleSpecifiers(support.id, source);
  }

  const shouldAttemptFallback =
    support.id === "python" ? /\b(import|from)\b/.test(source) : /\b(import|require|from)\b/.test(source);
  const nativeImportExecution = resolveNativeImportMatches(support, source, opts);
  const resolvedNativeImports = nativeImportExecution.matches;
  const nativeFallbackReason = nativeImportExecution.fallbackReason;
  const importFallbackReason = (queryFailed: boolean): FallbackImportExtractionReason =>
    mapNativeExecutionFallbackReason(support.id, nativeFallbackReason, queryFailed, resolvedNativeImports !== null);

  // PHP keeps its tree-based qualified-usage scan (`new \Foo\Bar`, typed parameters); the
  // import statements themselves come from the shared @from capture path below. Python needs
  // no branch at all: its import queries capture @from, and the shared text-extractor tail
  // covers the recovery path.
  if (support.id === "php") {
    const phpTree =
      opts?.tree ??
      (() => {
        const nativeTreeExecution = getNativeSyntaxTreeExecution(source, support, opts?.native);
        return nativeTreeExecution.tree ? new ProjectedSyntaxTree(source, nativeTreeExecution.tree) : null;
      })();
    if (phpTree) {
      const qualifiedSpecifiers = extractPhpQualifiedSpecifiersFromTree(source, phpTree);
      if (qualifiedSpecifiers.length) out.push(...qualifiedSpecifiers);
    }
  }

  if (supportsRegexImportRecovery && opts?.fast && !fastRegexDisabled) {
    try {
      reportFallback("fast");
      for (const specifier of extractJsTsSpecifiers(source)) out.push(specifier);
    } catch {
      // ignore
    }
    appendTripleSlashReferencesForTs(support, source, out);
    return normalizeModuleSpecifiers(out);
  }

  const nativeImportsArray = resolvedNativeImports;
  const hasNativeImports = !!nativeImportsArray;
  const nativeImportsToProcess = htmlLikeLanguage ? [] : (nativeImportsArray ?? []);

  let queryFailed = false;
  // Current native add-ons retain capture offsets. Older add-ons use ordered source lookup.
  let rustStatementSearchIndex = 0;
  if (hasNativeImports) {
    try {
      for (const match of nativeImportsToProcess) {
        const capMap = Object.fromEntries(match.captures.map((capture) => [capture.name, capture] as const)) as Record<
          string,
          CompactCapture | NativeCapture | undefined
        >;
        const stmtText = capMap["stmt"]?.text ?? "";
        // TypeScript and TSX keep the dedicated statement parser (`declare module` and
        // clause-shape rules the shared hook does not model); every other language decides
        // through its `isTypeOnly` hook, so a new language needs no edit here.
        const typeOnly =
          support.id === "ts" || support.id === "tsx"
            ? isJsTsTypeOnlySpecifierStatement(stmtText)
            : support.isTypeOnly(stmtText);
        if (support.id === "kotlin") {
          const parsed = parseKotlinImportStatement(stmtText);
          if (parsed) out.push({ spec: parsed.from, typeOnly: false });
          continue;
        }
        if (support.id === "rust") {
          const capturedStartIndex = nativeCaptureStartIndex(source, capMap["stmt"]);
          const statementStartIndex = rustStatementStartIndex(
            source,
            stmtText,
            capturedStartIndex,
            rustStatementSearchIndex,
          );
          if (capturedStartIndex === undefined && statementStartIndex !== undefined) {
            rustStatementSearchIndex = statementStartIndex + stmtText.trim().length;
          }
          if (isRustCfgTestStatement(source, stmtText, statementStartIndex)) continue;
          const parsedList = parseRustImportStatements(stmtText);
          if (parsedList.length) {
            const rustSeen = makeSeenSet(out);
            appendUniqueSpecifiers(
              out,
              parsedList.map((parsed) => rustSpecifierForParsedImport(parsed, source, statementStartIndex)),
              rustSeen,
            );
            continue;
          }
        }
        if (support.id === "csharp") {
          const parsed = parseCsharpUsingDirective(stmtText);
          if (parsed) {
            out.push({ spec: parsed.from, typeOnly: false });
            continue;
          }
        }
        // PHP clause shapes have no single path node to capture: grouped `use Foo\{A, B}`
        // expands per clause, `use function`/`use const` type the resolution, and a computed
        // include needs its expression folded against the file. The statement parser handles
        // all three from the @stmt text, like the Kotlin and Rust parsers above.
        if (support.id === "php") {
          for (const parsed of parsePhpImportStatement(stmtText, opts?.file)) {
            out.push({
              spec: parsed.from,
              typeOnly: false,
              ...(parsed.kind === "named" ? { phpImportType: parsed.importType } : {}),
            });
          }
          continue;
        }
        // tree-sitter-python has no named node for the `__future__` module, so the import
        // query cannot carry @from for it; the statement text is the only source for this path.
        if (support.id === "python" && /^\s*from\s+__future__\b/.test(stmtText)) {
          out.push({ spec: "__future__" });
          continue;
        }
        const stylesheetImport = support.id === "css" || support.id === "scss" || support.id === "less";
        const isJsFamily = support.id === "js" || support.id === "ts" || support.id === "tsx";
        const isCFamily = support.id === "c" || support.id === "cpp";
        // CommonJS require() and TS `import x = require(...)` both use the require condition.
        const exportCondition = isJsFamily && /\brequire\s*\(/.test(stmtText) ? ("require" as const) : undefined;
        for (const capture of match.captures) {
          if (capture.name !== "from") continue;
          const includeForm = isCFamily ? cFamilyImportFormFromText(stmtText, capture.text) : undefined;
          out.push({
            spec: unquote(capture.text),
            typeOnly,
            ...(stylesheetImport ? { resolutionKind: "stylesheet" } : {}),
            ...(exportCondition ? { exportCondition } : {}),
            ...(includeForm ? { includeForm } : {}),
          });
        }
      }
      if (htmlLikeLanguage) {
        const beforeHtmlRecovery = out.length;
        const htmlSeen = makeSeenSet(out);
        appendUniqueSpecifiers(out, extractHtmlAttributeSpecifiers(source), htmlSeen);
        appendUniqueSpecifiers(out, extractHtmlInlineScriptSpecifiers(source), htmlSeen);
        appendUniqueSpecifiers(out, extractHtmlStyleSpecifiers(source), htmlSeen);
        if (!beforeHtmlRecovery && out.length) {
          reportFallback(importFallbackReason(false));
        }
      }
      if (support.id === "css" || support.id === "scss" || support.id === "less") {
        const beforeCssRecovery = out.length;
        const cssSeen = makeSeenSet(out);
        appendUniqueSpecifiers(out, extractCssImportSpecifiers(source), cssSeen);
        appendUniqueSpecifiers(out, extractCssModuleSpecifiers(source), cssSeen);
        appendUniqueSpecifiers(out, extractCssUrlSpecifiers(source), cssSeen);
        if (!beforeCssRecovery && out.length) {
          reportFallback(importFallbackReason(false));
        }
      }
      appendTripleSlashReferencesForTs(support, source, out);
      // Python's reduced-mode text registry still recovers when the native query ran and
      // matched nothing (e.g. native off with empty compact results); the recovery must
      // report query-empty instead of the authoritative early return dropping the imports.
      if (support.id === "python" && (queryFailed || !out.length) && shouldAttemptFallback) {
        const extracted = collectTextImportSpecifiers("python", source);
        if (extracted.length) {
          reportFallback(importFallbackReason(queryFailed));
          appendUniqueSpecifiers(out, extracted, makeSeenSet(out));
        }
      }
      if (out.length || isNativeQueryAuthoritative(support, "imports")) {
        return normalizeModuleSpecifiers(out);
      }
    } catch (error) {
      queryFailed = true;
      if (!htmlLikeLanguage) {
        logWithLevel(
          opts?.logLevel,
          "warn",
          `Warning: Native query error in collectModuleSpecifiersFromSource for ${support.id}:`,
          error,
        );
      }
      out.length = 0;
    }
  }
  if (supportsRegexImportRecovery) {
    if ((queryFailed || !out.length) && shouldAttemptFallback) {
      try {
        const extracted = extractJsTsSpecifiers(source);
        if (extracted.length) {
          reportFallback(importFallbackReason(queryFailed));
          out.push(...extracted);
        }
      } catch {
        // ignore
      }
    }
    appendTripleSlashReferencesForTs(support, source, out);
    return normalizeModuleSpecifiers(out);
  }

  const reducedRecoveryReason = importFallbackReason(queryFailed);
  if (htmlLikeLanguage && !out.length) {
    const beforeRecovery = out.length;
    const attributeSpecs = extractHtmlAttributeSpecifiers(source);
    const inlineSpecs = extractHtmlInlineScriptSpecifiers(source);
    const styleSpecs = extractHtmlStyleSpecifiers(source);
    if (attributeSpecs.length || inlineSpecs.length || styleSpecs.length) {
      const fallbackSeen = makeSeenSet(out);
      appendUniqueSpecifiers(out, attributeSpecs, fallbackSeen);
      appendUniqueSpecifiers(out, inlineSpecs, fallbackSeen);
      appendUniqueSpecifiers(out, styleSpecs, fallbackSeen);
    }
    if (out.length > beforeRecovery) {
      reportFallback(reducedRecoveryReason);
    }
  }
  if (support.id === "css" || support.id === "scss" || support.id === "less") {
    const beforeRecovery = out.length;
    const cssSeen = makeSeenSet(out);
    appendUniqueSpecifiers(out, extractCssImportSpecifiers(source), cssSeen);
    appendUniqueSpecifiers(out, extractCssModuleSpecifiers(source), cssSeen);
    appendUniqueSpecifiers(out, extractCssUrlSpecifiers(source), cssSeen);
    if (out.length > beforeRecovery) {
      reportFallback(reducedRecoveryReason);
    }
  }
  // The shared text extractor registry also serves the indexer's binding recovery, so a
  // language recovers the same specifiers on both paths instead of only one.
  if (!out.length) {
    const textSpecifiers = collectTextImportSpecifiers(support.id, source, {
      ...(opts?.file ? { file: opts.file } : {}),
    });
    if (textSpecifiers.length) {
      reportFallback(reducedRecoveryReason);
      appendUniqueSpecifiers(out, textSpecifiers, makeSeenSet(out));
    }
  }
  return normalizeModuleSpecifiers(out);
}
