import { describe, expect, it } from "vitest";

import { extractLanguage } from "../packages/codegraph-native/index.js";

import { isNativeTreeSitterAvailable, loadBinding } from "../src/native/runtime.js";

const nativeDescribe = isNativeTreeSitterAvailable() ? describe : describe.skip;

nativeDescribe("combined native extraction", () => {
  it("matches separate native calls for TypeScript, Python, and Go", () => {
    const loaded = loadBinding();
    if (!loaded.loaded) return;

    const cases = [
      {
        languageId: "ts",
        source: "import { helper } from './dep';\nexport function greet() { return helper(); }",
        localsQuery: "(function_declaration name: (identifier) @name)",
      },
      {
        languageId: "python",
        source: "from dep import helper\ndef greet():\n    return helper()",
        localsQuery: "(function_definition name: (identifier) @name)",
      },
      {
        languageId: "go",
        source: "package main\nfunc greet() { helper() }",
        localsQuery: "(function_declaration name: (identifier) @name)",
      },
    ];

    for (const testCase of cases) {
      const separateResults = loaded.binding.runLanguageQueries(
        testCase.source,
        testCase.languageId,
        "",
        "",
        testCase.localsQuery,
        "",
      );
      const separateTree = loaded.binding.parseSyntaxTree?.(testCase.source, testCase.languageId);
      const combined = extractLanguage(testCase.source, testCase.languageId, "", "", testCase.localsQuery, "");

      expect(combined.results).toEqual(separateResults);
      expect(combined.syntaxTree).toEqual(separateTree);
    }
  });
});
