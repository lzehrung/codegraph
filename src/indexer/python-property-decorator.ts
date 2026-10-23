import type { SyntaxNodeLike } from "../languages/types.js";

export type PythonPropertyDecorator =
  | { kind: "property" }
  | { kind: "accessor"; accessor: "setter" | "getter" | "deleter"; propertyName: string };

/** Classifies Python property decorators from their parsed expression, not source formatting. */
export function pythonPropertyDecorator(decorator: SyntaxNodeLike): PythonPropertyDecorator | null {
  if (decorator.type !== "decorator") return null;
  const expression = decorator.namedChildren[0];
  if (!expression) return null;
  if (expression.type === "identifier" && expression.text === "property") return { kind: "property" };

  const segments: string[] = [];
  let current: SyntaxNodeLike | null = expression;
  while (current?.type === "attribute") {
    const attribute = current.childForFieldName("attribute");
    const object = current.childForFieldName("object");
    if (!attribute || !object || attribute.type !== "identifier") return null;
    segments.unshift(attribute.text);
    current = object;
  }
  if (current?.type !== "identifier") return null;
  segments.unshift(current.text);
  if (segments.length < 2) return null;
  const accessor = segments.at(-1);
  if (accessor !== "setter" && accessor !== "getter" && accessor !== "deleter") return null;
  return { kind: "accessor", accessor, propertyName: segments.at(-2)! };
}
