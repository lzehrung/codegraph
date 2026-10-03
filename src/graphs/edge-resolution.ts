import type { LanguageExtensionMap, LanguageSupport } from "../languages.js";
import type { EdgeTo } from "../types.js";
import { getGraphOnlyResolutionExtensions, type MatchPathFn } from "../util/resolution.js";
import { type ModuleSpecifier } from "../util/specifiers.js";
import { type WorkspaceConfig } from "../util/workspace.js";
import { isGraphOnlyLanguage } from "../document-links.js";
import { STYLESHEET_RESOLUTION_EXTENSIONS } from "../util/resolution-candidates.js";
import { resolveSpecifierTargets } from "../util/resolution/specifier-targets.js";

type ResolvedSpecifierEdge = {
  to: EdgeTo;
  spec: string;
  raw?: string;
  typeOnly?: boolean;
  resolved?: ModuleSpecifier["resolved"];
  confidence?: number;
  includeForm?: ModuleSpecifier["includeForm"];
};

export type ModuleSpecifierResolutionContext = {
  support: LanguageSupport;
  file: string;
  projectRoot: string;
  workspaceConfig: WorkspaceConfig | undefined;
  matchPath: MatchPathFn | undefined;
  resolveNodeModules?: boolean;
  resolutionHints?: string[];
  /** Active extension-to-language mapping, so a file is classified as the language that parses it. */
  languageExtensions?: LanguageExtensionMap;
};

function edgeToResolvedFile(resolved: string): EdgeTo {
  return { type: "file", path: resolved.replace(/\\/g, "/") };
}

function edgeToExternal(name: string): EdgeTo {
  return { type: "external", name };
}

function withSpecifierMetadata(entry: ModuleSpecifier, to: EdgeTo): ResolvedSpecifierEdge {
  return {
    to,
    spec: entry.spec,
    ...(entry.raw !== undefined ? { raw: entry.raw } : {}),
    ...(entry.typeOnly !== undefined ? { typeOnly: entry.typeOnly } : {}),
    ...(entry.resolved !== undefined ? { resolved: entry.resolved } : {}),
    ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
    ...(entry.includeForm ? { includeForm: entry.includeForm } : {}),
  };
}

export async function resolveModuleSpecifierEdges(
  entry: ModuleSpecifier,
  context: ModuleSpecifierResolutionContext,
): Promise<ResolvedSpecifierEdge[] | null> {
  const graphOnlyLanguage = isGraphOnlyLanguage(context.support.id);
  let resolutionExtensions: readonly string[] | undefined;
  if (entry.resolutionKind === "stylesheet") {
    resolutionExtensions = STYLESHEET_RESOLUTION_EXTENSIONS;
  } else if (graphOnlyLanguage) {
    resolutionExtensions = getGraphOnlyResolutionExtensions(context.support.id, entry.resolutionKind ?? "document");
  }

  const targets = await resolveSpecifierTargets(context.file, entry.spec, context.support.id, {
    projectRoot: context.projectRoot,
    ...(context.matchPath ? { matchPath: context.matchPath } : {}),
    ...(context.workspaceConfig ? { workspaceConfig: context.workspaceConfig } : {}),
    resolveNodeModules: !!context.resolveNodeModules,
    ...(context.resolutionHints ? { resolutionHints: context.resolutionHints } : {}),
    ...(context.languageExtensions ? { languageExtensions: context.languageExtensions } : {}),
    ...(entry.jvmPackageWildcard ? { jvmPackageWildcard: true } : {}),
    ...(entry.raw !== undefined ? { rawSpecifier: entry.raw } : {}),
    ...(entry.phpImportType ? { phpImportType: entry.phpImportType } : {}),
    ...(entry.resolutionKind ? { resolutionKind: entry.resolutionKind } : {}),
    ...(entry.exportCondition ? { exportCondition: entry.exportCondition } : {}),
    ...(entry.pathAttribute ? { pathAttribute: entry.pathAttribute } : {}),
    ...(entry.statementStartIndex !== undefined ? { statementStartIndex: entry.statementStartIndex } : {}),
    ...(entry.includeForm ? { includeForm: entry.includeForm } : {}),
    ...(entry.rubyLoadForm ? { rubyLoadForm: entry.rubyLoadForm } : {}),
    ...(resolutionExtensions ? { resolutionExtensions } : {}),
  });

  if (targets.files.length) {
    return targets.files.map((targetPath) => withSpecifierMetadata(entry, edgeToResolvedFile(targetPath)));
  }
  if (!targets.retainExternalEdge && entry.dropIfUnresolved) return null;
  return [withSpecifierMetadata(entry, edgeToExternal(targets.externalName))];
}
