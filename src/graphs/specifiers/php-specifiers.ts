import type { SyntaxNodeLike, SyntaxTreeLike } from "../../languages/types.js";
import { parsePhpImportStatement } from "../../languages/import-statement-parsers.js";
import { getNativeSyntaxTreeExecution } from "../../native/tree-sitter-native.js";
import { ProjectedSyntaxTree } from "../../native/projected-tree.js";
import { sliceText } from "../../util/ast.js";
import { pushAll } from "../../util/collections.js";
import type { ModuleSpecifier } from "../../util/specifiers.js";
import type { SpecifierCollectionHooks } from "../../util/resolution/language-policy-types.js";

function extractPhpQualifiedSpecifiersFromTree(source: string, tree: SyntaxTreeLike): ModuleSpecifier[] {
  const specifiers: ModuleSpecifier[] = [];
  const seen = new Set<string>();
  const isPhpQualifiedNameNode = (node: SyntaxNodeLike): boolean =>
    node.type === "qualified_name" || node.type === "relative_name";
  const findPhpQualifiedTarget = (node: SyntaxNodeLike): SyntaxNodeLike | null =>
    node.namedChildren.find(isPhpQualifiedNameNode) ?? node.child(0);
  const pushSpecifier = (spec: string | null, phpImportType: "class" | "function" | "const"): void => {
    const normalized = spec?.trim();
    if (!normalized || !normalized.includes("\\")) return;
    const key = `${phpImportType}::${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    specifiers.push({ spec: normalized, phpImportType });
  };

  const walk = (node: SyntaxNodeLike): void => {
    if (node.type === "object_creation_expression") {
      const target = findPhpQualifiedTarget(node);
      if (target) pushSpecifier(sliceText(target, source), "class");
    } else if (node.type === "scoped_call_expression") {
      const target = findPhpQualifiedTarget(node);
      if (target) pushSpecifier(sliceText(target, source), "class");
    } else if (node.type === "scoped_property_access_expression") {
      const target = findPhpQualifiedTarget(node);
      if (target) pushSpecifier(sliceText(target, source), "class");
    } else if (node.type === "class_constant_access_expression") {
      const target = findPhpQualifiedTarget(node);
      if (target) pushSpecifier(sliceText(target, source), "class");
    } else if (
      (node.type === "qualified_name" || node.type === "relative_name") &&
      node.parent?.type === "named_type"
    ) {
      pushSpecifier(sliceText(node, source), "class");
    }

    for (const child of node.namedChildren) {
      walk(child);
    }
  };

  walk(tree.rootNode);
  return specifiers;
}

export const PHP_SPECIFIER_COLLECTION: SpecifierCollectionHooks = {
  prependSpecifiers(support, source, options, output) {
    const tree =
      options?.tree ??
      (() => {
        const execution = getNativeSyntaxTreeExecution(source, support);
        return execution.tree ? new ProjectedSyntaxTree(source, execution.tree) : null;
      })();
    if (tree) {
      const qualified = extractPhpQualifiedSpecifiersFromTree(source, tree);
      if (qualified.length) pushAll(output, qualified);
    }
  },
  statement(stmtText, _source, file, _startIndex, output) {
    for (const parsed of parsePhpImportStatement(stmtText, file)) {
      output.push({
        spec: parsed.from,
        typeOnly: false,
        ...(parsed.kind === "named" ? { phpImportType: parsed.importType } : {}),
      });
    }
    return true;
  },
};
