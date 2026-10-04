import { prepareSourceInput } from "../languages/file-prep.js";
import { loadNearestTsconfigFor, type MatchPathFn } from "../util/resolution.js";
import { resolveSpecifierTargets } from "../util/resolution/specifier-targets.js";
import { loadWorkspaceConfig, type WorkspaceConfig } from "../util/workspace.js";
import type { LogLevel } from "../logging.js";
import { errorMessage } from "../util/errors.js";
import { recordNativeExecutionOutcome } from "../native/native-backend-report.js";
import type { BuildReport } from "./types.js";
import { collectModuleSpecifiersFromSource } from "../graphs/specifiers.js";
import type { GraphBuildOptions } from "../graphs/types.js";
import type { LanguageExtensionMap } from "../languages.js";
import { isGraphOnlyLanguage } from "../document-links.js";
import { stripJsLikeComments } from "../util/comments.js";
import {
  assertNativeRequiredAvailable,
  getNativeQueryExecution,
  isNativeRequiredUnavailableError,
} from "../native/tree-sitter-native.js";
import type { NativeQueryExecution, NativeQueryResults } from "../native/tree-sitter-native.js";
import type { ImportResolverOptions, ResolvedImportTarget } from "./imports/context.js";
import { attributeNamedBindingRanges, maskImportBindingTrivia } from "./imports/binding-ranges.js";
import { IMPORT_BINDING_ROWS } from "./imports/import-binding-tables.js";
import { collectGraphOnlyImports } from "./imports/graph-only.js";
import { collectJsTextValueRequireImports } from "./imports/js-text-imports.js";
import {
  applyStatementImportOverride,
  createStatementImportOverrideState,
  finalizeLanguageSpecificImports,
} from "./imports/language-specific.js";
import { collectNativeCaptureImportBindings } from "./imports/native-captures.js";
import { collectPythonImportsFromNativeMatches } from "./imports/python.js";
import type { LanguageSupport } from "../languages.js";
import { jvmPackageNameFromSource } from "./compilation-units.js";
import type { ImportBinding } from "./types.js";

export async function collectImportsForFile(
  file: string,
  projectRoot: string,
  opts?: {
    source?: string;
    sup?: LanguageSupport;
    nativeQueries?: NativeQueryResults | null;
    graphOptions?: GraphBuildOptions;
    logLevel?: LogLevel;
    languageExtensions?: LanguageExtensionMap;
    workspaceConfig?: WorkspaceConfig;
    report?: BuildReport;
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
  assertNativeRequiredAvailable();
  let nativeExecution: NativeQueryExecution | null = null;
  let resolvedNativeQueries: NativeQueryResults | null = opts?.nativeQueries ?? null;
  if (opts?.nativeQueries === undefined) {
    nativeExecution = getNativeQueryExecution(resolvedSource, resolvedSup);
    resolvedNativeQueries = nativeExecution.results;
  }
  if (nativeExecution?.fallbackReason) {
    recordNativeExecutionOutcome(opts?.report, {
      file: file.replace(/\\/g, "/"),
      support: resolvedSup,
      results: null,
      fallbackReason: nativeExecution.fallbackReason,
      ...(nativeExecution.error ? { error: nativeExecution.error } : {}),
    });
  }
  if (!resolvedNativeQueries) return imports;

  if (resolvedSup.id === "python") {
    const context = {
      file,
      projectRoot,
      source: resolvedSource,
      pushBinding: (binding: ImportBinding) => imports.push(binding),
      getBindings: () => imports,
    };
    await collectPythonImportsFromNativeMatches(context, resolvedNativeQueries.importBindings);
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
      if (
        binding.kind === "named" &&
        typeof binding.resolved === "string" &&
        (resolvedSup.id === "java" || resolvedSup.id === "kotlin")
      ) {
        if (jvmDeclaredPackage === undefined) {
          jvmDeclaredPackage = jvmPackageNameFromSource(resolvedSource, resolvedSup.id);
        }
        if (jvmDeclaredPackage === binding.from.slice(0, binding.from.lastIndexOf("."))) {
          binding.jvmSamePackage = true;
        }
      }
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
      if (binding.jvmStaticWildcardName && resolvedSup.id === "java") {
        if (jvmDeclaredPackage === undefined) {
          jvmDeclaredPackage = jvmPackageNameFromSource(resolvedSource, resolvedSup.id);
        }
        const typePackage = binding.from.slice(0, -(binding.jvmStaticWildcardName.length + 1));
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

  const runValueRequireFallback = async () => {
    await collectJsTextValueRequireImports({
      source: resolvedSource,
      languageId: resolvedSup.id,
      resolveFrom,
      pushBinding: (binding) => imports.push(binding),
    });
  };

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
      // Native capture results are valid even when no bindings match. The CommonJS
      // require supplement below remains native-owned for TS/TSX.
      if (
        (resolvedSup.id === "ts" || resolvedSup.id === "tsx") &&
        /\brequire\s*\(/.test(stripJsLikeComments(resolvedSource))
      ) {
        await runValueRequireFallback();
        await finalizeImports();
      }
      if (imports.length || !["html", "css", "scss", "less"].includes(resolvedSup.id)) return imports;
    } catch (error) {
      if (isNativeRequiredUnavailableError(error)) throw error;
      recordNativeExecutionOutcome(opts?.report, {
        file: file.replace(/\\/g, "/"),
        support: resolvedSup,
        results: null,
        fallbackReason: "queryFailure",
        error: errorMessage(error),
      });
      return [];
    }
  }

  if (!imports.length && ["html", "css", "scss", "less"].includes(resolvedSup.id)) {
    const specifiers = collectModuleSpecifiersFromSource(resolvedSup, resolvedSource, {
      file,
      nativeQueries: resolvedNativeQueries,
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
  return imports;
}
