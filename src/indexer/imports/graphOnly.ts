import {
  extractGraphOnlyModuleSpecifiers,
  graphOnlyLanguageSupportsImportAliases,
  graphOnlySpecifierNeedsResolutionConfig,
} from "../../documentLinks.js";
import type { GraphBuildOptions } from "../../graphs/types.js";
import type { LogLevel } from "../../logging.js";
import { getGraphOnlyResolutionExtensions, loadNearestTsconfigFor, resolveSpecifier } from "../../util/resolution.js";
import { loadWorkspaceConfig } from "../../util/workspace.js";
import type { ImportBinding } from "../types.js";

export type GraphOnlyImportExtractionContext = {
  file: string;
  projectRoot: string;
  source: string;
  languageId: string;
  graphOptions?: GraphBuildOptions;
  logLevel?: LogLevel;
};

export async function collectGraphOnlyImports(context: GraphOnlyImportExtractionContext): Promise<ImportBinding[]> {
  const entries = Array.from(extractGraphOnlyModuleSpecifiers(context.languageId, context.source));
  const needsResolutionConfig =
    graphOnlyLanguageSupportsImportAliases(context.languageId) &&
    entries.some(({ spec }) => graphOnlySpecifierNeedsResolutionConfig(spec));

  let matchPath: Awaited<ReturnType<typeof loadNearestTsconfigFor>>["matchPath"] | undefined;
  let workspaceConfig: Awaited<ReturnType<typeof loadWorkspaceConfig>> | undefined;
  if (needsResolutionConfig) {
    const tsconfig = await loadNearestTsconfigFor(context.file, context.logLevel);
    matchPath = tsconfig.matchPath;
    workspaceConfig = await loadWorkspaceConfig(context.projectRoot);
  }

  const resolutionHints = context.graphOptions?.resolutionHints;
  const resolvedSpecifiers = await Promise.all(
    entries.map((entry) =>
      resolveSpecifier(context.file, entry.spec, context.projectRoot, matchPath, workspaceConfig, {
        resolveNodeModules: !!context.graphOptions?.resolveNodeModules,
        resolutionExtensions: getGraphOnlyResolutionExtensions(context.languageId, entry.resolutionKind ?? "document"),
        ...(resolutionHints ? { resolutionHints } : {}),
      }),
    ),
  );

  const bindings: ImportBinding[] = [];
  entries.forEach((entry, index) => {
    const resolved = resolvedSpecifiers[index];
    if (resolved === undefined) {
      throw new Error(`Missing graph-only resolution result for ${context.languageId}:${entry.spec}`);
    }
    if (typeof resolved !== "string" && entry.dropIfUnresolved) {
      return;
    }

    const from = entry.raw ?? entry.spec;
    const normalizedResolved =
      typeof resolved === "string" ? resolved.replace(/\\/g, "/") : { ...resolved, external: from };
    bindings.push({
      kind: "star",
      from,
      resolved: normalizedResolved,
    });
  });
  return bindings;
}
