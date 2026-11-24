import { sliceText, toRange } from "../../util/ast.js";
import { comparePhpReferenceNames, isInsidePhpUseDeclaration, phpLastIdentifierSegment } from "../navigation-php.js";
import type { ReferenceHooks } from "../name-resolution-types.js";

export const phpReferenceHooks: ReferenceHooks = {
  globalNameStrategy: "php_qualified_name",
  namedNodeVisitor(parsed, canonicalName, symbolKind, filter, importDeclarationKeys, collection, rangeKey) {
    return (node): void => {
      const text = parsed.sup.normalizeIdentifier(sliceText(node, parsed.source));
      const comparisonText =
        node.type === "qualified_name" || node.type === "relative_name" ? phpLastIdentifierSegment(text) : text;
      const comparison = comparePhpReferenceNames(comparisonText, phpLastIdentifierSegment(canonicalName), {
        caseSensitiveForm: node.type === "variable_name" || node.type === "constant",
        ...(symbolKind ? { symbolKind } : {}),
      });
      if (comparison === "unverified") collection.nameEquivalenceUnavailable = true;
      if (comparison !== "equivalent") return;
      if (filter && !filter.includes(node)) return;
      const range = toRange(node);
      if (!importDeclarationKeys.has(rangeKey(range)) && !isInsidePhpUseDeclaration(node)) {
        collection.matched.push({ range, node });
      }
    };
  },
};
