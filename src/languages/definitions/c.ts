import { registerLanguage } from "../registry.js";
import type { SyntaxNodeLike } from "../types.js";
import { nodeTypeIn } from "./shared.js";
import {
  cFamilyBlock,
  cFamilyContainerClassifyDefinition,
  cFamilyFunctionBlock,
  cFamilyTypeIdentifierBlock,
  cFamilyIsDeclarationName,
  createCFamilyLanguageDefinition,
  isInField,
  isSpecifierNameField,
} from "./c-family.js";

/** C tags share one namespace, separate from typedefs and ordinary identifiers. */
export function cTagRole(node: SyntaxNodeLike): "declaration" | "reference" | undefined {
  if (!isSpecifierNameField(node, ["struct_specifier", "union_specifier", "enum_specifier"])) return undefined;
  const specifier = node.parent!;
  if (specifier.childForFieldName("body")) return "declaration";
  const statement = specifier.parent;
  if (
    statement?.type === "translation_unit" ||
    (statement?.type === "declaration" && !statement.childForFieldName("declarator"))
  ) {
    return "declaration";
  }
  return "reference";
}

export function cScopeName(name: string, namespace: "tag" | "ordinary"): string {
  return namespace === "tag" ? `c:tag\0${name}` : name;
}

export const C_DEF = createCFamilyLanguageDefinition({
  id: "c",
  extensions: [".c", ".h", ".i"],
  includeFieldIdentifier: false,
  usesQueryDrivenLocals: true,
  blocks: (functionNameQuery) => [
    cFamilyFunctionBlock(functionNameQuery),
    cFamilyTypeIdentifierBlock("struct_specifier", "struct"),
    cFamilyTypeIdentifierBlock("union_specifier", "union"),
    cFamilyTypeIdentifierBlock("enum_specifier", "enum"),
    cFamilyBlock("type_definition", "declarator: (type_identifier) @chunk.name", "type"),
    cFamilyBlock("preproc_def", "name: (identifier) @chunk.name", "macro"),
    cFamilyBlock("preproc_function_def", "name: (identifier) @chunk.name", "macro"),
  ],
  extraSymbolQueries: [
    `(union_specifier name: (type_identifier) @name)`,
    `(enumerator name: (identifier) @name)`,
    `(preproc_def name: (identifier) @name)`,
    `(preproc_function_def name: (identifier) @name)`,
  ],
  nodeTypes: {
    identifier: ["identifier", "field_identifier", "type_identifier"],
    propertyIdentifier: ["field_identifier"],
    memberExpression: "field_expression",
  },
  classifyDefinition: (node) => {
    const parent = node.parent;
    if (!parent) return "variable";
    if (parent.type === "enum_specifier") return "type";
    if (parent.type === "struct_specifier" || parent.type === "union_specifier") return "class";
    if (parent.type === "type_definition" && isInField(node, parent, "declarator")) return "type";
    return cFamilyContainerClassifyDefinition(node);
  },
  isDeclarationName: (node) =>
    isSpecifierNameField(node, ["struct_specifier", "union_specifier", "enum_specifier"]) ||
    cFamilyIsDeclarationName(node),
  createsFunctionScope: nodeTypeIn(["function_definition"]),
});

registerLanguage(C_DEF);
