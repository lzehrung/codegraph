import { describe, test, expect } from "vitest";
import {
  getBuildPreset,
  getImpactPreset,
  getSessionPreset,
  mergePreset,
  BUILD_PRESETS,
  IMPACT_PRESETS,
  SESSION_PRESETS,
} from "../src/presets.js";

describe("Presets", () => {
  describe("getBuildPreset", () => {
    test("should return code-review preset", () => {
      const preset = getBuildPreset("code-review");

      expect(preset.cache).toBe("disk");
      expect(preset.cacheStrict).toBe(true);
      expect(preset.useBloomFilters).toBe(true);
      expect(preset.threads).toBe(8);
      expect(preset.graph?.fast).toBe(false);
    });

    test("should return ci-fast preset", () => {
      const preset = getBuildPreset("ci-fast");

      expect(preset.cache).toBe("memory");
      expect(preset.cacheStrict).toBe(false);
      expect(preset.useBloomFilters).toBe(true);
      expect(preset.threads).toBe(4);
      expect(preset.graph?.fast).toBe(true);
    });

    test("should return development preset", () => {
      const preset = getBuildPreset("development");

      expect(preset.cache).toBe("memory");
      expect(preset.cacheStrict).toBe(false);
      expect(preset.useBloomFilters).toBe(true);
      expect(preset.threads).toBe(8);
    });

    test("should return production preset", () => {
      const preset = getBuildPreset("production");

      expect(preset.cache).toBe("disk");
      expect(preset.cacheStrict).toBe(true);
      expect(preset.useBloomFilters).toBe(true);
      expect(preset.threads).toBe(16);
      expect(preset.graph?.fast).toBe(false);
    });

    test("should return a copy (not reference)", () => {
      const preset1 = getBuildPreset("code-review");
      const preset2 = getBuildPreset("code-review");

      expect(preset1).not.toBe(preset2);
      expect(preset1).toEqual(preset2);
    });
  });

  describe("getImpactPreset", () => {
    test("should return code-review impact preset", () => {
      const preset = getImpactPreset("code-review");

      expect(preset.depth).toBe(2);
      expect(preset.maxRefs).toBe(1000);
      expect(preset.includeTests).toBe(false);
      expect(preset.scope).toBe("all");
      expect(preset.refContext).toBe("line");
      expect(preset.verifyReferences).toBe(true);
    });

    test("should return ci-fast impact preset", () => {
      const preset = getImpactPreset("ci-fast");

      expect(preset.depth).toBe(1);
      expect(preset.maxRefs).toBe(500);
      expect(preset.scope).toBe("imported");
      expect(preset.refContext).toBeUndefined();
      expect(preset.verifyReferences).toBe(false);
    });

    test("should return production impact preset", () => {
      const preset = getImpactPreset("production");

      expect(preset.depth).toBe(3);
      expect(preset.maxRefs).toBe(2000);
      expect(preset.includeTests).toBe(true);
      expect(preset.refContext).toBe("block");
      expect(preset.verifyReferences).toBe(true);
    });
  });

  describe("getSessionPreset", () => {
    test("should return code-review session preset", () => {
      const preset = getSessionPreset("code-review", "/path/to/repo");

      expect(preset.root).toBe("/path/to/repo");
      expect(preset.timeout).toBe(30 * 60 * 1000);
      expect(preset.incremental).toBe(true);
      expect(preset.buildOptions).toEqual(BUILD_PRESETS["code-review"]);
    });

    test("should return ci-fast session preset", () => {
      const preset = getSessionPreset("ci-fast", "/path/to/repo");

      expect(preset.root).toBe("/path/to/repo");
      expect(preset.timeout).toBe(10 * 60 * 1000);
      expect(preset.incremental).toBe(false);
    });
  });

  describe("mergePreset", () => {
    test("should merge custom options with preset", () => {
      const preset = BUILD_PRESETS["code-review"];
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

    test("should deep merge nested objects", () => {
      const preset = BUILD_PRESETS["code-review"];
      const custom = {
        graph: {
          fast: true,
        },
      };

      const merged = mergePreset(preset, custom);

      expect(merged.graph?.fast).toBe(true);
      expect(merged.graph?.resolveNodeModules).toBe(preset.graph?.resolveNodeModules);
    });

    test("should handle undefined custom options", () => {
      const preset = BUILD_PRESETS["code-review"];

      const merged = mergePreset(preset, undefined);

      expect(merged).toEqual(preset);
    });

    test("should ignore undefined values in custom", () => {
      const preset = BUILD_PRESETS["code-review"];
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
    test("all presets should have required fields", () => {
      const presetNames: Array<keyof typeof BUILD_PRESETS> = ["code-review", "ci-fast", "development", "production"];

      for (const name of presetNames) {
        const buildPreset = BUILD_PRESETS[name];
        expect(buildPreset.cache).toBeDefined();
        expect(buildPreset.threads).toBeGreaterThan(0);

        const impactPreset = IMPACT_PRESETS[name];
        expect(impactPreset.depth).toBeGreaterThan(0);
        expect(impactPreset.maxRefs).toBeGreaterThan(0);

        const sessionPreset = SESSION_PRESETS[name];
        expect(sessionPreset.timeout).toBeGreaterThan(0);
        expect(sessionPreset.incremental).toBeDefined();
      }
    });

    test("ci-fast should be faster than production", () => {
      const ciFast = BUILD_PRESETS["ci-fast"];
      const production = BUILD_PRESETS["production"];

      // CI should use fewer threads (less I/O bottleneck)
      expect(ciFast.threads).toBeLessThan(production.threads!);

      // CI should use fast mode
      expect(ciFast.graph?.fast).toBe(true);
      expect(production.graph?.fast).toBe(false);

      // CI should use less strict caching
      expect(ciFast.cacheStrict).toBe(false);
      expect(production.cacheStrict).toBe(true);
    });

    test("production should be most thorough", () => {
      const production = BUILD_PRESETS["production"];
      const impactProduction = IMPACT_PRESETS["production"];

      expect(production.cacheStrict).toBe(true);
      expect(production.graph?.fast).toBe(false);

      expect(impactProduction.depth).toBeGreaterThanOrEqual(3);
      expect(impactProduction.verifyReferences).toBe(true);
      expect(impactProduction.includeTests).toBe(true);
    });
  });
});
