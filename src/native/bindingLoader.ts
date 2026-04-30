import fs from "node:fs";
import path from "node:path";

export type NativeBindingLoadResult<T> = { binding: T; error?: undefined } | { binding: null; error?: unknown };

type BindingLoaderOptions = {
  packageName: string;
  localPackageRoot: string;
  requireFn: (specifier: string) => unknown;
  resolveFn?: ((specifier: string) => string) | undefined;
};

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
  try {
    const entries = fs.readdirSync(packageRoot, { withFileTypes: true });
    const binary = entries.find((entry) => entry.isFile() && entry.name.endsWith(".node"));
    return binary ? path.join(packageRoot, binary.name) : null;
  } catch {
    return null;
  }
}

export function loadNativeBinding<T>(options: BindingLoaderOptions): NativeBindingLoadResult<T> {
  const localBinary = findLocalNativeBinary(options.localPackageRoot);
  let lastError: unknown;

  if (localBinary) {
    try {
      return {
        binding: options.requireFn(localBinary) as T,
      };
    } catch (error) {
      lastError = error;
    }
  }

  const packageEntry = (() => {
    if (!options.resolveFn) {
      return null;
    }
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
    };
  }

  try {
    return {
      binding: options.requireFn(options.packageName) as T,
    };
  } catch (error) {
    return {
      binding: null,
      error: error ?? lastError,
    };
  }
}
