import {
  isJsFallbackAvailable,
  isJsFallbackUnavailableError,
  isJsSyntaxTree,
  parseWithJsLanguage,
  type JsLanguage,
} from "../jsFallback.js";
import { type LanguageSupport } from "../languages.js";
import {
  parseCsharpUsingDirective,
  parsePhpImportStatement,
  parseRustImportStatement,
} from "../languages/importStatementParsers.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { logWithLevel, type LogLevel } from "../logging.js";
import { ProjectedSyntaxTree } from "../native/projectedTree.js";
import {
  executeJsQueryAsNativeMatches,
  getCompactImportsExecution,
  getNativeSyntaxTreeExecution,
  isNativeBindingLoadedForLanguage,
  isNativeQueryAuthoritative,
  shouldAvoidJsFallbackForLanguage,
  type CompactQueryResults,
  type NativeQueryResults,
  type NativeRuntimeMode,
} from "../native/treeSitterNative.js";
import {
  extractGraphOnlyModuleSpecifiers,
  extractHtmlAttributeSpecifiers,
  extractHtmlInlineScriptSpecifiers,
  isGraphOnlyLanguage,
} from "../documentLinks.js";
import { sliceText, unquote, extractJsTsSpecifiers, extractPythonSpecifiers, type ModuleSpecifier } from "../util.js";

export type FallbackImportExtractionReason = "fast" | "js-fallback-unavailable" | "query-error" | "query-empty";

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

function extractKotlinImportSpecifier(statementText: string): string | null {
  const match = statementText.match(/^\s*import\s+([A-Za-z_][\w.]*(?:\.\*)?)(?:\s+as\s+[A-Za-z_][\w]*)?\s*$/m);
  if (!match?.[1]) return null;
  return match[1].endsWith(".*") ? match[1].slice(0, -2) : match[1];
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

export function collectModuleSpecifiersFromSource(
  support: LanguageSupport,
  lang: JsLanguage | undefined,
  source: string,
  opts?: CollectModuleSpecifiersOptions,
): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  const supportsRegexImportRecovery = shouldAvoidJsFallbackForLanguage(support.id);
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
  const ensureResolvedLang = (): JsLanguage => {
    if (!lang) {
      const fileForLanguage = opts?.file ?? `temp.${support.matchExts[0]?.replace(/^\./, "") ?? "txt"}`;
      lang = support.language(fileForLanguage);
    }
    return lang;
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
    if ((queryFailed || out.length === 0) && shouldAttemptFallback) {
      const extracted = extractPythonSpecifiers(source);
      if (extracted.length > 0) {
        reportFallback(queryFailed ? "query-error" : "query-empty");
        for (const spec of extracted) out.push({ spec });
      }
    }
    if (out.length > 0 || resolvedNativeImports !== null || queryFailed) {
      return normalizeModuleSpecifiers(out);
    }
  }

  if (support.id === "php") {
    let queryFailed = false;
    const phpMatches =
      resolvedNativeImports ??
      (() => {
        try {
          const jsQueryTree = opts?.tree && isJsSyntaxTree(opts.tree) ? opts.tree : undefined;
          return executeJsQueryAsNativeMatches(
            source,
            support,
            ensureResolvedLang(),
            support.queries.imports,
            jsQueryTree,
          );
        } catch {
          queryFailed = true;
          return null;
        }
      })();
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
      })() ??
      (() => {
        try {
          return parseWithJsLanguage(source, ensureResolvedLang());
        } catch {
          return null;
        }
      })();
    if (phpTree) {
      const qualifiedSpecifiers = extractPhpQualifiedSpecifiersFromTree(source, phpTree);
      if (qualifiedSpecifiers.length > 0) out.push(...qualifiedSpecifiers);
    }
    if (out.length > 0 || phpMatches !== null || queryFailed) {
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
    return normalizeModuleSpecifiers(out);
  }

  const nativeImportsArray = resolvedNativeImports;
  const hasNativeImports = !!nativeImportsArray;

  let queryFailed = false;
  let fallbackReasonOverride: FallbackImportExtractionReason | undefined;
  if (hasNativeImports) {
    try {
      for (const match of nativeImportsArray) {
        const capMap = Object.fromEntries(match.captures.map((capture) => [capture.name, capture] as const));
        const stmtText = capMap["stmt"]?.text ?? "";
        const typeOnly =
          (support.id === "ts" || support.id === "tsx") &&
          (/\b(import|export)\s+type\b/.test(stmtText) || /^\s*declare\s+module\s+["']/.test(stmtText));
        if (support.id === "kotlin") {
          const spec = extractKotlinImportSpecifier(stmtText);
          if (spec) out.push({ spec, typeOnly: false });
          continue;
        }
        if (support.id === "rust") {
          const parsed = parseRustImportStatement(stmtText);
          if (parsed) {
            out.push({ spec: parsed.from, typeOnly: false });
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
        const htmlSeen = makeSeenSet(out);
        appendUniqueSpecifiers(out, extractHtmlAttributeSpecifiers(source), htmlSeen);
        appendUniqueSpecifiers(out, extractHtmlInlineScriptSpecifiers(source), htmlSeen);
      }
      if (support.id === "css" || support.id === "scss" || support.id === "less") {
        const cssSeen = makeSeenSet(out);
        appendUniqueSpecifiers(out, extractCssUrlSpecifiers(source), cssSeen);
      }
      if (out.length > 0 || isNativeQueryAuthoritative(support, "imports")) {
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
    if (!isJsFallbackAvailable()) {
      fallbackReasonOverride = "js-fallback-unavailable";
    }
    if ((queryFailed || out.length === 0) && shouldAttemptFallback) {
      try {
        const extracted = extractJsTsSpecifiers(source);
        if (extracted.length > 0) {
          reportFallback(fallbackReasonOverride ?? (queryFailed ? "query-error" : "query-empty"));
          out.push(...extracted);
        }
      } catch {
        // ignore
      }
    }
    return normalizeModuleSpecifiers(out);
  }

  if (isNativeBindingLoadedForLanguage(support.id, opts?.native)) {
    return normalizeModuleSpecifiers(out);
  }

  try {
    const jsQueryTree = opts?.tree && isJsSyntaxTree(opts.tree) ? opts.tree : undefined;
    const matches = executeJsQueryAsNativeMatches(
      source,
      support,
      ensureResolvedLang(),
      support.queries.imports,
      jsQueryTree,
    );
    for (const match of matches) {
      const caps = Object.fromEntries(match.captures.map((capture) => [capture.name, capture] as const));
      const modNodes = match.captures.filter((capture) => capture.name === "mod");
      const stmtText = caps["stmt"]?.text ?? "";
      const typeOnly =
        (support.id === "ts" || support.id === "tsx") &&
        (/\b(import|export)\s+type\b/.test(stmtText) || /^\s*declare\s+module\s+["']/.test(stmtText));
      if (support.id === "kotlin") {
        const spec = extractKotlinImportSpecifier(stmtText);
        if (spec) out.push({ spec, typeOnly: false });
        continue;
      }
      if (support.id === "rust") {
        const parsed = parseRustImportStatement(stmtText);
        if (parsed) {
          out.push({ spec: parsed.from, typeOnly: false });
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
      for (const capture of modNodes) {
        out.push({ spec: unquote(capture.text), typeOnly });
      }
    }
    if (htmlLikeLanguage) {
      const htmlSeen = makeSeenSet(out);
      appendUniqueSpecifiers(out, extractHtmlAttributeSpecifiers(source), htmlSeen);
      appendUniqueSpecifiers(out, extractHtmlInlineScriptSpecifiers(source), htmlSeen);
    }
    if (support.id === "css" || support.id === "scss" || support.id === "less") {
      const cssSeen = makeSeenSet(out);
      appendUniqueSpecifiers(out, extractCssUrlSpecifiers(source), cssSeen);
    }
    if (out.length > 0) return normalizeModuleSpecifiers(out);
  } catch (error) {
    if (isJsFallbackUnavailableError(error)) {
      fallbackReasonOverride = "js-fallback-unavailable";
      logWithLevel(
        opts?.logLevel,
        "debug",
        `JS fallback unavailable for ${support.id} query recovery; using regex import extraction.`,
      );
    } else {
      if (!htmlLikeLanguage) {
        logWithLevel(
          opts?.logLevel,
          "warn",
          `Warning: Query error in collectModuleSpecifiersFromSource for ${support.id}:`,
          error,
        );
      }
    }
    queryFailed = true;
  }

  if (supportsRegexImportRecovery && (queryFailed || out.length === 0) && shouldAttemptFallback) {
    try {
      const extracted = extractJsTsSpecifiers(source);
      if (extracted.length > 0) {
        reportFallback(fallbackReasonOverride ?? (queryFailed ? "query-error" : "query-empty"));
        out.push(...extracted);
      }
    } catch {
      // ignore
    }
  }

  if (htmlLikeLanguage && (queryFailed || out.length === 0)) {
    const attributeSpecs = extractHtmlAttributeSpecifiers(source);
    const inlineSpecs = extractHtmlInlineScriptSpecifiers(source);
    if (attributeSpecs.length > 0 || inlineSpecs.length > 0) {
      const fallbackSeen = makeSeenSet(out);
      appendUniqueSpecifiers(out, attributeSpecs, fallbackSeen);
      appendUniqueSpecifiers(out, inlineSpecs, fallbackSeen);
    }
  }
  return normalizeModuleSpecifiers(out);
}
