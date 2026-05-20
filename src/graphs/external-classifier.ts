import { declaredPackagesForContext } from "./external/context.js";
import { isSupportedStdlib, isUrlSpecifier } from "./external/stdlib.js";

export {
  getExternalClassifierCacheStats,
  resetExternalClassifierCaches,
} from "./external/context.js";

export type ExternalResolutionStatus = "declared-package" | "stdlib" | "url" | "unresolved";

export type ExternalSpecifierClassification = {
  status: ExternalResolutionStatus;
  packageName?: string;
};

export type ExternalSpecifierClassificationOptions = {
  projectRoot?: string;
};

function packageNameForSpecifier(specifier: string): string {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : specifier;
  }
  return specifier.split("/")[0] ?? specifier;
}

function isDeclaredPackageSpecifier(specifier: string, declaredPackage: string): boolean {
  if (specifier === declaredPackage) return true;
  if (specifier.startsWith(`${declaredPackage}/`)) return true;
  if (specifier.startsWith(`${declaredPackage}.`)) return true;
  return packageNameForSpecifier(specifier) === declaredPackage;
}

function isDeclaredPackage(specifier: string, importerFile: string, projectRoot: string | undefined): boolean {
  for (const declaredPackage of declaredPackagesForContext(importerFile, projectRoot)) {
    if (isDeclaredPackageSpecifier(specifier, declaredPackage)) {
      return true;
    }
  }
  return false;
}

export function classifyExternalSpecifier(args: {
  raw: string;
  externalName: string;
  importerFile: string;
  options?: ExternalSpecifierClassificationOptions;
}): ExternalSpecifierClassification {
  const specifier = args.raw || args.externalName;
  if (isUrlSpecifier(specifier) || isUrlSpecifier(args.externalName)) return { status: "url" };
  if (isSupportedStdlib(specifier, args.importerFile) || isSupportedStdlib(args.externalName, args.importerFile)) {
    return { status: "stdlib" };
  }
  if (
    isDeclaredPackage(specifier, args.importerFile, args.options?.projectRoot) ||
    isDeclaredPackage(args.externalName, args.importerFile, args.options?.projectRoot)
  ) {
    return { status: "declared-package", packageName: packageNameForSpecifier(specifier) };
  }
  return { status: "unresolved" };
}
