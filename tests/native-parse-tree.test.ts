import { describe, expect, it } from "vitest";
import { isJsFallbackAvailable, parseWithJsLanguage } from "../src/jsFallback.js";

import { TS_SUPPORT, languageForFile, supportById } from "../src/languages.js";
import { buildScopeIndexFromSource } from "../src/indexer.js";
import { getNativeSyntaxTreeExecution, isNativeTreeSitterAvailable } from "../src/native/treeSitterNative.js";
import { ProjectedSyntaxTree } from "../src/native/projectedTree.js";

const nativeDescribe = isNativeTreeSitterAvailable() ? describe : describe.skip;
const jsFallbackIt = isJsFallbackAvailable() ? it : it.skip;

nativeDescribe("native parse tree projection", () => {
  it("projects child and field relationships for TypeScript", () => {
    const support = supportById("ts");
    expect(support).toBeDefined();

    const source = ["export function greet(name: string) {", "  return name.toUpperCase();", "}"].join("\n");

    const execution = getNativeSyntaxTreeExecution(source, support!);
    expect(execution.tree).not.toBeNull();

    const tree = new ProjectedSyntaxTree(source, execution.tree!);
    const exportStatement = tree.rootNode.namedChildren[0];
    expect(exportStatement?.type).toBe("export_statement");

    const declaration = exportStatement?.namedChildren[0] ?? null;
    expect(declaration?.type).toBe("function_declaration");

    const nameNode = declaration?.childForFieldName("name") ?? null;
    expect(nameNode?.text).toBe("greet");

    const bodyNode = declaration?.childForFieldName("body") ?? null;
    expect(bodyNode?.type).toBe("statement_block");
    expect(bodyNode?.previousNamedSibling?.type).toBe("formal_parameters");
  });

  it("supports descendant lookup by byte and point ranges", () => {
    const support = supportById("python");
    expect(support).toBeDefined();

    const source = ["def greet(name):", "    return name.upper()"].join("\n");

    const execution = getNativeSyntaxTreeExecution(source, support!);
    expect(execution.tree).not.toBeNull();

    const tree = new ProjectedSyntaxTree(source, execution.tree!);
    const byIndex = tree.rootNode.descendantForIndex(
      source.indexOf("name.upper"),
      source.indexOf("name.upper") + "name".length,
    );
    expect(byIndex.text).toBe("name");

    const byPosition = tree.rootNode.descendantForPosition({ row: 1, column: 11 }, { row: 1, column: 15 });
    expect(byPosition.text).toBe("name");
  });

  it("projects UTF-8 byte offsets to JavaScript string indices", () => {
    const support = supportById("ts");
    expect(support).toBeDefined();

    const source = ["// unicode marker: -> => ...", "function afterUnicode() {", "  return 1;", "}"].join("\n");
    const unicodeSource = source.replace("-> => ...", "\u2192 \u2014 \u{1f680} ok");

    const execution = getNativeSyntaxTreeExecution(unicodeSource, support!);
    expect(execution.tree).not.toBeNull();

    const tree = new ProjectedSyntaxTree(unicodeSource, execution.tree!);
    const declaration = tree.rootNode.namedChildren.find((node) => node.type === "function_declaration");
    const nameNode = declaration?.childForFieldName("name") ?? null;

    expect(nameNode?.text).toBe("afterUnicode");
    expect(nameNode?.startIndex).toBe(unicodeSource.indexOf("afterUnicode"));
  });

  jsFallbackIt("builds the same TypeScript scope bindings as the JS tree walker", () => {
    const source = [
      "const top = 1;",
      "function outer(arg: string) {",
      "  const top = arg;",
      "  function inner() {",
      "    return top;",
      "  }",
      "  return inner();",
      "}",
    ].join("\n");

    const file = "scope.ts";
    const lang = languageForFile(file);
    const jsTree = parseWithJsLanguage(source, lang);

    const nativeScope = buildScopeIndexFromSource(file, source, TS_SUPPORT, lang);
    const jsScope = buildScopeIndexFromSource(file, source, TS_SUPPORT, lang, [], {
      tree: jsTree,
    });

    const normalize = (scopeIndex: ReturnType<typeof buildScopeIndexFromSource>) =>
      Array.from(scopeIndex.bindings.entries())
        .map(([name, bindings]) => ({
          name,
          bindings: bindings.map((binding) => ({
            kind: binding.kind,
            def: binding.def?.start.index ?? -1,
            occurrences: binding.occurrences
              .map((range) => range.start.index ?? -1)
              .sort((left, right) => left - right),
          })),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));

    expect(normalize(nativeScope)).toEqual(normalize(jsScope));
  });
});
