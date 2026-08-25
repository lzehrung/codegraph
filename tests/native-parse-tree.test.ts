import { describe, expect, it } from "vitest";

import { supportById } from "../src/languages.js";
import { getNativeSyntaxTreeExecution, isNativeTreeSitterAvailable } from "../src/native/treeSitterNative.js";
import { ProjectedSyntaxTree } from "../src/native/projectedTree.js";

const nativeDescribe = isNativeTreeSitterAvailable() ? describe : describe.skip;

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
});
