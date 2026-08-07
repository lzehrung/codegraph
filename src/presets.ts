/**
 * Session preset helpers for common Codegraph workflows.
 *
 * These presets remain part of the library session API and preconfigure
 * build options plus timeout and incremental defaults for:
 * - code-review
 * - ci-fast
 * - development
 * - production
 */

import { type BuildOptions } from "./indexer/types.js";
import { isPlainRecord } from "./util/guards.js";

export type PresetName = "code-review" | "ci-fast" | "development" | "production";

export type SessionPresetOptions = {
  buildOptions?: BuildOptions;
  timeout?: number;
  incremental?: boolean;
};

/**
 * Internal build option presets used by the public session presets.
 */
const SESSION_BUILD_PRESETS: Record<PresetName, BuildOptions> = {
  "code-review": {
    cache: "disk",
    cacheStrict: true,
    useBloomFilters: true,
    threads: 8,
    graph: {
      fast: false,
      resolveNodeModules: false,
    },
  },

  "ci-fast": {
    cache: "memory",
    cacheStrict: false,
    useBloomFilters: true,
    threads: 4,
    graph: {
      fast: true,
      resolveNodeModules: false,
    },
  },

  development: {
    cache: "memory",
    cacheStrict: false,
    useBloomFilters: true,
    threads: 8,
    graph: {
      fast: false,
      resolveNodeModules: false,
    },
  },

  production: {
    cache: "disk",
    cacheStrict: true,
    useBloomFilters: true,
    threads: 16,
    graph: {
      fast: false,
      resolveNodeModules: false,
      dynamicImportHeuristics: false,
    },
  },
};

/**
 * Session presets
 */
export const SESSION_PRESETS: Record<PresetName, SessionPresetOptions> = {
  "code-review": {
    buildOptions: SESSION_BUILD_PRESETS["code-review"],
    timeout: 30 * 60 * 1000,
    incremental: true,
  },

  "ci-fast": {
    buildOptions: SESSION_BUILD_PRESETS["ci-fast"],
    timeout: 10 * 60 * 1000,
    incremental: false,
  },

  development: {
    buildOptions: SESSION_BUILD_PRESETS["development"],
    timeout: 60 * 60 * 1000,
    incremental: true,
  },

  production: {
    buildOptions: SESSION_BUILD_PRESETS["production"],
    timeout: 2 * 60 * 60 * 1000,
    incremental: true,
  },
};

function cloneBuildOptions(options: BuildOptions | undefined): BuildOptions | undefined {
  if (!options) return undefined;
  return {
    ...options,
    ...(options.graph ? { graph: { ...options.graph } } : {}),
  };
}

/**
 * Get session options for a preset
 */
export function getSessionPreset(preset: PresetName, root: string): SessionPresetOptions & { root: string } {
  const sessionPreset = SESSION_PRESETS[preset];
  const buildOptions = cloneBuildOptions(sessionPreset.buildOptions);
  return {
    root,
    ...(sessionPreset.timeout !== undefined ? { timeout: sessionPreset.timeout } : {}),
    ...(sessionPreset.incremental !== undefined ? { incremental: sessionPreset.incremental } : {}),
    ...(buildOptions ? { buildOptions } : {}),
  };
}

/**
 * Merge preset with custom options
 */
export function mergePreset<T extends Record<string, unknown>>(preset: T, custom?: Partial<T>): T {
  if (!custom) return preset;

  const merged: Record<string, unknown> = { ...preset };
  const presetRecord = preset as Record<string, unknown>;

  for (const key of Object.keys(custom)) {
    const customValue = custom[key as keyof T];
    const presetValue = presetRecord[key];

    if (customValue === undefined) continue;

    if (isPlainRecord(customValue) && isPlainRecord(presetValue)) {
      merged[key] = { ...presetValue, ...customValue };
    } else {
      merged[key] = customValue;
    }
  }

  return merged as T;
}
