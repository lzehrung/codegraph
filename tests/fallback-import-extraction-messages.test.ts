import { describe, it, expect, vi } from "vitest";
import { createFallbackImportExtractionHandler } from "../src/indexer/build-cache/reports.js";
import type { FallbackImportExtractionReason } from "../src/graphs/specifiers.js";

const logMocks = vi.hoisted(() => ({ logWithLevel: vi.fn() }));

vi.mock("../src/logging.js", () => ({ logWithLevel: logMocks.logWithLevel }));

describe("Fallback import extraction human messages (D11)", () => {
  const cases: Array<{ reason: FallbackImportExtractionReason; language: string; expectSubstring: string }> = [
    // CSS has no regex-recovery support baked into the native layer, so these reasons
    // previously fell through to the bare label + dumped event object.
    { reason: "query-empty", language: "css", expectSubstring: "returned no results" },
    { reason: "query-error", language: "css", expectSubstring: "query failed" },
    { reason: "fast", language: "css", expectSubstring: "Fast mode active" },
    { reason: "fast", language: "ts", expectSubstring: "Fast mode active" },
  ];

  it.each(cases)(
    "gives a human sentence for reason=$reason, language=$language",
    ({ reason, language, expectSubstring }) => {
      logMocks.logWithLevel.mockClear();
      const handler = createFallbackImportExtractionHandler(undefined, { logLevel: "debug" });
      handler?.({ language, reason, file: "styles.css" });

      expect(logMocks.logWithLevel).toHaveBeenCalledTimes(1);
      const [logLevel, severity, message] = logMocks.logWithLevel.mock.calls[0] ?? [];
      expect(logLevel).toBe("debug");
      if (reason === "fast") expect(severity).toBe("debug");
      expect(message).toBeTypeOf("string");
      expect(message).not.toBe("Regex fallback import extraction");
      expect(message).toContain(language);
      expect(message).toContain(expectSubstring);
    },
  );
});
