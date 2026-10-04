import { describe, expect, it } from "vitest";
import { LANGUAGE_SUPPORTS } from "../src/languages.js";
import { SPECIALIZED_EDGE_PASSES } from "../src/graphs/symbol-graph-detailed/edge-passes.js";

describe("specialized detailed-graph edge passes", () => {
  it("registers passes only for supported languages", () => {
    const registered = new Set(LANGUAGE_SUPPORTS.map((support) => support.id));
    for (const languageId of Object.keys(SPECIALIZED_EDGE_PASSES)) {
      expect(registered.has(languageId), `${languageId} has no registered language`).toBe(true);
    }
  });
});
