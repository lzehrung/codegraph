import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { stringifyUnknown } from "../util/ast.js";
import {
  currentNativeTargetSuffix,
  findLocalNativeBinary,
  loadNativeBinding,
  nativeTargetSuffixFor,
  readPlatformPackage,
} from "./bindingLoader.js";
import { lookupNativeRuntimeCacheEntry, recordNativeRuntimeCacheIdentity } from "./runtimeCache.js";
import { markWindowsProcessDrainRequired } from "../util/windowsProcessDrain.js";
import type {
  NativeBinding,
  NativeBindingOrigin,
  NativeBindingState,
  NativeRuntimeMode,
  NativeWorkerBindingHandoff,
} from "./contracts.js";

const require = createRequire(import.meta.url);
const localNativePackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../packages/codegraph-native",
);

const NATIVE_REQUIRED_ERROR_PREFIX = "native tree-sitter required by explicit option but unavailable";

let bindingState: NativeBindingState | undefined;
let loadedRuntimeFingerprint:
  | {
      state: NativeBindingState;
      requestedMode: NativeRuntimeMode;
      envDisabled: boolean;
      value: string;
    }
  | undefined;
const disabledRuntimeFingerprints = new Map<string, string>();
type CachedRuntimeFingerprintValidation = {
  sourcePath: string;
  sourceSize: number;
  sourceMtimeMs: number;
  loadedPath: string;
  cachedSize: number;
  cachedMtimeMs: number;
};

type CachedRuntimeFingerprint = {
  value: string;
  revalidateAt: number;
  validation: CachedRuntimeFingerprintValidation;
};

const cachedRuntimeFingerprints = new Map<string, CachedRuntimeFingerprint>();
const cachedRuntimeIdentityValidations = new WeakMap<NativeRuntimeIdentity, CachedRuntimeFingerprintValidation>();

export function __resetNativeTreeSitterBindingForTests(): void {
  bindingState = undefined;
  loadedRuntimeFingerprint = undefined;
  cachedRuntimeFingerprints.clear();
}

export function isNativeTreeSitterDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const rawValue = env.CODEGRAPH_DISABLE_NATIVE;
  if (typeof rawValue !== "string") {
    return false;
  }
  const normalized = rawValue.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function normalizeNativeRuntimeMode(mode?: NativeRuntimeMode): NativeRuntimeMode {
  return mode ?? "auto";
}

export function loadBinding(): NativeBindingState {
  if (bindingState) return bindingState;
  cachedRuntimeFingerprints.clear();
  const loaded = loadNativeBinding<NativeBinding>({
    packageName: "@lzehrung/codegraph-native",
    localPackageRoot: localNativePackageRoot,
    requireFn: require,
    resolveFn: require.resolve,
  });
  if (loaded.binding) {
    const supportedLanguageIds = new Set(loaded.binding.supportedLanguageIds());
    markWindowsProcessDrainRequired();
    bindingState = {
      loaded: true,
      binding: loaded.binding,
      supportedLanguageIds,
      origin: loaded.origin,
    };
    // Now, and only now, every fact a later process needs to skip this work is known: the files
    // were hashed and verified, the addon loaded, and it reported its languages. Recording only
    // a verified load keeps the re-verification TTL honest - a fast-path hit must not renew it.
    if (loaded.cacheEntry?.verified) {
      recordNativeRuntimeCacheIdentity({
        sourcePath: loaded.cacheEntry.sourcePath,
        loadedPath: loaded.cacheEntry.loadedPath,
        cacheKey: loaded.cacheEntry.cacheKey,
        sha256: loaded.cacheEntry.sha256,
        sourceSize: loaded.cacheEntry.sourceSize,
        sourceMtimeMs: loaded.cacheEntry.sourceMtimeMs,
        cachedSize: loaded.cacheEntry.cachedSize,
        cachedMtimeMs: loaded.cacheEntry.cachedMtimeMs,
        verifiedAt: new Date().toISOString(),
        supportedLanguageIds: Array.from(supportedLanguageIds).sort(),
        origin: loaded.origin,
      });
    }
    return bindingState;
  }
  bindingState = {
    loaded: false,
    error: loaded.error,
    ...(loaded.origin ? { origin: loaded.origin } : {}),
  };
  return bindingState;
}

export function resolveNativeBindingState(
  mode?: NativeRuntimeMode,
  env: NodeJS.ProcessEnv = process.env,
): NativeBindingState {
  const normalizedMode = normalizeNativeRuntimeMode(mode);
  if (normalizedMode === "off") {
    return {
      loaded: false,
      error: new Error("native tree-sitter disabled by explicit option"),
    };
  }
  if (normalizedMode === "auto" && isNativeTreeSitterDisabledByEnv(env)) {
    return {
      loaded: false,
      error: new Error("native tree-sitter disabled by CODEGRAPH_DISABLE_NATIVE"),
    };
  }
  return loadBinding();
}
/**
 * The binding-derived half of the runtime fingerprint: everything the serializer reads that a
 * full addon load would otherwise be needed to obtain.
 */
export type NativeRuntimeIdentity = {
  available: boolean;
  supportedLanguageIds: string[];
  origin: NativeBindingOrigin | undefined;
  /** Cache-only deadline; omitted for identities obtained from a loaded binding. */
  cacheIdentityRevalidateAt?: number | undefined;
};

function identityFromState(state: NativeBindingState): NativeRuntimeIdentity {
  return {
    available: state.loaded,
    supportedLanguageIds: state.loaded ? Array.from(state.supportedLanguageIds).sort() : [],
    origin: state.origin,
  };
}

function cacheFingerprintFilesMatch(validation: CachedRuntimeFingerprintValidation): boolean {
  try {
    const sourcePath = fs.realpathSync.native(validation.sourcePath);
    if (sourcePath !== validation.sourcePath) return false;
    const sourceStats = fs.statSync(sourcePath);
    if (
      !sourceStats.isFile() ||
      sourceStats.size !== validation.sourceSize ||
      sourceStats.mtimeMs !== validation.sourceMtimeMs
    ) {
      return false;
    }

    const loadedPath = fs.realpathSync.native(validation.loadedPath);
    if (loadedPath !== validation.loadedPath) return false;
    const cachedStats = fs.lstatSync(loadedPath);
    return (
      cachedStats.isFile() &&
      !cachedStats.isSymbolicLink() &&
      cachedStats.size === validation.cachedSize &&
      cachedStats.mtimeMs === validation.cachedMtimeMs
    );
  } catch {
    return false;
  }
}

/**
 * Takes the binding-derived facts rather than a NativeBindingState, because the cache fast path
 * below reconstructs those facts from a recorded identity and has no binding to hand.
 */
export function serializeNativeRuntimeFingerprint(
  requestedMode: NativeRuntimeMode,
  envDisabled: boolean,
  identity: NativeRuntimeIdentity,
): string {
  const { available, supportedLanguageIds, origin } = identity;
  return JSON.stringify({
    version: 1,
    requestedMode,
    envDisabled,
    available,
    supportedLanguageIds,
    ...(origin
      ? {
          origin: {
            mode: origin.mode,
            packageName: origin.packageName,
            ...(origin.packageVersion ? { packageVersion: origin.packageVersion } : {}),
            ...(origin.target ? { target: origin.target } : {}),
            ...(origin.sourcePath ? { sourcePath: origin.sourcePath } : {}),
            ...(origin.loadedPath ? { loadedPath: origin.loadedPath } : {}),
            ...(origin.cacheKey ? { cacheKey: origin.cacheKey } : {}),
            ...(origin.sha256 ? { sha256: origin.sha256 } : {}),
          },
        }
      : {}),
  });
}

/**
 * Rebuild the binding-derived half of the fingerprint from a recorded cache identity, without
 * mapping the addon.
 *
 * Every caller of getNativeRuntimeFingerprint reaches it to decide whether an on-disk index is
 * still valid, which is why a command that only reads a warm cache used to pay a full native
 * load to prove it did not need one. A recorded identity supplies the two things the load was
 * for - the supported language list and the binding origin - and stores the origin whole, so
 * the string produced here is the same one a load produces.
 *
 * Returns undefined whenever anything is unproven: a workspace checkout (which resolves its own
 * binary and never populates the cache), a platform without the runtime cache, an unresolvable
 * platform package, or no identity record that still matches the files on disk.
 */
export type CachedRuntimeIdentityOptions = {
  /** Injected in tests; the runtime cache exists only on Windows. */
  platform?: NodeJS.Platform | undefined;
  arch?: string | undefined;
  localPackageRoot?: string | undefined;
  resolveFn?: ((specifier: string) => string) | undefined;
  cacheRoot?: string | undefined;
  now?: number | undefined;
};

export function resolveCachedRuntimeIdentity(
  options: CachedRuntimeIdentityOptions = {},
): NativeRuntimeIdentity | undefined {
  // A workspace binary wins in loadNativeBinding, so its fingerprint must not be answered from
  // a cache entry describing the installed package.
  if (findLocalNativeBinary(options.localPackageRoot ?? localNativePackageRoot)) return undefined;
  if ((options.platform ?? process.platform) !== "win32") return undefined;

  // currentNativeTargetSuffix reads the real process; when a platform is injected the suffix has
  // to be derived from it, or a Linux test box would look for its own target under a win32 root.
  const target = options.platform
    ? nativeTargetSuffixFor(options.platform, options.arch ?? process.arch)
    : currentNativeTargetSuffix();
  if (!target) return undefined;

  try {
    const platformPackage = readPlatformPackage(
      "@lzehrung/codegraph-native",
      target,
      options.resolveFn ?? require.resolve,
    );
    const hit = lookupNativeRuntimeCacheEntry({
      sourcePath: platformPackage.sourcePath,
      packageName: `@lzehrung/codegraph-native-${target}`,
      packageVersion: platformPackage.packageVersion,
      target,
      ...(options.cacheRoot !== undefined ? { cacheRoot: options.cacheRoot } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    if (!hit) return undefined;
    const identity: NativeRuntimeIdentity = {
      available: true,
      supportedLanguageIds: hit.identity.supportedLanguageIds,
      origin: hit.identity.origin,
      cacheIdentityRevalidateAt: hit.revalidateAt,
    };
    cachedRuntimeIdentityValidations.set(identity, {
      sourcePath: hit.identity.sourcePath,
      sourceSize: hit.identity.sourceSize,
      sourceMtimeMs: hit.identity.sourceMtimeMs,
      loadedPath: hit.identity.loadedPath,
      cachedSize: hit.identity.cachedSize,
      cachedMtimeMs: hit.identity.cachedMtimeMs,
    });
    return identity;
  } catch {
    return undefined;
  }
}

export function getNativeRuntimeFingerprint(mode?: NativeRuntimeMode, env: NodeJS.ProcessEnv = process.env): string {
  const requestedMode = normalizeNativeRuntimeMode(mode);
  const envDisabled = isNativeTreeSitterDisabledByEnv(env);
  const runtimeDisabled = requestedMode === "off" || (requestedMode === "auto" && envDisabled);
  if (runtimeDisabled) {
    const key = `${requestedMode}:${envDisabled}`;
    const cached = disabledRuntimeFingerprints.get(key);
    if (cached) return cached;
    const fingerprint = serializeNativeRuntimeFingerprint(
      requestedMode,
      envDisabled,
      identityFromState(resolveNativeBindingState(mode, env)),
    );
    disabledRuntimeFingerprints.set(key, fingerprint);
    return fingerprint;
  }

  // A cached identity is valid only while its current source and cache stats match and its
  // re-verification window has not elapsed. Recheck it on every fingerprint request; the probe
  // stays cheap (one directory read and two stats) and avoids extending stat-only trust.
  if (!bindingState) {
    const cacheKey = `${requestedMode}:${envDisabled}`;
    const now = Date.now();
    const memoized = cachedRuntimeFingerprints.get(cacheKey);
    if (memoized && now < memoized.revalidateAt && cacheFingerprintFilesMatch(memoized.validation)) {
      return memoized.value;
    }

    const cachedIdentity = resolveCachedRuntimeIdentity();
    const validation = cachedIdentity ? cachedRuntimeIdentityValidations.get(cachedIdentity) : undefined;
    if (
      cachedIdentity?.cacheIdentityRevalidateAt !== undefined &&
      validation &&
      cacheFingerprintFilesMatch(validation)
    ) {
      const value = serializeNativeRuntimeFingerprint(requestedMode, envDisabled, cachedIdentity);
      cachedRuntimeFingerprints.set(cacheKey, {
        value,
        revalidateAt: cachedIdentity.cacheIdentityRevalidateAt,
        validation,
      });
      return value;
    }
    cachedRuntimeFingerprints.delete(cacheKey);
  }

  const state = loadBinding();
  if (
    loadedRuntimeFingerprint?.state === state &&
    loadedRuntimeFingerprint.requestedMode === requestedMode &&
    loadedRuntimeFingerprint.envDisabled === envDisabled
  ) {
    return loadedRuntimeFingerprint.value;
  }
  const value = serializeNativeRuntimeFingerprint(requestedMode, envDisabled, identityFromState(state));
  loadedRuntimeFingerprint = { state, requestedMode, envDisabled, value };
  return value;
}

export function isNativeTreeSitterAvailable(mode?: NativeRuntimeMode): boolean {
  return resolveNativeBindingState(mode).loaded;
}

export function getNativeTreeSitterLoadError(mode?: NativeRuntimeMode): unknown {
  const state = resolveNativeBindingState(mode);
  return state.loaded ? undefined : state.error;
}

export function getNativeBindingOrigin(): NativeBindingOrigin | undefined {
  return resolveNativeBindingState().origin;
}

export function getCurrentNativeBindingOrigin(): NativeBindingOrigin | undefined {
  return bindingState?.origin;
}

/**
 * The resolved addon path for a binding this process has already loaded, for handing to worker
 * threads. Undefined unless a load succeeded, so a worker is never pointed at a path that did
 * not work here.
 */
export function getNativeWorkerBindingHandoff(): NativeWorkerBindingHandoff | undefined {
  if (!bindingState?.loaded) return undefined;
  const loadedPath = bindingState.origin.loadedPath;
  if (!loadedPath) return undefined;
  return { loadedPath, origin: bindingState.origin };
}

export function getNativeTreeSitterSupportedLanguageIds(mode?: NativeRuntimeMode): string[] {
  const state = resolveNativeBindingState(mode);
  return state.loaded ? Array.from(state.supportedLanguageIds).sort() : [];
}

export function isNativeRequiredUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(NATIVE_REQUIRED_ERROR_PREFIX);
}

export function throwIfNativeRequiredUnavailable(mode: NativeRuntimeMode | undefined, state: NativeBindingState): void {
  if (normalizeNativeRuntimeMode(mode) !== "on" || state.loaded) return;
  const suffix = state.error ? `: ${stringifyUnknown(state.error)}` : "";
  throw new Error(`${NATIVE_REQUIRED_ERROR_PREFIX}${suffix}`);
}

export function assertNativeRequiredAvailable(mode: NativeRuntimeMode | undefined): void {
  if (normalizeNativeRuntimeMode(mode) !== "on") return;
  const state = resolveNativeBindingState(mode);
  throwIfNativeRequiredUnavailable(mode, state);
}

export function isNativeBindingLoadedForLanguage(languageId: string, mode?: NativeRuntimeMode): boolean {
  const state = resolveNativeBindingState(mode);
  return state.loaded && state.supportedLanguageIds.has(languageId);
}
