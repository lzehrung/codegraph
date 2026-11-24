import { resolveImportSpecifier, resolvePathLikeModule, resolveSpecifier } from "../resolution.js";
import { STYLESHEET_RESOLUTION_EXTENSIONS } from "../resolution-candidates.js";
import { specifierTargetPolicyFor } from "./language-specifiers.js";
import type { SpecifierTargetDeps, SpecifierTargetPolicy } from "./language-policy-types.js";
import type { SpecifierTargetMetadata, SpecifierTargets } from "./specifier-target-types.js";

type ResolvedSpecifier = string | { external: string };

/** A selected language policy may reject a resolved first-party target. */
function applyResolvedFileRule(
  resolved: ResolvedSpecifier,
  rejectedExternalName: string,
  policy: SpecifierTargetPolicy,
  metadata: SpecifierTargetMetadata,
): ResolvedSpecifier {
  const acceptsFile = policy.acceptsFile;
  if (!acceptsFile || typeof resolved !== "string") return resolved;
  if (acceptsFile(resolved, metadata)) return resolved;
  return { external: rejectedExternalName };
}

function partialsAllowed(policy: SpecifierTargetPolicy, metadata: SpecifierTargetMetadata): boolean {
  return !!policy.allowPartialResolution && metadata.resolutionKind !== "document";
}

function stylesheetExtensions(metadata: SpecifierTargetMetadata): readonly string[] | undefined {
  if (metadata.resolutionExtensions) return metadata.resolutionExtensions;
  if (metadata.resolutionKind === "stylesheet") return STYLESHEET_RESOLUTION_EXTENSIONS;
  return undefined;
}

async function resolveLanguageImport(
  file: string,
  specifier: string,
  languageId: string,
  metadata: SpecifierTargetMetadata,
  policy: SpecifierTargetPolicy,
  specOverride?: string,
): Promise<ResolvedSpecifier> {
  return resolveImportSpecifier(
    metadata.projectRoot,
    file,
    specOverride ?? specifier,
    languageId,
    {
      ...(metadata.matchPath ? { matchPath: metadata.matchPath } : {}),
      ...(metadata.workspaceConfig ? { workspaceConfig: metadata.workspaceConfig } : {}),
      resolveNodeModules: !!metadata.resolveNodeModules,
      ...(metadata.resolutionHints ? { resolutionHints: metadata.resolutionHints } : {}),
      ...(metadata.phpImportType ? { phpImportType: metadata.phpImportType } : {}),
      ...(metadata.resolutionKind ? { resolutionKind: metadata.resolutionKind } : {}),
      ...(partialsAllowed(policy, metadata) ? { allowScssPartialResolution: true } : {}),
      ...(metadata.exportCondition ? { exportCondition: metadata.exportCondition } : {}),
      ...(metadata.pathAttribute ? { pathAttribute: metadata.pathAttribute } : {}),
      ...(metadata.statementStartIndex !== undefined ? { statementStartIndex: metadata.statementStartIndex } : {}),
      ...(metadata.includeForm ? { includeForm: metadata.includeForm } : {}),
      ...(metadata.parsedFiles ? { parsedFiles: metadata.parsedFiles } : {}),
    },
    policy,
  );
}

async function resolveGenericSpecifier(
  file: string,
  specifier: string,
  policy: SpecifierTargetPolicy,
  metadata: SpecifierTargetMetadata,
): Promise<ResolvedSpecifier> {
  const resolutionExtensions = stylesheetExtensions(metadata);
  return resolveSpecifier(file, specifier, metadata.projectRoot, metadata.matchPath, metadata.workspaceConfig, {
    resolveNodeModules: !!metadata.resolveNodeModules,
    ...(resolutionExtensions ? { resolutionExtensions } : {}),
    ...(metadata.resolutionKind ? { resolutionKind: metadata.resolutionKind } : {}),
    ...(metadata.resolutionHints ? { resolutionHints: metadata.resolutionHints } : {}),
    ...(metadata.exportCondition ? { exportCondition: metadata.exportCondition } : {}),
    ...(partialsAllowed(policy, metadata) ? { allowScssPartialResolution: true } : {}),
  });
}

async function resolveLanguageImportTargets(
  file: string,
  specifier: string,
  languageId: string,
  metadata: SpecifierTargetMetadata,
  policy: SpecifierTargetPolicy,
): Promise<SpecifierTargets> {
  const resolved = await resolveLanguageImport(file, specifier, languageId, metadata, policy);
  const accepted = applyResolvedFileRule(resolved, specifier, policy, metadata);
  if (typeof accepted === "string") return { files: [accepted], externalName: specifier };
  return { files: [], externalName: metadata.rawSpecifier ?? accepted.external };
}

async function resolvePathFallbackTargets(
  file: string,
  specifier: string,
  policy: SpecifierTargetPolicy,
  metadata: SpecifierTargetMetadata,
): Promise<SpecifierTargets> {
  const pathLike = await resolvePathLikeModule(metadata.projectRoot, specifier, stylesheetExtensions(metadata));
  const resolved = pathLike ? pathLike : await resolveGenericSpecifier(file, specifier, policy, metadata);
  const accepted = applyResolvedFileRule(resolved, metadata.rawSpecifier ?? specifier, policy, metadata);
  if (typeof accepted === "string") return { files: [accepted], externalName: specifier };
  return { files: [], externalName: metadata.rawSpecifier ?? accepted.external };
}

const SPECIFIER_TARGET_DEPS: SpecifierTargetDeps = {
  resolveSpecifier,
  resolveLanguageImport,
  resolveLanguageImportTargets,
  resolvePathFallbackTargets,
};

/**
 * Map one import specifier to every first-party file it names.
 * Callers shape that list: graph edges keep one edge per file, and import bindings
 * keep a single file or an external name.
 */
export async function resolveSpecifierTargets(
  file: string,
  specifier: string,
  languageId: string,
  metadata: SpecifierTargetMetadata,
  policy: SpecifierTargetPolicy = specifierTargetPolicyFor(languageId),
): Promise<SpecifierTargets> {
  const resolveTargets = policy.resolve;
  if (resolveTargets === "import") {
    const packageImportFiles = policy.packageImportFiles;
    if (metadata.jvmPackageWildcard && packageImportFiles) {
      const files = await packageImportFiles(metadata.projectRoot, specifier, file);
      if (files.length) return { files, externalName: specifier, jvmPackageMatched: true };
    }
    return resolveLanguageImportTargets(file, specifier, languageId, metadata, policy);
  }
  if (resolveTargets) {
    const targets = await resolveTargets(file, specifier, metadata, SPECIFIER_TARGET_DEPS, policy);
    if (targets !== undefined) return targets;
  }
  const resolved = await resolveGenericSpecifier(file, specifier, policy, metadata);
  if (typeof resolved === "string") return { files: [resolved], externalName: specifier };
  return { files: [], externalName: metadata.rawSpecifier ?? resolved.external };
}
