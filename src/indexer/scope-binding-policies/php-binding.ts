import type { SyntaxNodeLike } from "../../languages/types.js";
import { sliceText } from "../../util/ast.js";
import { phpConstructorPromotedVariable } from "../navigation-php.js";

/** Constructor-promoted variables also bind as properties of their class. */
export function phpPromotedVariablesInClass(classNode: SyntaxNodeLike, source: string): SyntaxNodeLike[] {
  const variables: SyntaxNodeLike[] = [];
  const visit = (current: SyntaxNodeLike): void => {
    if (
      current !== classNode &&
      (current.type === "class_declaration" ||
        current.type === "trait_declaration" ||
        current.type === "enum_declaration" ||
        current.type === "function_definition")
    ) {
      return;
    }
    if (current.type === "method_declaration") {
      const name = current.childForFieldName("name");
      if (!name || sliceText(name, source) !== "__construct") return;
      const params = current.childForFieldName("parameters");
      for (const child of params?.namedChildren ?? []) {
        const variable = phpConstructorPromotedVariable(child, source);
        if (variable) variables.push(variable);
      }
      return;
    }
    for (const child of current.namedChildren) visit(child);
  };
  visit(classNode);
  return variables;
}
