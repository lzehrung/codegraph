// The leaf stage registry is imported before the name-policy registry: it must initialize on its own.
import { namedImportStageFor } from "../src/indexer/name-import-stages/index.js";
import { describe, expect, it } from "vitest";
import { genericNamedImportStage } from "../src/indexer/navigation-named-core.js";
import { nameLookupPolicyFor } from "../src/indexer/name-lookup-policies/index.js";
import { SCOPE_NODE_ROWS } from "../src/indexer/scope-nodes.js";
import { LANGUAGE_SUPPORTS } from "../src/languages.js";

describe("named/import stages", () => {
  it("gives the shared name lookup and the direct callers the same stage for every language", () => {
    for (const support of LANGUAGE_SUPPORTS) {
      const policyStage = nameLookupPolicyFor(support.id).namedImports ?? genericNamedImportStage;
      expect(policyStage, support.id).toBe(namedImportStageFor(support.id));
    }
    const specialized = ["c", "cpp", "csharp", "kotlin", "python"].map(namedImportStageFor);
    expect(new Set(specialized).size).toBe(specialized.length);
    expect(specialized).not.toContain(genericNamedImportStage);
    for (const languageId of ["ts", "tsx", "js", "java", "rust", "go", "ruby", "php", "swift", "zig", "unknown"]) {
      expect(namedImportStageFor(languageId), languageId).toBe(genericNamedImportStage);
    }
  });

  it("keeps generic arity and runtime module bindings out of the generic stage", () => {
    const rowsWithNamedLookupFacts = Object.entries(SCOPE_NODE_ROWS)
      .filter(([, row]) => row.bindingRules?.typeArgumentArity || row.moduleBindingsAtFunctionRuntime)
      .map(([languageId]) => languageId)
      .sort();
    expect(rowsWithNamedLookupFacts).toEqual(["csharp", "python"]);
    for (const languageId of rowsWithNamedLookupFacts) {
      expect(namedImportStageFor(languageId), languageId).not.toBe(genericNamedImportStage);
    }
  });
});
