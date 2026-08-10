import { type LanguageSupport } from "../languages.js";
import {
  parseCsharpUsingDirective,
  parseKotlinImportStatement,
  parsePhpImportStatement,
  parseRustImportStatement,
  type ParsedRustImportStatement,
} from "../languages/importStatementParsers.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { logWithLevel, type LogLevel } from "../logging.js";
import { ProjectedSyntaxTree } from "../native/projectedTree.js";
import {
  getCompactImportsExecution,
  getNativeSyntaxTreeExecution,
  isNativeQueryAuthoritative,
  supportsReducedModeRegexRecovery,
  type CompactCapture,
  type CompactQueryResults,
  type NativeCapture,
  type NativeQueryResults,
  type NativeRuntimeMode,
} from "../native/treeSitterNative.js";
import {
  extractGraphOnlyModuleSpecifiers,
  extractHtmlAttributeSpecifiers,
  extractHtmlInlineScriptSpecifiers,
  isGraphOnlyLanguage,
} from "../documentLinks.js";
import { sliceText, unquote } from "../util/ast.js";
import { isRustCfgTestStatement, utf8ByteOffsetToStringIndex } from "../util/rustTestModules.js";
import { extractJsTsSpecifiers, extractPythonSpecifiers, type ModuleSpecifier } from "../util/specifiers.js";

export type FallbackImportExtractionReason = "fast" | "reduced-mode" | "query-error" | "query-empty";

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

function rustSpecifierFromParsedImport(parsed: ParsedRustImportStatement): ModuleSpecifier {
  if (parsed.kind !== "member") {
    return { spec: parsed.from, typeOnly: false };
  }
  const root = parsed.from.split("::", 1)[0] ?? "";
  if (root === "crate" || root === "self" || root === "super") {
    return { spec: parsed.from, raw: `${parsed.from}::${parsed.imported}`, typeOnly: false };
  }
  return { spec: parsed.from, typeOnly: false };
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
          ...(entry.dropIfUnresolved ? { dropIfUnresolved: true } : {}),
          ...(entry.resolved ? { resolved: entry.resolved } : {}),
          ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
        },
  );
}

function appendUniqueSpecifiers(target: ModuleSpecifier[], incoming: ModuleSpecifier[], seen: Set<string>): void {
  for (const entry of incoming) {
    const key = `${entry.spec}::${entry.typeOnly ? 1 : 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(entry);
  }
}

function makeSeenSet(target: ModuleSpecifier[]): Set<string> {
  return new Set(target.map((entry) => `${entry.spec}::${entry.typeOnly ? 1 : 0}`));
}

function nativeCaptureStartIndex(
  source: string,
  capture: CompactCapture | NativeCapture | undefined,
): number | undefined {
  if (capture === undefined || !("start" in capture)) return undefined;
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
// the native query ran — apply it on every TS/TSX exit path (fast-mode regex
// recovery, the native-query happy path, and the query-unavailable/query-error
// regex-recovery fallback), not just the native-query path.
function appendTripleSlashReferencesForTs(support: LanguageSupport, source: string, out: ModuleSpecifier[]): void {
  if (support.id !== "ts" && support.id !== "tsx") return;
  appendUniqueSpecifiers(out, extractTripleSlashReferenceSpecifiers(source), makeSeenSet(out));
}

function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\r\n]/g, " "));
}

function extractCssImportSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  const cleaned = stripCssComments(source);
  const re = /(?:^|[;{}])\s*@(import|use|forward)\s+(?:url\()?["']([^"']+)["']/gim;
  for (const match of cleaned.matchAll(re)) {
    const spec = (match[2] ?? "").trim();
    if (!spec) continue;
    out.push({ spec, typeOnly: false });
  }
  return out;
}

export function collectModuleSpecifiersFromSource(
  support: LanguageSupport,
  _lang: unknown,
  source: string,
  opts?: CollectModuleSpecifiersOptions,
): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];

  const supportsRegexImportRecovery = supportsReducedModeRegexRecovery(support.id);
  const htmlLikeLanguage = isHtmlLikeLanguage(support.id, opts?.file);
  const graphOnlyLanguage = isGraphOnlyLanguage(support.id);
  const fastRegexDisabled = opts?.fastRegexDisabledLanguages?.includes(support.id);
  if (graphOnlyLanguage) {
    return extractGraphOnlyModuleSpecifiers(support.id, source);
  }

  const shouldAttemptFallback =
    support.id === "python" ? /\b(import|from)\b/.test(source) : /\b(import|require|from)\b/.test(source);
  const reportFallback = (reason: FallbackImportExtractionReason) => {
    const event: FallbackImportExtractionEvent = {
      language: support.id,
      reason,
      ...(opts?.file ? { file: opts.file } : {}),
    };
    opts?.onFallbackImportExtraction?.(event);
  };
  const resolvedNativeImports =
    opts?.compactNativeImports?.imports ??
    opts?.nativeQueries?.imports ??
    getCompactImportsExecution(source, support, opts?.native).results?.imports ??
    null;

  if (support.id === "python") {
    let queryFailed = false;
    if (resolvedNativeImports !== null) {
      try {
        for (const match of resolvedNativeImports) {
          const stmtText =
            match.captures.find((capture) => capture.name === "stmt")?.text ?? match.captures[0]?.text ?? "";
          if (!stmtText) continue;
          const mImport = /^\s*import\s+([^\n#]+)/.exec(stmtText);
          if (mImport) {
            const list = (mImport[1] ?? "")
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean);
            for (const spec of list) {
              const parsed = spec.match(/^([A-Za-z_][\w.]*)(?:\s+as\s+[A-Za-z_][\w_]*)?$/);
              if (parsed?.[1]) out.push({ spec: parsed[1] });
            }
            continue;
          }
          const mFrom = /^\s*from\s+(\.*)([A-Za-z_][\w.]*)?\s+import\b/.exec(stmtText);
          if (mFrom) {
            const dots = mFrom[1] ?? "";
            const name = mFrom[2] ?? "";
            const mod = `${dots}${name}`;
            if (mod) out.push({ spec: mod });
          }
        }
      } catch {
        queryFailed = true;
        out.length = 0;
      }
    }
    if ((queryFailed || !out.length) && shouldAttemptFallback) {
      const extracted = extractPythonSpecifiers(source);
      if (extracted.length) {
        reportFallback(queryFailed ? "query-error" : "query-empty");
        for (const spec of extracted) out.push({ spec });
      }
    }
    if (out.length || resolvedNativeImports !== null || queryFailed) {
      return normalizeModuleSpecifiers(out);
    }
  }

  if (support.id === "php") {
    let queryFailed = false;
    const phpMatches = resolvedNativeImports;
    if (phpMatches) {
      try {
        for (const match of phpMatches) {
          const stmtText =
            match.captures.find((capture) => capture.name === "stmt")?.text ?? match.captures[0]?.text ?? "";
          if (!stmtText) continue;
          for (const parsed of parsePhpImportStatement(stmtText, opts?.file)) {
            out.push({
              spec: parsed.from,
              typeOnly: false,
              ...(parsed.kind === "named" ? { phpImportType: parsed.importType } : {}),
            });
          }
        }
      } catch {
        queryFailed = true;
        out.length = 0;
      }
    }
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
    if (out.length || phpMatches !== null || queryFailed) {
      return normalizeModuleSpecifiers(out);
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

  let queryFailed = false;
  if (hasNativeImports) {
    try {
      for (const match of nativeImportsArray) {
        const capMap = Object.fromEntries(match.captures.map((capture) => [capture.name, capture] as const)) as Record<
          string,
          CompactCapture | NativeCapture | undefined
        >;
        const stmtText = capMap["stmt"]?.text ?? "";
        const typeOnly =
          (support.id === "ts" || support.id === "tsx") &&
          (/\b(import|export)\s+type\b/.test(stmtText) || /^\s*declare\s+module\s+["']/.test(stmtText));
        if (support.id === "kotlin") {
          const parsed = parseKotlinImportStatement(stmtText);
          if (parsed) out.push({ spec: parsed.from, typeOnly: false });
          continue;
        }
        if (support.id === "rust") {
          const statementStartIndex = nativeCaptureStartIndex(source, capMap["stmt"]);
          if (isRustCfgTestStatement(source, stmtText, statementStartIndex)) continue;
          const parsed = parseRustImportStatement(stmtText);
          if (parsed) {
            out.push(rustSpecifierFromParsedImport(parsed));
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
        for (const capture of match.captures) {
          if (capture.name !== "mod") continue;
          out.push({ spec: unquote(capture.text), typeOnly });
        }
      }
      if (htmlLikeLanguage) {
        const beforeHtmlRecovery = out.length;
        const htmlSeen = makeSeenSet(out);
        appendUniqueSpecifiers(out, extractHtmlAttributeSpecifiers(source), htmlSeen);
        appendUniqueSpecifiers(out, extractHtmlInlineScriptSpecifiers(source), htmlSeen);
        if (!beforeHtmlRecovery && out.length) {
          reportFallback("query-empty");
        }
      }
      if (support.id === "css" || support.id === "scss" || support.id === "less") {
        const beforeCssRecovery = out.length;
        const cssSeen = makeSeenSet(out);
        appendUniqueSpecifiers(out, extractCssUrlSpecifiers(source), cssSeen);
        if (!beforeCssRecovery && out.length) {
          reportFallback("query-empty");
        }
      }
      appendTripleSlashReferencesForTs(support, source, out);
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
          let reason: FallbackImportExtractionReason = "reduced-mode";
          if (queryFailed) {
            reason = "query-error";
          } else if (hasNativeImports) {
            reason = "query-empty";
          }
          reportFallback(reason);
          out.push(...extracted);
        }
      } catch {
        // ignore
      }
    }
    appendTripleSlashReferencesForTs(support, source, out);
    return normalizeModuleSpecifiers(out);
  }

  let reducedRecoveryReason: FallbackImportExtractionReason = "reduced-mode";
  if (queryFailed) {
    reducedRecoveryReason = "query-error";
  } else if (hasNativeImports) {
    reducedRecoveryReason = "query-empty";
  }
  if (htmlLikeLanguage && !out.length) {
    const beforeRecovery = out.length;
    const attributeSpecs = extractHtmlAttributeSpecifiers(source);
    const inlineSpecs = extractHtmlInlineScriptSpecifiers(source);
    if (attributeSpecs.length || inlineSpecs.length) {
      const fallbackSeen = makeSeenSet(out);
      appendUniqueSpecifiers(out, attributeSpecs, fallbackSeen);
      appendUniqueSpecifiers(out, inlineSpecs, fallbackSeen);
    }
    if (out.length > beforeRecovery) {
      reportFallback(reducedRecoveryReason);
    }
  }
  if (support.id === "css" || support.id === "scss" || support.id === "less") {
    const beforeRecovery = out.length;
    const cssSeen = makeSeenSet(out);
    appendUniqueSpecifiers(out, extractCssImportSpecifiers(source), cssSeen);
    appendUniqueSpecifiers(out, extractCssUrlSpecifiers(source), cssSeen);
    if (out.length > beforeRecovery) {
      reportFallback(reducedRecoveryReason);
    }
  }
  return normalizeModuleSpecifiers(out);
}
