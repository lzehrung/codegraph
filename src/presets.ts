/**
 * Presets for common workflows
 *
 * Simplifies the API by providing pre-configured options for typical use cases:
 * - code-review: Balanced speed/accuracy for PR reviews
 * - ci-fast: Maximum speed for CI/CD pipelines
 * - development: Fast feedback for local development
 * - production: Maximum accuracy for production analysis
 */

import type { BuildOptions } from "./indexer.js";
import type { ImpactOptions } from "./impact/types.js";
import type { SessionOptions } from "./session.js";

export type PresetName = "code-review" | "ci-fast" | "development" | "production";

/**
 * Build option presets
 */
export const BUILD_PRESETS: Record<PresetName, BuildOptions> = {
  /**
   * Code Review preset
   * - Balanced speed and accuracy
   * - Incremental caching enabled
   * - Bloom filters for fast reference scanning
   * - Content-hash for reliability
   */
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

  /**
   * CI Fast preset
   * - Maximum speed for CI/CD
   * - Memory cache only (no disk I/O)
   * - Fast graph mode
   * - Fewer threads to avoid I/O bottlenecks
   */
  "ci-fast": {
    cache: "memory",
    cacheStrict: false, // mtime is faster
    useBloomFilters: true,
    threads: 4,
    graph: {
      fast: true, // Use regex-based extraction for JS/TS
      resolveNodeModules: false,
    },
  },

  /**
   * Development preset
   * - Fast feedback for local development
   * - Memory cache for speed
   * - Bloom filters enabled
   * - No strict caching (faster)
   */
  "development": {
    cache: "memory",
    cacheStrict: false,
    useBloomFilters: true,
    threads: 8,
    graph: {
      fast: false,
      resolveNodeModules: false,
    },
  },

  /**
   * Production preset
   * - Maximum accuracy
   * - Disk cache with strict validation
   * - Full parsing (no fast mode)
   * - More threads for thoroughness
   */
  "production": {
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
 * Impact analysis presets
 */
export const IMPACT_PRESETS: Record<
  PresetName,
  Partial<ImpactOptions>
> = {
  "code-review": {
    depth: 2,
    maxRefs: 1000,
    includeTests: false,
    scope: "all",
    refContext: "line",
    refContextLines: 3,
    verifyReferences: true,
  },

  "ci-fast": {
    depth: 1,
    maxRefs: 500,
    includeTests: false,
    scope: "imported", // Only exported symbols
    // No context snippets - don't set refContext
    verifyReferences: false,
  },

  "development": {
    depth: 2,
    maxRefs: 500,
    includeTests: true,
    scope: "all",
    refContext: "line",
    refContextLines: 3,
    verifyReferences: false,
  },

  "production": {
    depth: 3,
    maxRefs: 2000,
    includeTests: true,
    scope: "all",
    refContext: "block",
    refBlockMaxLines: 30,
    verifyReferences: true,
  },
};

/**
 * Session presets
 */
export const SESSION_PRESETS: Record<
  PresetName,
  Omit<SessionOptions, "root">
> = {
  "code-review": {
    buildOptions: BUILD_PRESETS["code-review"],
    timeout: 30 * 60 * 1000, // 30 minutes
    incremental: true,
  },

  "ci-fast": {
    buildOptions: BUILD_PRESETS["ci-fast"],
    timeout: 10 * 60 * 1000, // 10 minutes
    incremental: false, // Full rebuild for CI
  },

  "development": {
    buildOptions: BUILD_PRESETS["development"],
    timeout: 60 * 60 * 1000, // 1 hour
    incremental: true,
  },

  "production": {
    buildOptions: BUILD_PRESETS["production"],
    timeout: 2 * 60 * 60 * 1000, // 2 hours
    incremental: true,
  },
};

/**
 * Get build options for a preset
 */
export function getBuildPreset(preset: PresetName): BuildOptions {
  return { ...BUILD_PRESETS[preset] };
}

/**
 * Get impact options for a preset
 */
export function getImpactPreset(
  preset: PresetName,
): Partial<ImpactOptions> {
  return { ...IMPACT_PRESETS[preset] };
}

/**
 * Get session options for a preset
 */
export function getSessionPreset(
  preset: PresetName,
  root: string,
): SessionOptions {
  return {
    root,
    ...SESSION_PRESETS[preset],
  };
}

/**
 * Merge preset with custom options
 */
export function mergePreset<T extends Record<string, unknown>>(
  preset: T,
  custom?: Partial<T>,
): T {
  if (!custom) return preset;

  const merged: Record<string, unknown> = { ...preset };
  const presetRecord = preset as Record<string, unknown>;

  for (const key of Object.keys(custom)) {
    const customValue = custom[key as keyof T];
    const presetValue = presetRecord[key];

    if (customValue === undefined) continue;

    // Deep merge for nested objects
    if (
      isPlainObject(customValue) &&
      isPlainObject(presetValue)
    ) {
      merged[key] = { ...presetValue, ...customValue };
    } else {
      merged[key] = customValue;
    }
  }

  return merged as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
