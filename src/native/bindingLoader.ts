import fs from "node:fs";
import path from "node:path";

import { normalizePath } from "../util/paths.js";
import { errorMessage } from "../util/errors.js";

import type { NativeBindingOrigin } from "./contracts.js";
import { prepareNativeRuntimeCache } from "./runtimeCache.js";

/**
 * Raw (un-normalized) paths for a load that came from the Windows runtime cache, plus whether
 * this process verified them by hashing. The caller records these once it can also supply the
 * addon's supported languages, which only exist after the binding loads.
 */
export type NativeBindingCacheEntry = {
  sourcePath: string;
  loadedPath: string;
  cacheKey: string;
  sha256: string;
  sourceSize: number;
  sourceMtimeMs: number;
  cachedSize: number;
  cachedMtimeMs: number;
  verified: boolean;
};

export type NativeBindingLoadResult<T> =
  | { binding: T; error?: undefined; origin: NativeBindingOrigin; cacheEntry?: NativeBindingCacheEntry }
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

/**
 * Locate the installed platform package's binary and version without loading it.
 *
 * Exported so the runtime fingerprint can find the matching cache entry on a warm run; it
 * costs a resolve, a realpath, a stat, and a small JSON read, none of which map the addon.
 */
export function readPlatformPackage(
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
          sourcePath: normalizePath(localBinary),
          loadedPath: normalizePath(localBinary),
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

  if (target && options.resolveFn) {
    try {
      const platformPackage = readPlatformPackage(options.packageName, target, options.resolveFn);
      installedSourcePath = platformPackage.sourcePath;
      installedPackageVersion = platformPackage.packageVersion;
    } catch (error) {
      if (platform === "win32") {
        cacheError = errorMessage(error);
      }
    }
  }

  if (platform === "win32" && target && installedSourcePath && installedPackageVersion) {
    const cached = prepareNativeRuntimeCache({
      sourcePath: installedSourcePath,
      packageName: `${options.packageName}-${target}`,
      packageVersion: installedPackageVersion,
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
            packageVersion: installedPackageVersion,
            target,
            sourcePath: normalizePath(cached.sourcePath),
            loadedPath: normalizePath(cached.loadedPath),
            cacheKey: cached.cacheKey,
            sha256: cached.sha256,
          },
          cacheEntry: {
            sourcePath: cached.sourcePath,
            loadedPath: cached.loadedPath,
            cacheKey: cached.cacheKey,
            sha256: cached.sha256,
            sourceSize: cached.sourceSize,
            sourceMtimeMs: cached.sourceMtimeMs,
            cachedSize: cached.cachedSize,
            cachedMtimeMs: cached.cachedMtimeMs,
            verified: cached.verified,
          },
        };
      } catch (error) {
        cacheError = `cached native addon failed to load: ${errorMessage(error)}`;
        lastError = error;
      }
    }
  }

  let originPackageName = options.packageName;
  let originLoadedPath = packageEntry;
  if (target && installedSourcePath && installedPackageVersion) {
    originPackageName = `${options.packageName}-${target}`;
    originLoadedPath = installedSourcePath;
  }

  const packageOrigin: NativeBindingOrigin = {
    mode: "package",
    packageName: originPackageName,
    ...(installedPackageVersion ? { packageVersion: installedPackageVersion } : {}),
    ...(target ? { target } : {}),
    ...(installedSourcePath ? { sourcePath: normalizePath(installedSourcePath) } : {}),
    ...(originLoadedPath ? { loadedPath: normalizePath(originLoadedPath) } : {}),
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
