import fs from "node:fs";
import path from "node:path";

import type { NativeBindingOrigin } from "./contracts.js";
import { prepareNativeRuntimeCache } from "./runtimeCache.js";

export type NativeBindingLoadResult<T> =
  | { binding: T; error?: undefined; origin: NativeBindingOrigin }
  | { binding: null; error?: unknown; origin?: NativeBindingOrigin };

export type BindingLoaderOptions = {
  packageName: string;
  localPackageRoot: string;
  requireFn: (specifier: string) => unknown;
  resolveFn?: ((specifier: string) => string) | undefined;
  platform?: NodeJS.Platform | undefined;
  arch?: string | undefined;
  cacheRoot?: string | undefined;
};

function isMuslRuntime(): boolean {
  if (process.platform !== "linux") return false;
  const report = process.report?.getReport();
  const header = report && typeof report === "object" && "header" in report ? report.header : null;
  const glibcVersionRuntime =
    header && typeof header === "object" && "glibcVersionRuntime" in header ? header.glibcVersionRuntime : null;
  if (typeof glibcVersionRuntime === "string" && glibcVersionRuntime) return false;
  return true;
}

export function nativeTargetSuffixFor(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "win32") {
    if (arch === "x64") return "win32-x64-msvc";
    if (arch === "arm64") return "win32-arm64-msvc";
  }
  if (platform === "darwin") {
    if (arch === "x64") return "darwin-x64";
    if (arch === "arm64") return "darwin-arm64";
  }
  if (platform === "linux") {
    const abi = isMuslRuntime() ? "musl" : "gnu";
    if (arch === "x64") return `linux-x64-${abi}`;
    if (arch === "arm64") return `linux-arm64-${abi}`;
  }
  return null;
}

export function currentNativeTargetSuffix(): string | null {
  return nativeTargetSuffixFor(process.platform, process.arch);
}

function normalizePathForComparison(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithinDirectory(filePath: string, directoryPath: string): boolean {
  const normalizedFile = normalizePathForComparison(filePath);
  const normalizedDir = normalizePathForComparison(directoryPath);
  return normalizedFile === normalizedDir || normalizedFile.startsWith(`${normalizedDir}${path.sep}`);
}

export function findLocalNativeBinary(packageRoot: string): string | null {
  const suffix = currentNativeTargetSuffix();
  if (!suffix) {
    return null;
  }
  const expectedName = `index.${suffix}.node`;
  try {
    const entries = fs.readdirSync(packageRoot, { withFileTypes: true });
    const binary = entries.find((entry) => entry.isFile() && entry.name === expectedName);
    return binary ? path.join(packageRoot, binary.name) : null;
  } catch {
    return null;
  }
}

function normalizePathForDisplay(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function readPlatformPackage(
  packageName: string,
  target: string,
  resolveFn: (specifier: string) => string,
): { sourcePath: string; packageVersion: string } {
  const platformPackageName = `${packageName}-${target}`;
  const resolvedEntry = resolveFn(platformPackageName);
  const expectedFileName = `index.${target}.node`;
  if (path.basename(resolvedEntry) !== expectedFileName) {
    throw new Error(`unexpected native platform entry for ${platformPackageName}: ${resolvedEntry}`);
  }

  const sourcePath = fs.realpathSync.native(resolvedEntry);
  const stats = fs.statSync(sourcePath);
  if (!stats.isFile() || stats.size <= 0) {
    throw new Error(`native platform entry is not a non-empty regular file: ${sourcePath}`);
  }

  const packageJsonPath = path.join(path.dirname(sourcePath), "package.json");
  const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    name?: string;
    version?: string;
  };
  if (parsed.name !== platformPackageName || !parsed.version) {
    throw new Error(`invalid native platform package metadata: ${packageJsonPath}`);
  }
  return { sourcePath, packageVersion: parsed.version };
}

export function loadNativeBinding<T>(options: BindingLoaderOptions): NativeBindingLoadResult<T> {
  const localBinary = findLocalNativeBinary(options.localPackageRoot);
  const localTarget = currentNativeTargetSuffix();
  let lastError: unknown;

  if (localBinary) {
    try {
      return {
        binding: options.requireFn(localBinary) as T,
        origin: {
          mode: "workspace",
          packageName: options.packageName,
          ...(localTarget ? { target: localTarget } : {}),
          sourcePath: normalizePathForDisplay(localBinary),
          loadedPath: normalizePathForDisplay(localBinary),
        },
      };
    } catch (error) {
      lastError = error;
    }
  }

  const packageEntry = (() => {
    if (!options.resolveFn) return null;
    try {
      return options.resolveFn(options.packageName);
    } catch {
      return null;
    }
  })();

  if (packageEntry && isWithinDirectory(packageEntry, options.localPackageRoot)) {
    return {
      binding: null,
      error: lastError ?? new Error("local workspace native addon is not built; run `npm run build:native`"),
      origin: {
        mode: "workspace",
        packageName: options.packageName,
        ...(localTarget ? { target: localTarget } : {}),
      },
    };
  }

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = nativeTargetSuffixFor(platform, arch);
  let installedSourcePath: string | undefined;
  let installedPackageVersion: string | undefined;
  let cacheError: string | undefined;

  if (platform === "win32" && target && options.resolveFn) {
    try {
      const platformPackage = readPlatformPackage(options.packageName, target, options.resolveFn);
      installedSourcePath = platformPackage.sourcePath;
      installedPackageVersion = platformPackage.packageVersion;
      const cached = prepareNativeRuntimeCache({
        sourcePath: platformPackage.sourcePath,
        packageName: `${options.packageName}-${target}`,
        packageVersion: platformPackage.packageVersion,
        target,
        cacheRoot: options.cacheRoot,
      });
      if (cached.status === "unavailable") {
        cacheError = cached.error.message;
      } else {
        try {
          return {
            binding: options.requireFn(cached.loadedPath) as T,
            origin: {
              mode: "cache",
              packageName: `${options.packageName}-${target}`,
              packageVersion: platformPackage.packageVersion,
              target,
              sourcePath: normalizePathForDisplay(cached.sourcePath),
              loadedPath: normalizePathForDisplay(cached.loadedPath),
              cacheKey: cached.cacheKey,
              sha256: cached.sha256,
            },
          };
        } catch (error) {
          cacheError = `cached native addon failed to load: ${error instanceof Error ? error.message : String(error)}`;
          lastError = error;
        }
      }
    } catch (error) {
      cacheError = error instanceof Error ? error.message : String(error);
    }
  }

  const packageOrigin: NativeBindingOrigin = {
    mode: "package",
    packageName: options.packageName,
    ...(installedPackageVersion ? { packageVersion: installedPackageVersion } : {}),
    ...(target ? { target } : {}),
    ...(installedSourcePath ? { sourcePath: normalizePathForDisplay(installedSourcePath) } : {}),
    ...(packageEntry ? { loadedPath: normalizePathForDisplay(packageEntry) } : {}),
    ...(cacheError ? { cacheError } : {}),
  };
  try {
    return {
      binding: options.requireFn(options.packageName) as T,
      origin: packageOrigin,
    };
  } catch (error) {
    return {
      binding: null,
      error: error ?? lastError,
      origin: packageOrigin,
    };
  }
}
