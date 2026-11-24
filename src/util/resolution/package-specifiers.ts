import { lookupJvmImport, resolveJvmPackageImportPaths } from "./jvm.js";
import { resolveGoImportPath } from "./go.js";
import { resolvePhpImportPath } from "./php.js";
import { resolveRustImportPath } from "./rust.js";
import { resolvePythonModule } from "./python.js";
import { resolveTerraformModuleSourcePaths } from "./terraform.js";
import type { ImportSpecifierOptions, SpecifierTargetPolicy } from "./language-policy-types.js";

export const JAVA_SPECIFIER_POLICY: SpecifierTargetPolicy = {
  representativeBindingTarget: true,
  declarationImport: { languageId: "java", lookup: lookupJvmImport },
  packageImportFiles: resolveJvmPackageImportPaths,
  resolve: "import",
};

export const KOTLIN_SPECIFIER_POLICY: SpecifierTargetPolicy = {
  representativeBindingTarget: true,
  declarationImport: { languageId: "kotlin", lookup: lookupJvmImport },
  packageImportFiles: resolveJvmPackageImportPaths,
  resolve: "import",
};

export const GO_SPECIFIER_POLICY: SpecifierTargetPolicy = {
  async resolveImport(root, file, spec, _options, deps) {
    return (await deps.confineLanguageHit(root, await resolveGoImportPath(root, file, spec), spec)) ?? undefined;
  },
  resolve: (file, spec, metadata, deps, policy) =>
    deps.resolveLanguageImportTargets(file, spec, "go", metadata, policy),
};

export const PHP_SPECIFIER_POLICY: SpecifierTargetPolicy = {
  async resolveImport(root, file, spec, options, deps) {
    const hit = await deps.confineLanguageHit(
      root,
      await resolvePhpImportPath(root, file, spec, options.phpImportType, options.parsedFiles),
      spec,
    );
    if (hit) return hit;
    if (options.phpImportType) return { external: spec };
    return undefined;
  },
  resolve: (file, spec, metadata, deps, policy) =>
    deps.resolveLanguageImportTargets(file, spec, "php", metadata, policy),
};

export const RUST_SPECIFIER_POLICY: SpecifierTargetPolicy = {
  async resolveImport(root, file, spec, options, deps) {
    const statementStartIndex = options.statementStartIndex;
    const pathAttribute = statementStartIndex !== undefined ? options.pathAttribute : undefined;
    const resolved = await resolveRustImportPath(root, file, spec, pathAttribute, statementStartIndex);
    return (await deps.confineLanguageHit(root, resolved, spec)) ?? { external: spec };
  },
  async resolve(file, specifier, metadata, deps, policy) {
    if (metadata.rawSpecifier && metadata.rawSpecifier !== specifier) {
      const rawResolved = await deps.resolveLanguageImport(
        file,
        specifier,
        "rust",
        {
          projectRoot: metadata.projectRoot,
          ...(metadata.matchPath ? { matchPath: metadata.matchPath } : {}),
          ...(metadata.workspaceConfig ? { workspaceConfig: metadata.workspaceConfig } : {}),
          resolveNodeModules: !!metadata.resolveNodeModules,
          ...(metadata.resolutionHints ? { resolutionHints: metadata.resolutionHints } : {}),
          ...(metadata.exportCondition ? { exportCondition: metadata.exportCondition } : {}),
        },
        policy,
        metadata.rawSpecifier,
      );
      if (typeof rawResolved === "string") return { files: [rawResolved], externalName: metadata.rawSpecifier };
    }
    return deps.resolveLanguageImportTargets(file, specifier, "rust", metadata, policy);
  },
};

export const ZIG_SPECIFIER_POLICY: SpecifierTargetPolicy = {
  async resolveImport(root, file, spec, options: ImportSpecifierOptions, deps) {
    const bareSibling =
      spec.endsWith(".zig") && !spec.startsWith(".") && !spec.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(spec);
    if (!bareSibling) return undefined;
    const hit = await deps.resolveSpecifier(file, "./" + spec, root, options.matchPath, options.workspaceConfig, {
      resolveNodeModules: !!options.resolveNodeModules,
      ...(options.resolutionHints ? { resolutionHints: options.resolutionHints } : {}),
      ...(options.resolutionKind ? { resolutionKind: options.resolutionKind } : {}),
      ...(options.exportCondition ? { exportCondition: options.exportCondition } : {}),
    });
    return typeof hit === "string" ? hit : undefined;
  },
  resolve: (file, spec, metadata, deps, policy) =>
    deps.resolveLanguageImportTargets(file, spec, "zig", metadata, policy),
};

export const PYTHON_SPECIFIER_POLICY: SpecifierTargetPolicy = {
  async resolve(file, specifier, metadata) {
    const match = specifier.match(/^(\.+)(.*)$/);
    const relDots = match ? (match[1] ?? "").length : 0;
    const moduleName = match ? match[2] || null : specifier;
    const resolved = await resolvePythonModule(metadata.projectRoot, file, moduleName, relDots);
    return { files: typeof resolved === "string" ? [resolved] : [], externalName: specifier };
  },
};

export const TERRAFORM_SPECIFIER_POLICY: SpecifierTargetPolicy = {
  async resolve(file, specifier, metadata) {
    const files = await resolveTerraformModuleSourcePaths(
      metadata.projectRoot,
      specifier,
      file,
      metadata.languageExtensions,
    );
    return { files, externalName: specifier };
  },
};
