import { prepareSourceInput } from "../languages/file-prep.js";
import { loadNearestTsconfigFor, type MatchPathFn } from "../util/resolution.js";
import { resolveSpecifierTargets } from "../util/resolution/specifier-targets.js";
import { loadWorkspaceConfig, type WorkspaceConfig } from "../util/workspace.js";
import type { LogLevel } from "../logging.js";
import {
  collectModuleSpecifiersFromSource,
  mapNativeExecutionFallbackReason,
  type FallbackImportExtractionEvent,
  type FallbackImportExtractionReason,
} from "../graphs/specifiers.js";
import type { GraphBuildOptions } from "../graphs/types.js";
import type { LanguageExtensionMap } from "../languages.js";
import { isGraphOnlyLanguage } from "../document-links.js";
import { stripJsLikeComments } from "../util/comments.js";
import {
  assertNativeRequiredAvailable,
  getNativeQueryExecution,
  isNativeBindingLoadedForLanguage,
  isNativeRequiredUnavailableError,
  isNativeQueryAuthoritative,
} from "../native/tree-sitter-native.js";
import type { NativeQueryExecution, NativeQueryResults, NativeRuntimeMode } from "../native/tree-sitter-native.js";
import type { ImportResolverOptions, ResolvedImportTarget } from "./imports/context.js";
import { attributeNamedBindingRanges, maskImportBindingTrivia } from "./imports/binding-ranges.js";
import { IMPORT_BINDING_ROWS } from "./imports/import-binding-tables.js";
import { collectGraphOnlyImports } from "./imports/graph-only.js";
import { collectJsTextImports, collectJsTextValueRequireImports } from "./imports/js-text-imports.js";
import {
  applyStatementImportOverride,
  createStatementImportOverrideState,
  finalizeLanguageSpecificImports,
} from "./imports/language-specific.js";
import { collectNativeCaptureImportBindings } from "./imports/native-captures.js";
import { collectPythonImportsFromNativeMatches, collectPythonImportsFromSource } from "./imports/python.js";
import type { LanguageSupport } from "../languages.js";
import { jvmPackageNameFromSource } from "./compilation-units.js";
import type { ImportBinding } from "./types.js";
import { collectTextImportSpecifiers } from "./imports/text-import-extractors.js";

export async function collectImportsForFile(
  file: string,
  projectRoot: string,
  opts?: {
    source?: string;
    sup?: LanguageSupport;
    nativeQueries?: NativeQueryResults | null;
    graphOptions?: GraphBuildOptions;
    native?: NativeRuntimeMode;
    onFallbackImportExtraction?: (event: FallbackImportExtractionEvent) => void;
    logLevel?: LogLevel;
    languageExtensions?: LanguageExtensionMap;
    workspaceConfig?: WorkspaceConfig;
    matchPath?: MatchPathFn;
  },
): Promise<ImportBinding[]> {
  let source = opts?.source;
  let sup = opts?.sup;

  if (!source || !sup) {
    const prep = await prepareSourceInput(
      file,
      source !== undefined
        ? { source, languageExtensions: opts?.languageExtensions }
        : { languageExtensions: opts?.languageExtensions },
    );
    source = prep.source;
    sup = prep.sup;
  }

  const resolvedSource = source;
  const resolvedSup = sup;

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

  const imports: ImportBinding[] = [];
  const reportFallback = (reason: FallbackImportExtractionReason) => {
    opts?.onFallbackImportExtraction?.({
      file: file.replace(/\\/g, "/"),
      language: resolvedSup.id,
      reason,
    });
  };
  const nativeMode = opts?.native ?? opts?.graphOptions?.native;
  assertNativeRequiredAvailable(nativeMode);
  let nativeExecution: NativeQueryExecution | null = null;
  let resolvedNativeQueries: NativeQueryResults | null = opts?.nativeQueries ?? null;
  if (opts?.nativeQueries === undefined) {
    nativeExecution = getNativeQueryExecution(resolvedSource, resolvedSup, nativeMode);
    resolvedNativeQueries = nativeExecution.results;
  }
  // The graph and binding consumers must agree on why extraction fell back, so both map the
  // native execution reason with the same rule instead of labelling it per call site.
  const nativeExecutionFallbackReason = nativeExecution?.fallbackReason
    ? mapNativeExecutionFallbackReason(
        resolvedSup.id,
        nativeExecution.fallbackReason,
        false,
        resolvedNativeQueries !== null,
      )
    : null;

  if (resolvedSup.id === "python") {
    const context = {
      file,
      projectRoot,
      source: resolvedSource,
      pushBinding: (binding: ImportBinding) => imports.push(binding),
      getBindings: () => imports,
    };
    if (resolvedNativeQueries) {
      await collectPythonImportsFromNativeMatches(context, resolvedNativeQueries.importBindings);
    } else {
      await collectPythonImportsFromSource(context);
      if (nativeExecutionFallbackReason) reportFallback(nativeExecutionFallbackReason);
    }
    return imports;
  }

  let matchPath = opts?.matchPath;
  if ((resolvedSup.id === "ts" || resolvedSup.id === "tsx") && !matchPath) {
    ({ matchPath } = await loadNearestTsconfigFor(file, projectRoot, opts?.logLevel));
  }
  const workspaceConfig = opts?.workspaceConfig ?? (await loadWorkspaceConfig(projectRoot));
  const resolvedImportCache = new Map<string, Promise<ResolvedImportTarget>>();
  const jvmPackageFiles = new Map<string, string[]>();
  let jvmDeclaredPackage: string | null | undefined;

  const stylesheetLanguage = ["css", "scss", "less"].includes(resolvedSup.id);
  const resolveFrom = async (
    from: string,
    phpImportType?: "class" | "function" | "const",
    resolverOpts?: ImportResolverOptions,
  ): Promise<ResolvedImportTarget> => {
    const resolutionKind = resolverOpts?.resolutionKind;
    const includeForm = resolverOpts?.includeForm;
    const rubyLoadForm = resolverOpts?.rubyLoadForm;
    const cacheKey = `${from}\0${phpImportType ?? ""}\0${resolutionKind ?? ""}\0${includeForm ?? ""}\0${rubyLoadForm ?? ""}\0${resolverOpts?.jvmPackageWildcard ? "package" : "symbol"}\0${resolverOpts?.pathAttribute ?? ""}\0${resolverOpts?.statementStartIndex ?? ""}`;
    const cached = resolvedImportCache.get(cacheKey);
    if (cached) return await cached;
    const resolutionHints = opts?.graphOptions?.resolutionHints;
    const resolved = (async (): Promise<ResolvedImportTarget> => {
      const result = await resolveSpecifierTargets(file, from, resolvedSup.id, {
        projectRoot,
        ...(matchPath ? { matchPath } : {}),
        ...(workspaceConfig ? { workspaceConfig } : {}),
        resolveNodeModules: !!opts?.graphOptions?.resolveNodeModules,
        ...(resolutionHints ? { resolutionHints } : {}),
        ...(opts?.languageExtensions ? { languageExtensions: opts.languageExtensions } : {}),
        ...(resolverOpts?.jvmPackageWildcard ? { jvmPackageWildcard: true } : {}),
        ...(phpImportType ? { phpImportType } : {}),
        ...(resolutionKind ? { resolutionKind } : {}),
        ...(includeForm ? { includeForm } : {}),
        ...(rubyLoadForm ? { rubyLoadForm } : {}),
        ...(resolverOpts?.pathAttribute ? { pathAttribute: resolverOpts.pathAttribute } : {}),
        ...(resolverOpts?.statementStartIndex !== undefined
          ? { statementStartIndex: resolverOpts.statementStartIndex }
          : {}),
      });
      if (result.jvmPackageMatched) {
        jvmPackageFiles.set(
          from,
          result.files.map((target) => target.replace(/\\/g, "/")),
        );
      }
      // JVM package files remain on the star binding; C# namespaces retain a representative.
      if (
        result.files.length > 1 &&
        (resolvedSup.id === "java" || resolvedSup.id === "kotlin" || resolvedSup.id === "csharp")
      ) {
        return result.files[0]!.replace(/\\/g, "/");
      }
      const resolvedFile = result.files[0];
      if (result.files.length === 1 && resolvedFile) return resolvedFile.replace(/\\/g, "/");
      return { external: result.externalName };
    })();
    resolvedImportCache.set(cacheKey, resolved);
    return await resolved;
  };
  const languageContext = {
    file,
    projectRoot,
    source: resolvedSource,
    languageId: resolvedSup.id,
    ...(opts?.languageExtensions ? { languageExtensions: opts.languageExtensions } : {}),
    resolveFrom: (from: string, phpImportType?: "class" | "function" | "const", resolverOpts?: ImportResolverOptions) =>
      resolveFrom(from, phpImportType, {
        ...(stylesheetLanguage ? { resolutionKind: "stylesheet" as const } : {}),
        ...resolverOpts,
      }),
    pushBinding: (binding: ImportBinding) => imports.push(binding),
    getBindings: () => imports,
    replaceBindings: (bindings: ImportBinding[]) => imports.splice(0, imports.length, ...bindings),
  };
  const statementOverrideState = createStatementImportOverrideState();

  const finalizeImports = async (): Promise<void> => {
    await finalizeLanguageSpecificImports(languageContext);
    for (const binding of imports) {
      if (binding.kind !== "star" || typeof binding.resolved !== "string") continue;
      const files = jvmPackageFiles.get(binding.from);
      // A static class wildcard can spell the same name as a package wildcard.
      if (
        binding.jvmTypeWildcardName &&
        files?.includes(binding.resolved) &&
        (resolvedSup.id === "java" || resolvedSup.id === "kotlin")
      ) {
        binding.jvmPackageFiles = files;
        binding.jvmPackageLanguageId = resolvedSup.id;
        if (jvmDeclaredPackage === undefined) {
          jvmDeclaredPackage = jvmPackageNameFromSource(resolvedSource, resolvedSup.id);
        }
        if (jvmDeclaredPackage !== null && jvmDeclaredPackage === binding.from) binding.jvmSamePackage = true;
      }
      if (
        binding.jvmTypeWildcardName &&
        !binding.jvmPackageFiles &&
        (resolvedSup.id === "java" || resolvedSup.id === "kotlin")
      ) {
        if (jvmDeclaredPackage === undefined) {
          jvmDeclaredPackage = jvmPackageNameFromSource(resolvedSource, resolvedSup.id);
        }
        const typePackage = binding.from.slice(0, -(binding.jvmTypeWildcardName.length + 1));
        if (jvmDeclaredPackage !== null && jvmDeclaredPackage === typePackage) binding.jvmSamePackage = true;
      }
    }
  };

  const applyStatementOverride = async (
    stmtText: string,
    typeOnly: boolean,
    statementStartIndex?: number,
  ): Promise<boolean> => {
    const bindingCountBefore = imports.length;
    const handled = await applyStatementImportOverride(
      languageContext,
      statementOverrideState,
      stmtText,
      typeOnly,
      statementStartIndex,
    );
    if (handled && statementStartIndex !== undefined) {
      attributeNamedBindingRanges({
        bindings: imports,
        fromIndex: bindingCountBefore,
        text: maskImportBindingTrivia(stmtText, resolvedSup.id),
        textStartIndex: statementStartIndex,
        source: resolvedSource,
        alwaysAliased: IMPORT_BINDING_ROWS[resolvedSup.id]?.alwaysAliased,
      });
    }
    return handled;
  };

  const runFallback = async () => {
    await collectJsTextImports({
      source: resolvedSource,
      languageId: resolvedSup.id,
      resolveFrom,
      pushBinding: (binding) => imports.push(binding),
    });
    if (resolvedSup.id === "c" || resolvedSup.id === "cpp") {
      for (const specifier of collectTextImportSpecifiers(resolvedSup.id, resolvedSource, { file })) {
        imports.push({
          kind: "star",
          from: specifier.spec,
          resolved: await resolveFrom(
            specifier.spec,
            undefined,
            specifier.includeForm ? { includeForm: specifier.includeForm } : undefined,
          ),
          typeOnly: !!specifier.typeOnly,
          ...(specifier.includeForm ? { includeForm: specifier.includeForm } : {}),
        });
      }
    }
  };

  const runValueRequireFallback = async () => {
    await collectJsTextValueRequireImports({
      source: resolvedSource,
      languageId: resolvedSup.id,
      resolveFrom,
      pushBinding: (binding) => imports.push(binding),
    });
  };

  const nativeLanguageAvailable = isNativeBindingLoadedForLanguage(resolvedSup.id, nativeMode);
  let nativeFallbackReason: FallbackImportExtractionReason | null = nativeExecutionFallbackReason;

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
      if (
        (resolvedSup.id === "ts" || resolvedSup.id === "tsx") &&
        /\brequire\s*\(/.test(stripJsLikeComments(resolvedSource))
      ) {
        await runValueRequireFallback();
        await finalizeImports();
      }
      if (imports.length) {
        return imports;
      }
      if (
        isNativeQueryAuthoritative(resolvedSup, "importBindings") &&
        resolvedSup.id !== "html" &&
        resolvedSup.id !== "css" &&
        resolvedSup.id !== "scss" &&
        resolvedSup.id !== "less"
      ) {
        return imports;
      }
      nativeFallbackReason = "query-empty";
    } catch (error) {
      if (isNativeRequiredUnavailableError(error)) throw error;
      imports.length = 0;
      nativeFallbackReason = "query-error";
    }
  }

  if (nativeFallbackReason) {
    reportFallback(nativeFallbackReason);
  }

  await runFallback();
  await finalizeImports();
  if (
    !imports.length &&
    (resolvedSup.id === "html" || resolvedSup.id === "css" || resolvedSup.id === "scss" || resolvedSup.id === "less")
  ) {
    const specifiers = collectModuleSpecifiersFromSource(resolvedSup, resolvedSource, {
      file,
      ...(opts?.native ? { native: opts.native } : {}),
      ...(opts?.logLevel ? { logLevel: opts.logLevel } : {}),
    });
    for (const specifier of specifiers) {
      imports.push({
        kind: "star",
        from: specifier.spec,
        resolved: await resolveFrom(
          specifier.spec,
          undefined,
          specifier.resolutionKind ? { resolutionKind: specifier.resolutionKind } : undefined,
        ),
        ...(specifier.typeOnly ? { typeOnly: true } : {}),
      });
    }
  }
  if (!nativeFallbackReason && !nativeLanguageAvailable && imports.length) {
    reportFallback("reduced-mode");
  }
  return imports;
}
