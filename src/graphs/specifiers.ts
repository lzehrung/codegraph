import { type LanguageSupport } from "../languages.js";
import {
  parseCsharpUsingDirective,
  parseJavaImportStatement,
  parseKotlinImportStatement,
  parsePhpImportStatement,
  parseRustImportStatements,
} from "../languages/import-statement-parsers.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { recordNativeExecutionOutcome } from "../native/native-backend-report.js";
import type { BuildReport } from "../indexer/types.js";
import { errorMessage } from "../util/errors.js";
import { DEFAULT_NATIVE_SOURCE_MAX_BYTES } from "../worker/native-extract-worker.js";
import type { LogLevel } from "../logging.js";
import { ProjectedSyntaxTree } from "../native/projected-tree.js";
import {
  getCompactImportsExecution,
  getNativeSyntaxTreeExecution,
  type CompactCapture,
  type CompactQueryResults,
  type NativeCapture,
  type NativeQueryResults,
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
import { pythonTypeCheckingContext } from "../util/python-type-checking.js";
import { maskImportBindingTrivia } from "../indexer/imports/binding-ranges.js";
import { rustSpecifierForParsedImport } from "../indexer/imports/text-import-extractors.js";
import {
  cFamilyImportFormFromText,
  isJsTsTypeOnlySpecifierStatement,
  isRubyLoadForm,
  type ModuleSpecifier,
} from "../util/specifiers.js";

export type CollectModuleSpecifiersOptions = {
  tree?: SyntaxTreeLike;
  nativeQueries?: NativeQueryResults | null;
  compactNativeImports?: CompactQueryResults | null;
  fast?: boolean;
  file?: string;
  logLevel?: LogLevel;
  report?: BuildReport;
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
          ...(entry.jvmPackageWildcard ? { jvmPackageWildcard: true } : {}),
          ...(entry.phpImportType ? { phpImportType: entry.phpImportType } : {}),
          ...(entry.resolutionKind ? { resolutionKind: entry.resolutionKind } : {}),
          ...(entry.exportCondition ? { exportCondition: entry.exportCondition } : {}),
          ...(entry.dropIfUnresolved ? { dropIfUnresolved: true } : {}),
          ...(entry.resolved ? { resolved: entry.resolved } : {}),
          ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
          ...(entry.pathAttribute ? { pathAttribute: entry.pathAttribute } : {}),
          ...(entry.statementStartIndex !== undefined ? { statementStartIndex: entry.statementStartIndex } : {}),
          ...(entry.includeForm ? { includeForm: entry.includeForm } : {}),
          ...(entry.rubyLoadForm ? { rubyLoadForm: entry.rubyLoadForm } : {}),
        },
  );
}

function moduleSpecifierKey(entry: ModuleSpecifier): string {
  return `${entry.spec}::${entry.typeOnly ? 1 : 0}::${entry.phpImportType ?? ""}::${
    entry.exportCondition ?? ""
  }::${entry.pathAttribute ?? ""}::${entry.includeForm ?? ""}::${entry.rubyLoadForm ?? ""}::${entry.jvmPackageWildcard ? 1 : 0}::${
    entry.resolutionKind ?? ""
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
function nativeCaptureStartIndex(source: string, capture: CompactCapture | NativeCapture): number {
  return utf8ByteOffsetToStringIndex(source, "startIndex" in capture ? capture.startIndex : capture.start.index);
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

// Triple-slash path directives supplement native TS/TSX import captures.
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

function resolveNativeImportMatches(
  support: LanguageSupport,
  source: string,
  opts: CollectModuleSpecifiersOptions | undefined,
): {
  matches: CompactQueryResults["imports"] | NativeQueryResults["imports"] | null;
} {
  if (opts?.compactNativeImports !== undefined) return { matches: opts.compactNativeImports?.imports ?? null };
  if (opts?.nativeQueries !== undefined) return { matches: opts.nativeQueries?.imports ?? null };
  const execution = getCompactImportsExecution(source, support);
  if (execution.fallbackReason) {
    recordNativeExecutionOutcome(opts?.report, {
      ...(opts?.file ? { file: opts.file } : {}),
      support,
      results: null,
      fallbackReason: execution.fallbackReason,
      ...(execution.error ? { error: execution.error } : {}),
    });
  }
  return { matches: execution.results?.imports ?? null };
}

export function collectModuleSpecifiersFromSource(
  support: LanguageSupport,
  source: string,
  opts?: CollectModuleSpecifiersOptions,
): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];

  const htmlLikeLanguage = isHtmlLikeLanguage(support.id, opts?.file);
  if (isGraphOnlyLanguage(support.id)) return extractGraphOnlyModuleSpecifiers(support.id, source);
  if (Buffer.byteLength(source, "utf8") > DEFAULT_NATIVE_SOURCE_MAX_BYTES) {
    recordNativeExecutionOutcome(opts?.report, {
      ...(opts?.file ? { file: opts.file } : {}),
      support,
      results: null,
      fallbackReason: "sourceTooLarge",
    });
    return [];
  }

  const nativeImportsArray = resolveNativeImportMatches(support, source, opts).matches;
  if (!nativeImportsArray) return [];
  const nativeImportsToProcess = htmlLikeLanguage ? [] : nativeImportsArray;
  const isPythonTypeOnly = support.id === "python" ? pythonTypeCheckingContext(source) : undefined;

  // PHP also resolves qualified usages directly from the native syntax tree.
  if (support.id === "php") {
    const phpTree =
      opts?.tree ??
      (() => {
        const nativeTreeExecution = getNativeSyntaxTreeExecution(source, support);
        return nativeTreeExecution.tree ? new ProjectedSyntaxTree(source, nativeTreeExecution.tree) : null;
      })();
    if (phpTree) {
      const qualifiedSpecifiers = extractPhpQualifiedSpecifiersFromTree(source, phpTree);
      if (qualifiedSpecifiers.length) out.push(...qualifiedSpecifiers);
    }
  }

  if (nativeImportsArray) {
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
        let typeOnly =
          support.id === "ts" || support.id === "tsx"
            ? isJsTsTypeOnlySpecifierStatement(stmtText)
            : support.isTypeOnly(stmtText);
        if (!typeOnly && isPythonTypeOnly) {
          const statement = capMap["stmt"];
          if (statement) typeOnly = isPythonTypeOnly(nativeCaptureStartIndex(source, statement));
        }
        if (support.id === "kotlin") {
          const parsed = parseKotlinImportStatement(stmtText);
          if (parsed) {
            out.push({
              spec: parsed.from,
              typeOnly: false,
              ...(parsed.kind === "star" ? { jvmPackageWildcard: true } : {}),
            });
          }
          continue;
        }
        if (support.id === "rust") {
          const statement = capMap["stmt"];
          const statementStartIndex = statement ? nativeCaptureStartIndex(source, statement) : undefined;
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
        const javaImport =
          support.id === "java"
            ? parseJavaImportStatement(maskImportBindingTrivia(stmtText, "java").replace(/\s*\.\s*/gu, "."))
            : null;
        const methodText = match.captures.find((capture) => capture.name === "method")?.text;
        const rubyLoadForm = support.id === "ruby" && isRubyLoadForm(methodText) ? methodText : undefined;
        for (const capture of match.captures) {
          if (capture.name !== "from") continue;
          const includeForm = isCFamily ? cFamilyImportFormFromText(stmtText, capture.text) : undefined;
          out.push({
            spec: unquote(capture.text),
            typeOnly,
            ...(javaImport?.kind === "star" && !javaImport.isStatic ? { jvmPackageWildcard: true } : {}),
            ...(stylesheetImport ? { resolutionKind: "stylesheet" } : {}),
            ...(exportCondition ? { exportCondition } : {}),
            ...(includeForm ? { includeForm } : {}),
            ...(rubyLoadForm ? { rubyLoadForm } : {}),
          });
        }
      }
      if (htmlLikeLanguage) {
        const htmlSeen = makeSeenSet(out);
        appendUniqueSpecifiers(out, extractHtmlAttributeSpecifiers(source), htmlSeen);
        appendUniqueSpecifiers(out, extractHtmlInlineScriptSpecifiers(source), htmlSeen);
        appendUniqueSpecifiers(out, extractHtmlStyleSpecifiers(source), htmlSeen);
      }
      if (support.id === "css" || support.id === "scss" || support.id === "less") {
        const cssSeen = makeSeenSet(out);
        appendUniqueSpecifiers(out, extractCssImportSpecifiers(source), cssSeen);
        appendUniqueSpecifiers(out, extractCssModuleSpecifiers(source), cssSeen);
        appendUniqueSpecifiers(out, extractCssUrlSpecifiers(source), cssSeen);
      }
      appendTripleSlashReferencesForTs(support, source, out);
      return normalizeModuleSpecifiers(out);
    } catch (error) {
      recordNativeExecutionOutcome(opts?.report, {
        ...(opts?.file ? { file: opts.file } : {}),
        support,
        results: null,
        fallbackReason: "queryFailure",
        error: errorMessage(error),
      });
      return [];
    }
  }
  return normalizeModuleSpecifiers(out);
}
