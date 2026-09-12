import { describe, expect, it } from "vitest";
import { duplicateImportStatementQueries } from "../../src/duplicates/units.js";
import { supportById } from "../../src/languages.js";
import { generateChunkingQuery } from "../../src/languages/query-generator.js";
import { getAllLanguages } from "../../src/languages/registry.js";
import {
  getCachedNormalizedQuery,
  getNativeSingleQueryExecution,
  getNativeTreeSitterSupportedLanguageIds,
  isNativeTreeSitterAvailable,
  NATIVE_QUERY_KINDS,
} from "../../src/native/tree-sitter-native.js";

/** Top-level S-expressions, ignoring string literals and `;` comments. */
function topLevelForms(text: string): string[] {
  const forms: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === ";" && depth === 0) {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "(" || ch === "[") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === ")" || ch === "]") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        forms.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return forms;
}

function strayTopLevelPredicates(text: string): string[] {
  return topLevelForms(text).filter((form) => form.startsWith("(#"));
}

describe("query hygiene", () => {
  it("rejects stray top-level predicates in registered language queries", () => {
    const failures: string[] = [];
    for (const def of getAllLanguages()) {
      const sources: Array<[string, string]> = [
        ["imports", def.graph.imports],
        ["exports", def.graph.exports],
        ["locals", def.graph.locals],
        ["importBindings", def.graph.importBindings],
        ["chunk", generateChunkingQuery(def)],
      ];
      for (const [kind, text] of sources) {
        if (!text.trim()) continue;
        for (const form of strayTopLevelPredicates(text)) {
          failures.push(`${def.id}/${kind}: ${form.replace(/\s+/g, " ")}`);
        }
      }
    }
    for (const [languageId, text] of Object.entries(duplicateImportStatementQueries)) {
      if (!text.trim()) continue;
      for (const form of strayTopLevelPredicates(text)) {
        failures.push(`duplicates/${languageId}: ${form.replace(/\s+/g, " ")}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe.runIf(isNativeTreeSitterAvailable())("native query compilation", () => {
  const nativeIds = new Set(getNativeTreeSitterSupportedLanguageIds());
  const graphCases: Array<{ id: string }> = [];
  const chunkCases: Array<{ id: string; text: string }> = [];

  for (const def of getAllLanguages()) {
    if (!nativeIds.has(def.id)) continue;
    const support = supportById(def.id);
    if (!support) continue;
    graphCases.push({ id: def.id });
    const chunk = generateChunkingQuery(def);
    if (chunk.trim()) chunkCases.push({ id: def.id, text: chunk });
  }

  it.each(graphCases)("$id graph queries compile against the native grammar", ({ id }) => {
    const support = supportById(id);
    if (!support) throw new Error(`missing support for ${id}`);
    for (const kind of NATIVE_QUERY_KINDS) {
      const text = getCachedNormalizedQuery(support, kind);
      if (!text.trim()) continue;
      const execution = getNativeSingleQueryExecution("", support, text);
      expect(execution.fallbackReason, `${id}/${kind}: ${execution.error ?? "queryFailure"}`).not.toBe("queryFailure");
      expect(execution.matches, `${id}/${kind}: ${execution.error ?? "no matches payload"}`).not.toBeNull();
    }
  });

  it.each(chunkCases)("$id chunk query compiles against the native grammar", ({ id, text }) => {
    const support = supportById(id);
    if (!support) throw new Error(`missing support for ${id}`);
    const execution = getNativeSingleQueryExecution("", support, text);
    expect(execution.fallbackReason, `${id}/chunk: ${execution.error ?? "queryFailure"}`).not.toBe("queryFailure");
    expect(execution.matches, `${id}/chunk: ${execution.error ?? "no matches payload"}`).not.toBeNull();
  });
});
