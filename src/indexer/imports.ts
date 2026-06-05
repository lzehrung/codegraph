import {
  isJsFallbackAvailable,
  isJsFallbackUnavailableError,
  parseWithJsLanguage,
  type JsSyntaxTree,
} from "../jsFallback.js";
import { prepareSourceInput } from "../languages/filePrep.js";
import { loadNearestTsconfigFor, resolveImportSpecifier } from "../util/resolution.js";
import { loadWorkspaceConfig } from "../util/workspace.js";
import { logWithLevel, type LogLevel } from "../logging.js";
import { type FallbackImportExtractionEvent, type FallbackImportExtractionReason } from "../graphs/specifiers.js";
import type { GraphBuildOptions } from "../graphs/types.js";
import { isGraphOnlyLanguage } from "../documentLinks.js";
import {
  executeJsQueryAsNativeMatches,
  isNativeQueryAuthoritative,
  isNativeRequiredUnavailableError,
  shouldAvoidJsFallbackForLanguage,
  type NativeQueryResults,
} from "../native/treeSitterNative.js";
import type { ResolvedImportTarget } from "./imports/context.js";
import { collectGraphOnlyImports } from "./imports/graphOnly.js";
import { collectJsTextImports } from "./imports/jsFallback.js";
import {
  applyStatementImportOverride,
  createStatementImportOverrideState,
  finalizeLanguageSpecificImports,
} from "./imports/languageSpecific.js";
import { collectJsQueryCaptureImportBindings, collectNativeCaptureImportBindings } from "./imports/nativeCaptures.js";
import { collectPythonImportsFromSource } from "./imports/python.js";
import type { LanguageSupport } from "../languages.js";
import type { JsLanguage } from "../languages/types.js";
import type { ImportBinding } from "./types.js";

export async function collectImportsForFile(
  file: string,
  projectRoot: string,
  opts?: {
    source?: string;
    tree?: JsSyntaxTree;
    sup?: LanguageSupport;
    lang?: JsLanguage;
    nativeQueries?: NativeQueryResults | null;
    graphOptions?: GraphBuildOptions;
    onFallbackImportExtraction?: (event: FallbackImportExtractionEvent) => void;
    logLevel?: LogLevel;
  },
): Promise<ImportBinding[]> {
  let source = opts?.source;
  let sup = opts?.sup;
  const lang = opts?.lang;

  if (!source || !sup) {
    const prep = await prepareSourceInput(file, source !== undefined ? { source } : undefined);
    source = prep.source;
    sup = prep.sup;
  }

  const resolvedSource = source;
  const resolvedSup = sup;
  let resolvedLang = lang;
  if (isGraphOnlyLanguage(resolvedSup.id)) {
    return await collectGraphOnlyImports({
      file,
      projectRoot,
      source: resolvedSource,
      languageId: resolvedSup.id,
      ...(opts?.graphOptions ? { graphOptions: opts.graphOptions } : {}),
      ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
    });
  }

  const resolvedNativeQueries = opts?.nativeQueries ?? null;
  const ensureResolvedLang = (): JsLanguage => {
    resolvedLang ??= resolvedSup.language(file);
    return resolvedLang;
  };

  const imports: ImportBinding[] = [];
  const reportFallback = (reason: FallbackImportExtractionReason) => {
    opts?.onFallbackImportExtraction?.({
      file: file.replace(/\\/g, "/"),
      language: resolvedSup.id,
      reason,
    });
  };

  if (resolvedSup.id === "python") {
    await collectPythonImportsFromSource({
      file,
      projectRoot,
      source: resolvedSource,
      pushBinding: (binding) => imports.push(binding),
    });
    return imports;
  }

  const tsCfg =
    resolvedSup.id === "ts" || resolvedSup.id === "tsx"
      ? await loadNearestTsconfigFor(file, opts?.logLevel)
      : undefined;
  const workspaceConfig = await loadWorkspaceConfig(projectRoot);
  const resolvedImportCache = new Map<string, Promise<ResolvedImportTarget>>();

  const resolveFrom = async (
    from: string,
    phpImportType?: "class" | "function" | "const",
  ): Promise<ResolvedImportTarget> => {
    const cacheKey = `${from}\0${phpImportType ?? ""}`;
    const cached = resolvedImportCache.get(cacheKey);
    if (cached) return await cached;
    const resolutionHints = opts?.graphOptions?.resolutionHints;
    const resolved = (async (): Promise<ResolvedImportTarget> => {
      const result = await resolveImportSpecifier(projectRoot, file, from, resolvedSup.id, {
        ...(tsCfg?.matchPath ? { matchPath: tsCfg.matchPath } : {}),
        ...(workspaceConfig ? { workspaceConfig } : {}),
        resolveNodeModules: !!opts?.graphOptions?.resolveNodeModules,
        ...(resolutionHints ? { resolutionHints } : {}),
        ...(phpImportType ? { phpImportType } : {}),
      });
      return typeof result === "string" ? result.replace(/\\/g, "/") : result;
    })();
    resolvedImportCache.set(cacheKey, resolved);
    return await resolved;
  };
  const languageContext = {
    file,
    projectRoot,
    source: resolvedSource,
    languageId: resolvedSup.id,
    resolveFrom,
    pushBinding: (binding: ImportBinding) => imports.push(binding),
    getBindings: () => imports,
    replaceBindings: (bindings: ImportBinding[]) => imports.splice(0, imports.length, ...bindings),
  };
  const statementOverrideState = createStatementImportOverrideState();

  const finalizeImports = async (): Promise<void> => {
    await finalizeLanguageSpecificImports(languageContext);
  };

  const applyStatementOverride = async (stmtText: string, typeOnly: boolean): Promise<boolean> => {
    return await applyStatementImportOverride(languageContext, statementOverrideState, stmtText, typeOnly);
  };

  const runFallback = async () => {
    await collectJsTextImports({
      source: resolvedSource,
      languageId: resolvedSup.id,
      resolveFrom,
      pushBinding: (binding) => imports.push(binding),
    });
  };

  const shouldUseTextImportRecoveryOnly = shouldAvoidJsFallbackForLanguage(resolvedSup.id);
  const hasPotentialTextImportRecovery =
    shouldUseTextImportRecoveryOnly && /\b(import|require|from)\b/.test(resolvedSource);

  if (shouldUseTextImportRecoveryOnly) {
    const importCountBeforeFallback = imports.length;
    if (hasPotentialTextImportRecovery) {
      await runFallback();
    }
    await finalizeImports();
    if (imports.length > importCountBeforeFallback && !isJsFallbackAvailable()) {
      reportFallback("js-fallback-unavailable");
    }
    return imports;
  }

  if (resolvedNativeQueries) {
    try {
      await collectNativeCaptureImportBindings(
        {
          source: resolvedSource,
          languageId: resolvedSup.id,
          isTypeOnly: (stmtText) => resolvedSup.isTypeOnly(stmtText),
          resolveFrom,
          pushBinding: (binding) => imports.push(binding),
          languageContext,
          applyStatementOverride,
        },
        resolvedNativeQueries.importBindings,
      );
      await finalizeImports();
      // Native succeeded -- treat the result as authoritative even if empty,
      // but only when the importBindings query was not modified by
      // normalization. Languages whose importBindings query is normalized
      // or blanked (e.g. Kotlin) may need the JS/text fallback.
      if (imports.length || isNativeQueryAuthoritative(resolvedSup, "importBindings")) {
        return imports;
      }
    } catch {
      imports.length = 0;
    }
  }

  try {
    let tree: JsSyntaxTree;
    try {
      tree = opts?.tree ?? parseWithJsLanguage(resolvedSource, ensureResolvedLang());
    } catch (error) {
      if (isNativeRequiredUnavailableError(error)) throw error;
      if (isJsFallbackUnavailableError(error)) {
        reportFallback("js-fallback-unavailable");
        logWithLevel(
          opts?.logLevel,
          "debug",
          `JS fallback unavailable for ${resolvedSup.id} import-binding recovery; using regex import extraction.`,
        );
        await runFallback();
        await finalizeImports();
        return imports;
      }
      throw error;
    }
    let ranFallback = false;
    try {
      const matches = executeJsQueryAsNativeMatches(
        resolvedSource,
        resolvedSup,
        ensureResolvedLang(),
        resolvedSup.queries.importBindings,
        tree,
      );
      await collectJsQueryCaptureImportBindings(
        {
          source: resolvedSource,
          languageId: resolvedSup.id,
          isTypeOnly: (stmtText) => resolvedSup.isTypeOnly(stmtText),
          resolveFrom,
          pushBinding: (binding) => imports.push(binding),
          languageContext,
          applyStatementOverride,
        },
        matches,
        tree,
      );
    } catch (error) {
      if (isNativeRequiredUnavailableError(error)) throw error;
      if (isJsFallbackUnavailableError(error)) {
        reportFallback("js-fallback-unavailable");
      }
      await runFallback();
      ranFallback = true;
    }
    await finalizeImports();
    // Only run fallback when query path produced no results
    if (!ranFallback && !imports.length) {
      await runFallback();
      await finalizeImports();
    }
    return imports;
  } finally {
    // No parser cleanup required: JS fallback parsing is delegated to
    // the optional JS fallback loader bridge.
  }
}
