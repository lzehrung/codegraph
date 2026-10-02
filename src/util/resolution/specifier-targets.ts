import { supportForFileWithoutHeaderSample, type LanguageExtensionMap } from "../../languages.js";
import type { WorkspaceConfig } from "../workspace.js";
import { resolveImportSpecifier, resolvePathLikeModule, resolvePythonModule, resolveSpecifier } from "../resolution.js";
import { getImportableLanguageExtensions, STYLESHEET_RESOLUTION_EXTENSIONS } from "../resolution-candidates.js";
import { resolveCsharpDottedTypeImportPath, resolveCsharpNamespaceImportPaths } from "./csharp.js";
import { resolveJvmPackageImportPaths } from "./jvm.js";
import type { MatchPathFn } from "./tsconfig.js";
import type {
  CFamilyIncludeForm,
  ModuleSpecifierExportCondition,
  ModuleSpecifierResolutionKind,
  RubyLoadForm,
} from "../specifiers.js";

export type SpecifierTargetMetadata = {
  projectRoot: string;
  matchPath?: MatchPathFn;
  workspaceConfig?: WorkspaceConfig;
  resolveNodeModules?: boolean;
  resolutionHints?: string[];
  phpImportType?: "class" | "function" | "const";
  resolutionKind?: ModuleSpecifierResolutionKind;
  exportCondition?: ModuleSpecifierExportCondition;
  pathAttribute?: string;
  statementStartIndex?: number;
  includeForm?: CFamilyIncludeForm;
  rubyLoadForm?: RubyLoadForm;
  languageExtensions?: LanguageExtensionMap;
  /** Distinguishes `import p.C.*` from `import p.C` when both a package and a class exist. */
  jvmPackageWildcard?: true;
  /** Rust tries this spelling before `specifier` when it differs, without `pathAttribute`. */
  rawSpecifier?: string;
  resolutionExtensions?: readonly string[];
};

export type SpecifierTargets = {
  /** Every first-party file this specifier names. Empty when external. */
  files: string[];
  /** Name for an external edge or binding. Unused when `files` is non-empty. */
  externalName: string;
  /**
   * C# ambiguous and partial type matches keep an external edge.
   * Other unresolved specifiers still honor `dropIfUnresolved`.
   */
  retainExternalEdge?: boolean;
};

type ResolvedSpecifier = string | { external: string };

/**
 * A C# import never names a file of another language.
 * `using System;` beside a root `system.ts` stays external, whether path-like,
 * hint, workspace, or package resolution found that file.
 */
function applyCsharpFileRule(
  resolved: ResolvedSpecifier,
  rejectedExternalName: string,
  languageId: string,
  metadata: SpecifierTargetMetadata,
): ResolvedSpecifier {
  if (languageId !== "csharp" || typeof resolved !== "string") return resolved;
  if (supportForFileWithoutHeaderSample(resolved, metadata.languageExtensions)?.id === "csharp") return resolved;
  return { external: rejectedExternalName };
}

function scssPartialsAllowed(languageId: string, metadata: SpecifierTargetMetadata): boolean {
  return languageId === "scss" && metadata.resolutionKind !== "document";
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
  specOverride?: string,
): Promise<ResolvedSpecifier> {
  return resolveImportSpecifier(metadata.projectRoot, file, specOverride ?? specifier, languageId, {
    ...(metadata.matchPath ? { matchPath: metadata.matchPath } : {}),
    ...(metadata.workspaceConfig ? { workspaceConfig: metadata.workspaceConfig } : {}),
    resolveNodeModules: !!metadata.resolveNodeModules,
    ...(metadata.resolutionHints ? { resolutionHints: metadata.resolutionHints } : {}),
    ...(metadata.phpImportType ? { phpImportType: metadata.phpImportType } : {}),
    ...(metadata.resolutionKind ? { resolutionKind: metadata.resolutionKind } : {}),
    ...(scssPartialsAllowed(languageId, metadata) ? { allowScssPartialResolution: true } : {}),
    ...(metadata.exportCondition ? { exportCondition: metadata.exportCondition } : {}),
    ...(metadata.pathAttribute ? { pathAttribute: metadata.pathAttribute } : {}),
    ...(metadata.statementStartIndex !== undefined ? { statementStartIndex: metadata.statementStartIndex } : {}),
    ...(metadata.includeForm ? { includeForm: metadata.includeForm } : {}),
  });
}

async function resolveGenericSpecifier(
  file: string,
  specifier: string,
  languageId: string,
  metadata: SpecifierTargetMetadata,
): Promise<ResolvedSpecifier> {
  const resolutionExtensions = stylesheetExtensions(metadata);
  return resolveSpecifier(file, specifier, metadata.projectRoot, metadata.matchPath, metadata.workspaceConfig, {
    resolveNodeModules: !!metadata.resolveNodeModules,
    ...(resolutionExtensions ? { resolutionExtensions } : {}),
    ...(metadata.resolutionKind ? { resolutionKind: metadata.resolutionKind } : {}),
    ...(metadata.resolutionHints ? { resolutionHints: metadata.resolutionHints } : {}),
    ...(metadata.exportCondition ? { exportCondition: metadata.exportCondition } : {}),
    ...(scssPartialsAllowed(languageId, metadata) ? { allowScssPartialResolution: true } : {}),
  });
}

async function resolveLanguageImportTargets(
  file: string,
  specifier: string,
  languageId: string,
  metadata: SpecifierTargetMetadata,
): Promise<SpecifierTargets> {
  if (languageId === "rust" && metadata.rawSpecifier && metadata.rawSpecifier !== specifier) {
    const rawResolved = await resolveLanguageImport(
      file,
      specifier,
      languageId,
      {
        projectRoot: metadata.projectRoot,
        ...(metadata.matchPath ? { matchPath: metadata.matchPath } : {}),
        ...(metadata.workspaceConfig ? { workspaceConfig: metadata.workspaceConfig } : {}),
        resolveNodeModules: !!metadata.resolveNodeModules,
        ...(metadata.resolutionHints ? { resolutionHints: metadata.resolutionHints } : {}),
        ...(metadata.exportCondition ? { exportCondition: metadata.exportCondition } : {}),
      },
      metadata.rawSpecifier,
    );
    if (typeof rawResolved === "string") return { files: [rawResolved], externalName: metadata.rawSpecifier };
  }
  const resolved = await resolveLanguageImport(file, specifier, languageId, metadata);
  const accepted = applyCsharpFileRule(resolved, specifier, languageId, metadata);
  if (typeof accepted === "string") return { files: [accepted], externalName: specifier };
  return { files: [], externalName: metadata.rawSpecifier ?? accepted.external };
}

function splitPythonRelativeSpecifier(specifier: string): { relDots: number; mod: string | null } {
  const match = specifier.match(/^(\.+)(.*)$/);
  if (!match) return { relDots: 0, mod: specifier };
  const dots = match[1] ?? "";
  const rest = match[2] ?? "";
  return { relDots: dots.length, mod: rest || null };
}

async function resolvePythonTargets(
  file: string,
  specifier: string,
  metadata: SpecifierTargetMetadata,
): Promise<SpecifierTargets> {
  const split = splitPythonRelativeSpecifier(specifier);
  const resolved = await resolvePythonModule(metadata.projectRoot, file, split.mod, split.relDots);
  if (typeof resolved === "string") return { files: [resolved], externalName: specifier };
  return { files: [], externalName: specifier };
}

async function resolveCsharpOrRubyTargets(
  file: string,
  specifier: string,
  languageId: string,
  metadata: SpecifierTargetMetadata,
): Promise<SpecifierTargets> {
  if (languageId === "ruby" && metadata.rubyLoadForm === "require_relative") {
    const relativeSpecifier = specifier.startsWith(".") ? specifier : "./" + specifier;
    const relative = await resolveSpecifier(file, relativeSpecifier, metadata.projectRoot, undefined, undefined, {
      resolutionExtensions: getImportableLanguageExtensions("ruby"),
    });
    if (typeof relative === "string") return { files: [relative], externalName: specifier };
    return { files: [], externalName: specifier };
  }
  if (languageId === "csharp") {
    const namespaceTargets = await resolveCsharpNamespaceImportPaths(
      metadata.projectRoot,
      specifier,
      file,
      metadata.languageExtensions,
    );
    if (namespaceTargets.length) return { files: namespaceTargets, externalName: specifier };
    const typeMatch = await resolveCsharpDottedTypeImportPath(
      metadata.projectRoot,
      specifier,
      file,
      metadata.languageExtensions,
    );
    if (typeMatch.status === "found") return { files: [typeMatch.file], externalName: specifier };
    if (typeMatch.status === "ambiguous" || typeMatch.status === "partial") {
      return {
        files: [],
        externalName: metadata.rawSpecifier ?? specifier,
        retainExternalEdge: true,
      };
    }
  }
  const pathLike = await resolvePathLikeModule(metadata.projectRoot, specifier, stylesheetExtensions(metadata));
  const resolved = pathLike ? pathLike : await resolveGenericSpecifier(file, specifier, languageId, metadata);
  const accepted = applyCsharpFileRule(resolved, metadata.rawSpecifier ?? specifier, languageId, metadata);
  if (typeof accepted === "string") return { files: [accepted], externalName: specifier };
  return { files: [], externalName: metadata.rawSpecifier ?? accepted.external };
}

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
): Promise<SpecifierTargets> {
  if (languageId === "python") return resolvePythonTargets(file, specifier, metadata);
  if (languageId === "java" || languageId === "kotlin") {
    if (metadata.jvmPackageWildcard) {
      const packageTargets = await resolveJvmPackageImportPaths(metadata.projectRoot, specifier, file);
      if (packageTargets.length) return { files: packageTargets, externalName: specifier };
    }
    return resolveLanguageImportTargets(file, specifier, languageId, metadata);
  }
  if (
    languageId === "go" ||
    languageId === "php" ||
    languageId === "rust" ||
    languageId === "zig" ||
    languageId === "c" ||
    languageId === "cpp"
  ) {
    return resolveLanguageImportTargets(file, specifier, languageId, metadata);
  }
  if (languageId === "csharp" || languageId === "ruby") {
    return resolveCsharpOrRubyTargets(file, specifier, languageId, metadata);
  }
  const resolved = await resolveGenericSpecifier(file, specifier, languageId, metadata);
  if (typeof resolved === "string") return { files: [resolved], externalName: specifier };
  return { files: [], externalName: metadata.rawSpecifier ?? resolved.external };
}
