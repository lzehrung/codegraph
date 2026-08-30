import fs from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  DUPLICATE_IDENTIFIER_RANGES_TARGET,
  collectDuplicateIdentifierRanges,
  renderDuplicateIdentifierRanges,
} from "../scripts/generate-duplicate-identifier-ranges-lib.mjs";
import { getNativeDuplicateTokens, isNativeDuplicateTokenizationAvailable } from "../src/native/treeSitterNative.js";

const nativeAvailable = isNativeDuplicateTokenizationAvailable();
const generatorTest = nativeAvailable ? test : test.skip;

describe("generated duplicate identifier ranges", () => {
  generatorTest(
    nativeAvailable
      ? "match the pinned native grammar across every code point"
      : "match the pinned native grammar across every code point (skipped: native addon unavailable)",
    async () => {
      // The exhaustive tokenizer parity suite compares every BMP scalar but only samples astral
      // code points, so a change to the pinned `unicode-ident` version could move an astral range
      // without any test noticing. Regenerating the table here covers the whole space and fails
      // when the checked-in file no longer matches the native tokenizer it was derived from.
      const regenerated = renderDuplicateIdentifierRanges(
        collectDuplicateIdentifierRanges((source: string) => {
          const native = getNativeDuplicateTokens(source, "on");
          if (!native) throw new Error("Native duplicate tokenizer became unavailable mid-run.");
          return native.normalizedTokens;
        }),
      );

      const committed = await fs.readFile(DUPLICATE_IDENTIFIER_RANGES_TARGET, "utf8");
      expect(
        regenerated,
        "src/duplicate-identifier-ranges.ts is stale. Run `npm run generate:duplicate-identifier-ranges`.",
      ).toBe(committed);
    },
    120_000,
  );
});
