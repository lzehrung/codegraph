import { describe, expect, test } from "vitest";
import { getSessionPreset, mergePreset, SESSION_PRESETS } from "../src/presets.js";

function getSessionBuildOptions(preset: keyof typeof SESSION_PRESETS) {
  const buildOptions = getSessionPreset(preset, "/path/to/repo").buildOptions;
  if (!buildOptions) {
    throw new Error(`Missing buildOptions for preset ${preset}`);
  }
  return buildOptions;
}

describe("Presets", () => {
  describe("getSessionPreset", () => {
    test("returns the code-review session preset", () => {
      const preset = getSessionPreset("code-review", "/path/to/repo");

      expect(preset.root).toBe("/path/to/repo");
      expect(preset.timeout).toBe(30 * 60 * 1000);
      expect(preset.incremental).toBe(true);
      expect(preset.buildOptions).toMatchObject({
        cache: "disk",
        cacheStrict: true,
        useBloomFilters: true,
        threads: 8,
        graph: {
          fast: false,
          resolveNodeModules: false,
        },
      });
    });

    test("returns the ci-fast session preset", () => {
      const preset = getSessionPreset("ci-fast", "/path/to/repo");

      expect(preset.root).toBe("/path/to/repo");
      expect(preset.timeout).toBe(10 * 60 * 1000);
      expect(preset.incremental).toBe(false);
      expect(preset.buildOptions).toMatchObject({
        cache: "memory",
        cacheStrict: false,
        useBloomFilters: true,
        threads: 4,
        graph: {
          fast: true,
          resolveNodeModules: false,
        },
      });
    });

    test("returns a defensive copy of build options", () => {
      const preset1 = getSessionPreset("code-review", "/path/to/repo");
      const preset2 = getSessionPreset("code-review", "/path/to/repo");

      expect(preset1).not.toBe(preset2);
      expect(preset1.buildOptions).not.toBe(preset2.buildOptions);
      expect(preset1.buildOptions).toEqual(preset2.buildOptions);
    });
  });

  describe("mergePreset", () => {
    test("merges custom options with preset defaults", () => {
      const preset = getSessionBuildOptions("code-review");
      const custom = {
        threads: 16,
        cache: "memory" as const,
      };

      const merged = mergePreset(preset, custom);

      expect(merged.threads).toBe(16);
      expect(merged.cache).toBe("memory");
      expect(merged.cacheStrict).toBe(preset.cacheStrict);
      expect(merged.useBloomFilters).toBe(preset.useBloomFilters);
    });

    test("deep merges nested graph options", () => {
      const preset = getSessionBuildOptions("code-review");
      const custom = {
        graph: {
          fast: true,
        },
      };

      const merged = mergePreset(preset, custom);

      expect(merged.graph?.fast).toBe(true);
      expect(merged.graph?.resolveNodeModules).toBe(preset.graph?.resolveNodeModules);
    });

    test("handles undefined custom options", () => {
      const preset = getSessionBuildOptions("code-review");

      const merged = mergePreset(preset, undefined);

      expect(merged).toEqual(preset);
    });

    test("ignores undefined override values", () => {
      const preset = getSessionBuildOptions("code-review");
      const custom = {
        threads: undefined,
        cache: "memory" as const,
      };

      const merged = mergePreset(preset, custom);

      expect(merged.threads).toBe(preset.threads);
      expect(merged.cache).toBe("memory");
    });
  });

  describe("Preset consistency", () => {
    test("all session presets have required fields", () => {
      const presetNames: Array<keyof typeof SESSION_PRESETS> = ["code-review", "ci-fast", "development", "production"];

      for (const name of presetNames) {
        const sessionPreset = SESSION_PRESETS[name];
        expect(sessionPreset.timeout).toBeGreaterThan(0);
        expect(sessionPreset.incremental).toBeDefined();
        expect(sessionPreset.buildOptions?.cache).toBeDefined();
        expect(sessionPreset.buildOptions?.threads).toBeGreaterThan(0);
      }
    });

    test("ci-fast remains lighter than production", () => {
      const ciFast = getSessionBuildOptions("ci-fast");
      const production = getSessionBuildOptions("production");

      expect(ciFast.threads).toBeLessThan(production.threads!);
      expect(ciFast.graph?.fast).toBe(true);
      expect(production.graph?.fast).toBe(false);
      expect(ciFast.cacheStrict).toBe(false);
      expect(production.cacheStrict).toBe(true);
    });
  });
});
