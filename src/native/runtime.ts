import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { stringifyUnknown } from "../util/ast.js";
import { loadNativeBinding } from "./bindingLoader.js";
import type { NativeBinding, NativeBindingOrigin, NativeBindingState, NativeRuntimeMode } from "./contracts.js";

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

export function __resetNativeTreeSitterBindingForTests(): void {
  bindingState = undefined;
  loadedRuntimeFingerprint = undefined;
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
  const loaded = loadNativeBinding<NativeBinding>({
    packageName: "@lzehrung/codegraph-native",
    localPackageRoot: localNativePackageRoot,
    requireFn: require,
    resolveFn: require.resolve,
  });
  if (loaded.binding) {
    bindingState = {
      loaded: true,
      binding: loaded.binding,
      supportedLanguageIds: new Set(loaded.binding.supportedLanguageIds()),
      origin: loaded.origin,
    };
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
function serializeNativeRuntimeFingerprint(
  requestedMode: NativeRuntimeMode,
  envDisabled: boolean,
  state: NativeBindingState,
): string {
  const supportedLanguageIds = state.loaded ? Array.from(state.supportedLanguageIds).sort() : [];
  const origin = state.origin;
  return JSON.stringify({
    version: 1,
    requestedMode,
    envDisabled,
    available: state.loaded,
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
      resolveNativeBindingState(mode, env),
    );
    disabledRuntimeFingerprints.set(key, fingerprint);
    return fingerprint;
  }

  const state = loadBinding();
  if (
    loadedRuntimeFingerprint?.state === state &&
    loadedRuntimeFingerprint.requestedMode === requestedMode &&
    loadedRuntimeFingerprint.envDisabled === envDisabled
  ) {
    return loadedRuntimeFingerprint.value;
  }
  const value = serializeNativeRuntimeFingerprint(requestedMode, envDisabled, state);
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
