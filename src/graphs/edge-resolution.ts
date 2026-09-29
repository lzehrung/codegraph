import { supportForFileWithoutHeaderSample, type LanguageExtensionMap, type LanguageSupport } from "../languages.js";
import type { EdgeTo } from "../types.js";
import {
  getGraphOnlyResolutionExtensions,
  resolveImportSpecifier,
  resolveJvmPackageImportPaths,
  resolvePythonModule,
  resolveSpecifier,
  type MatchPathFn,
} from "../util/resolution.js";
import { type ModuleSpecifier } from "../util/specifiers.js";
import { type WorkspaceConfig } from "../util/workspace.js";
import { isGraphOnlyLanguage } from "../document-links.js";
import { STYLESHEET_RESOLUTION_EXTENSIONS } from "../util/resolution-candidates.js";
import { resolveCsharpDottedTypeImportPath, resolveCsharpNamespaceImportPaths } from "../util/resolution/csharp.js";

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

async function resolveGenericSpecifier(
  entry: ModuleSpecifier,
  context: ModuleSpecifierResolutionContext,
  resolutionExtensions?: readonly string[],
): Promise<EdgeTo> {
  const res = await resolveSpecifier(
    context.file,
    entry.spec,
    context.projectRoot,
    context.matchPath,
    context.workspaceConfig,
    {
      resolveNodeModules: !!context.resolveNodeModules,
      ...(resolutionExtensions ? { resolutionExtensions } : {}),
      ...(entry.resolutionKind ? { resolutionKind: entry.resolutionKind } : {}),
      ...(context.resolutionHints ? { resolutionHints: context.resolutionHints } : {}),
      ...(entry.exportCondition ? { exportCondition: entry.exportCondition } : {}),
      ...(context.support.id === "scss" && entry.resolutionKind !== "document"
        ? { allowScssPartialResolution: true }
        : {}),
    },
  );
  return typeof res === "string" ? edgeToResolvedFile(res) : edgeToExternal(entry.raw ?? res.external);
}

async function resolveImportSpecifierEdge(
  entry: ModuleSpecifier,
  context: ModuleSpecifierResolutionContext,
): Promise<EdgeTo> {
  if (context.support.id === "rust" && entry.raw && entry.raw !== entry.spec) {
    const rawResolved = await resolveImportSpecifier(context.projectRoot, context.file, entry.raw, context.support.id, {
      ...(context.matchPath ? { matchPath: context.matchPath } : {}),
      ...(context.workspaceConfig ? { workspaceConfig: context.workspaceConfig } : {}),
      resolveNodeModules: !!context.resolveNodeModules,
      ...(context.resolutionHints ? { resolutionHints: context.resolutionHints } : {}),
      ...(entry.exportCondition ? { exportCondition: entry.exportCondition } : {}),
    });
    if (typeof rawResolved === "string") {
      return edgeToResolvedFile(rawResolved);
    }
  }

  const res = await resolveImportSpecifier(context.projectRoot, context.file, entry.spec, context.support.id, {
    ...(context.matchPath ? { matchPath: context.matchPath } : {}),
    ...(context.workspaceConfig ? { workspaceConfig: context.workspaceConfig } : {}),
    resolveNodeModules: !!context.resolveNodeModules,
    ...(context.resolutionHints ? { resolutionHints: context.resolutionHints } : {}),
    ...(entry.phpImportType ? { phpImportType: entry.phpImportType } : {}),
    ...(entry.exportCondition ? { exportCondition: entry.exportCondition } : {}),
    ...(entry.pathAttribute ? { pathAttribute: entry.pathAttribute } : {}),
    ...(entry.statementStartIndex !== undefined ? { statementStartIndex: entry.statementStartIndex } : {}),
    ...(entry.includeForm ? { includeForm: entry.includeForm } : {}),
  });
  return typeof res === "string" ? edgeToResolvedFile(res) : edgeToExternal(entry.raw ?? res.external);
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

  let to: EdgeTo;
  if (context.support.id === "python") {
    const relDotsMatch = entry.spec.startsWith(".") ? entry.spec.match(/^\.+/) : null;
    const relDots = relDotsMatch ? relDotsMatch[0].length : 0;
    const isDotsOnly = /^\.+$/.test(entry.spec);
    const res = await resolvePythonModule(context.projectRoot, context.file, isDotsOnly ? null : entry.spec, relDots);
    to = typeof res === "string" ? edgeToResolvedFile(res) : edgeToExternal(res.external);
  } else if (context.support.id === "java" || context.support.id === "kotlin") {
    const packageTargets = await resolveJvmPackageImportPaths(
      context.projectRoot,
      entry.spec,
      context.support.id,
      context.file,
    );
    if (packageTargets.length) {
      return packageTargets.map((targetPath) => withSpecifierMetadata(entry, edgeToResolvedFile(targetPath)));
    }
    to = await resolveImportSpecifierEdge(entry, context);
  } else if (
    context.support.id === "go" ||
    context.support.id === "php" ||
    context.support.id === "rust" ||
    // C and C++ share the quoted-include rule, so both must reach the language resolver or a
    // bare `#include "lib.h"` stays external in the graph while navigation resolves it.
    context.support.id === "c" ||
    context.support.id === "cpp"
  ) {
    to = await resolveImportSpecifierEdge(entry, context);
  } else if (["csharp", "ruby"].includes(context.support.id)) {
    const namespaceTargets =
      context.support.id === "csharp"
        ? await resolveCsharpNamespaceImportPaths(
            context.projectRoot,
            entry.spec,
            context.file,
            context.languageExtensions,
          )
        : [];
    if (namespaceTargets.length) {
      return namespaceTargets.map((targetPath) => withSpecifierMetadata(entry, edgeToResolvedFile(targetPath)));
    }
    if (context.support.id === "csharp") {
      // `using PT = N.Point` is not a namespace. The same helper the import binding uses
      // picks the one declaring file, or refuses an ambiguous set instead of a path guess.
      const typeMatch = await resolveCsharpDottedTypeImportPath(
        context.projectRoot,
        entry.spec,
        context.file,
        context.languageExtensions,
      );
      if (typeMatch.status === "found") {
        return [withSpecifierMetadata(entry, edgeToResolvedFile(typeMatch.file))];
      }
      if (typeMatch.status === "ambiguous" || typeMatch.status === "partial") {
        return [withSpecifierMetadata(entry, edgeToExternal(entry.raw ?? entry.spec))];
      }
    }
    const { resolvePathLikeModule } = await import("../util/resolution.js");
    const pathLike = await resolvePathLikeModule(context.projectRoot, entry.spec);
    // A C# directive names a namespace or type, never another language's file (`using System;`
    // beside a root `system.ts`), so a path-like hit counts only when it is a C# file.
    if (
      context.support.id === "csharp" &&
      pathLike &&
      supportForFileWithoutHeaderSample(pathLike, context.languageExtensions)?.id !== "csharp"
    ) {
      return [withSpecifierMetadata(entry, edgeToExternal(entry.raw ?? entry.spec))];
    }
    to = pathLike ? edgeToResolvedFile(pathLike) : await resolveGenericSpecifier(entry, context, resolutionExtensions);
  } else {
    to = await resolveGenericSpecifier(entry, context, resolutionExtensions);
  }

  if (to.type === "external" && entry.dropIfUnresolved) {
    return null;
  }
  return [withSpecifierMetadata(entry, to)];
}
