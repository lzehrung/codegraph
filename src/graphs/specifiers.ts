import { type LanguageSupport } from "../languages.js";
import { collectCsharpImportDirectives, csharpUsingDirective } from "../util/csharp-tree.js";
import { collectJvmImportDirectives } from "../util/jvm-tree.js";
import { isJvmLanguage, parseSyntaxTree, readsSyntaxTree } from "../util/syntax-tree.js";
import { recordNativeExecutionOutcome, recordParserBackendDegradation } from "../native/native-backend-report.js";
import { errorMessage } from "../util/errors.js";
import { DEFAULT_NATIVE_SOURCE_MAX_BYTES } from "../native/source-limits.js";
import {
  getCompactImportsExecution,
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
import { unquote } from "../util/ast.js";
import { utf8ByteOffsetToStringIndex } from "../util/rust-test-modules.js";
import { extractDynamicImportSpecifiers, type ModuleSpecifier } from "../util/specifiers.js";
import { appendUniqueSpecifiers, makeSeenSet } from "./specifiers/collection-utils.js";
import { specifierExtractionPolicyFor } from "./specifiers/language-specifiers.js";

import type { CollectModuleSpecifiersOptions } from "./specifiers/types.js";

const HTML_LIKE_LANGUAGE_IDS = new Set(["html", "vue", "svelte"]);

function isHtmlLikeLanguage(languageId: string, filePath?: string): boolean {
  if (HTML_LIKE_LANGUAGE_IDS.has(languageId)) return true;
  return !!filePath && filePath.toLowerCase().endsWith(".astro");
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

function nativeCaptureStartIndex(source: string, capture: CompactCapture | NativeCapture): number {
  return utf8ByteOffsetToStringIndex(source, "startIndex" in capture ? capture.startIndex : capture.start.index);
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

  const jvmLanguageId = isJvmLanguage(support.id) ? support.id : undefined;
  if (readsSyntaxTree(support.id)) {
    let tree = opts?.tree;
    if (!tree) {
      const parsed = parseSyntaxTree(source, support);
      if (!parsed.tree) {
        if (opts?.file) {
          recordParserBackendDegradation(opts.report, {
            file: opts.file,
            languageId: support.id,
            ...(parsed.fallbackReason ? { nativeFallbackReason: parsed.fallbackReason } : {}),
            ...(parsed.error ? { nativeError: parsed.error } : {}),
          });
        }
        return [];
      }
      tree = parsed.tree;
    }
    if (jvmLanguageId) {
      for (const directive of collectJvmImportDirectives(tree, jvmLanguageId)) {
        // The edge resolves what the binding resolves, so a static member import names the file of its owner type. The
        // import as written stays in `raw`, which names the edge when no file is proven.
        const spec = directive.from || directive.name;
        const jvmPackageWildcard = directive.wildcard && !directive.isStatic;
        out.push({
          spec,
          ...(spec !== directive.name ? { raw: directive.name } : {}),
          typeOnly: false,
          ...(jvmPackageWildcard ? { jvmPackageWildcard } : {}),
        });
      }
    } else {
      for (const directive of collectCsharpImportDirectives(tree)) {
        const parsed = csharpUsingDirective(directive);
        if (parsed) out.push({ spec: parsed.value, typeOnly: false });
      }
    }
    return normalizeModuleSpecifiers(out);
  }
  const nativeImportsArray = resolveNativeImportMatches(support, source, opts).matches;
  if (!nativeImportsArray) return [];
  const nativeImportsToProcess = htmlLikeLanguage ? [] : nativeImportsArray;
  const collection = specifierExtractionPolicyFor(support.id).collect;
  const statementTypeOnly = collection?.statementTypeOnly ?? support.isTypeOnly;
  const statementTypeOnlyAt = collection?.statementTypeOnlyAt?.(source);
  const handleStatement = collection?.statement;
  const statementNeedsStartIndex = collection?.statementNeedsStartIndex;
  const resolutionKind = collection?.resolutionKind;
  const exportConditionPattern = collection?.exportCondition?.pattern;
  const statementExportCondition = collection?.exportCondition?.condition;
  const captureIncludeForm = collection?.includeForm;
  const methodLoadForm = collection?.loadForm;
  collection?.prependSpecifiers?.(support, source, opts, out);

  if (nativeImportsArray) {
    try {
      for (const match of nativeImportsToProcess) {
        const capMap = Object.fromEntries(match.captures.map((capture) => [capture.name, capture] as const)) as Record<
          string,
          CompactCapture | NativeCapture | undefined
        >;
        const stmtText = capMap["stmt"]?.text ?? "";
        let typeOnly = statementTypeOnly(stmtText);
        if (!typeOnly && statementTypeOnlyAt) {
          const statement = capMap["stmt"];
          if (statement) typeOnly = statementTypeOnlyAt(nativeCaptureStartIndex(source, statement));
        }
        if (handleStatement) {
          const statement = capMap["stmt"];
          const startIndex =
            statementNeedsStartIndex && statement ? nativeCaptureStartIndex(source, statement) : undefined;
          if (handleStatement(stmtText, source, opts?.file, startIndex, out)) continue;
        }
        const exportCondition = exportConditionPattern?.test(stmtText) ? statementExportCondition : undefined;
        const methodText = match.captures.find((capture) => capture.name === "method")?.text;
        const rubyLoadForm = methodLoadForm?.(methodText);
        for (const capture of match.captures) {
          if (capture.name !== "from") continue;
          const includeForm = captureIncludeForm?.(stmtText, capture.text);
          out.push({
            spec: unquote(capture.text),
            typeOnly,
            ...(resolutionKind ? { resolutionKind } : {}),
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
      collection?.appendSpecifiers?.(support, source, opts, out);
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

function appendMissingSpecifiers(target: ModuleSpecifier[], incoming: readonly ModuleSpecifier[]): void {
  if (!incoming.length) return;
  const existing = new Set(target.map((entry) => entry.spec));
  for (const entry of incoming) {
    if (existing.has(entry.spec)) continue;
    existing.add(entry.spec);
    target.push(entry);
  }
}

/**
 * The specifiers a file's dependency edges resolve: the module specifiers of `source`, then, with
 * `dynamicImportHeuristics`, each specifier the dynamic import heuristics add that the file does not already name.
 */
export function collectEdgeModuleSpecifiers(
  support: LanguageSupport,
  source: string,
  opts: CollectModuleSpecifiersOptions & { file: string; projectRoot: string; dynamicImportHeuristics: boolean },
): ModuleSpecifier[] {
  const specifiers = collectModuleSpecifiersFromSource(support, source, opts);
  if (opts.dynamicImportHeuristics) {
    appendMissingSpecifiers(
      specifiers,
      extractDynamicImportSpecifiers(support.id, source, opts.file, opts.projectRoot),
    );
  }
  return specifiers;
}
