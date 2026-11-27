import { describe, expect, it } from "vitest";
import { LANGUAGE_SUPPORTS } from "../src/languages.js";
import { SPECIALIZED_EDGE_PASSES } from "../src/graphs/symbol-graph-detailed/edge-passes.js";
import { graphRulesFor } from "../src/indexer/member-lookup-policies/graph-rules.js";
import { memberLookupPolicyFor } from "../src/indexer/member-lookup-policies/index.js";

describe("specialized detailed-graph edge passes", () => {
  it("registers passes only for supported languages", () => {
    const registered = new Set(LANGUAGE_SUPPORTS.map((support) => support.id));
    for (const languageId of Object.keys(SPECIALIZED_EDGE_PASSES)) {
      expect(registered.has(languageId), `${languageId} has no registered language`).toBe(true);
    }
  });

  it("gives each language's member policy the graph rules the module walks select", () => {
    // The completed-graph passes and member-path fallbacks read a file's graph facts from its member policy.
    for (const support of LANGUAGE_SUPPORTS) {
      const rules = graphRulesFor(support.id);
      const policyRules = memberLookupPolicyFor(support.id).graph;
      if (Object.keys(rules).length) expect(policyRules, support.id).toBe(rules);
      else expect(policyRules, support.id).toBeUndefined();
    }
  });
});
