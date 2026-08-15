import { describe, it, expect, vi } from "vitest";
import { createFallbackImportExtractionHandler } from "../src/indexer/build-cache/reports.js";
import type { FallbackImportExtractionReason } from "../src/graphs/specifiers.js";

describe("Fallback import extraction human messages (D11)", () => {
  const cases: Array<{ reason: FallbackImportExtractionReason; language: string; expectSubstring: string }> = [
    // CSS has no regex-recovery support baked into the native layer, so these reasons
    // previously fell through to the bare label + dumped event object.
    { reason: "query-empty", language: "css", expectSubstring: "returned no results" },
    { reason: "query-error", language: "css", expectSubstring: "query failed" },
    { reason: "fast", language: "css", expectSubstring: "Fast mode active" },
  ];

  it.each(cases)("gives a human sentence for reason=$reason, language=$language", ({ reason, language, expectSubstring }) => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      const handler = createFallbackImportExtractionHandler(undefined, { logLevel: "debug" });
      handler?.({ language, reason, file: "styles.css" });

      const allCalls = [...warnSpy.mock.calls, ...debugSpy.mock.calls];
      expect(allCalls).toHaveLength(1);
      const message = String(allCalls[0]?.[0] ?? "");

      // Regression guard for the exact bare label observed on stderr (V7):
      // "Regex fallback import extraction { language: 'css', reason: 'query-empty' }"
      expect(message).not.toBe("Regex fallback import extraction");
      expect(message).toContain(language);
      expect(message).toContain(expectSubstring);
    } finally {
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });
});
