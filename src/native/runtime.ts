import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { stringifyUnknown } from "../util.js";
import { loadNativeBinding } from "./bindingLoader.js";
import type { NativeBinding, NativeBindingState, NativeRuntimeMode } from "./contracts.js";

const require = createRequire(import.meta.url);
const localNativePackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../packages/codegraph-native",
);

const NATIVE_REQUIRED_ERROR_PREFIX = "native tree-sitter required by explicit option but unavailable";

let bindingState: NativeBindingState | undefined;

export function __resetNativeTreeSitterBindingForTests(): void {
  bindingState = undefined;
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
    };
    return bindingState;
  }
  bindingState = { loaded: false, error: loaded.error };
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

export function isNativeTreeSitterAvailable(mode?: NativeRuntimeMode): boolean {
  return resolveNativeBindingState(mode).loaded;
}

export function getNativeTreeSitterLoadError(mode?: NativeRuntimeMode): unknown {
  const state = resolveNativeBindingState(mode);
  return state.loaded ? undefined : state.error;
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

export function isNativeBindingLoadedForLanguage(languageId: string, mode?: NativeRuntimeMode): boolean {
  const state = resolveNativeBindingState(mode);
  return state.loaded && state.supportedLanguageIds.has(languageId);
}
