import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";
import { classifyByParentType, isNameFieldOnParent, nodeTypeIn } from "./shared.js";
import { hasNonAsciiCodePoint, JAVA_IDENTIFIER_IGNORABLE_SOURCE } from "../../util/identifiers.js";

const JAVA_IDENTIFIER_IGNORABLE_PATTERN = new RegExp(`[${JAVA_IDENTIFIER_IGNORABLE_SOURCE}]`, "gu");

// Pinned tree-sitter-java `import_declaration` children:
//   anonymous: "import", optional "static", trailing ";"
//   named: `identifier` (bare `import Foo;`) or `scoped_identifier` (`import a.b.C;`),
//          optional named `asterisk` (`import a.b.*;`, `import static a.B.*;`)
// Optional `(asterisk)? @wild` yields one match per statement without a trailing `.`
// end-anchor, which would treat `;` as a last-child miss if the engine counts anonymous
// siblings. Java has no import alias.
const JAVA_IMPORT_QUERY = `
      (import_declaration (scoped_identifier) @from (asterisk)? @wild) @stmt
      (import_declaration (identifier) @from (asterisk)? @wild) @stmt
    `;

export const JAVA_DEF: LanguageDefinition = {
  id: "java",
  extensions: [".java"],
  usesQueryDrivenLocals: true,
  structure: {
    blocks: [
      {
        type: "class_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "class",
      },
      {
        type: "record_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "class",
      },
      {
        type: "interface_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "interface",
      },
      {
        type: "enum_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "enum",
      },
      {
        type: "annotation_type_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "interface",
      },
      {
        type: "method_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "method",
      },
      {
        type: "constructor_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "method",
      },
    ],
    splitPoints: ["if_statement", "for_statement", "while_statement", "try_statement", "switch_expression"],
    comments: ["line_comment", "block_comment"],
  },
  graph: {
    imports: JAVA_IMPORT_QUERY,
    exports: `
      (class_declaration name: (identifier) @name)
      (record_declaration name: (identifier) @name)
      (interface_declaration name: (identifier) @name)
      (enum_declaration name: (identifier) @name)
      (annotation_type_declaration name: (identifier) @name)
      (enum_constant name: (identifier) @name)
      (method_declaration name: (identifier) @name)
      (field_declaration (variable_declarator name: (identifier) @name))
    `,
    locals: `
      (class_declaration name: (identifier) @name)
      (record_declaration name: (identifier) @name)
      (interface_declaration name: (identifier) @name)
      (enum_declaration name: (identifier) @name)
      (annotation_type_declaration name: (identifier) @name)
      (enum_constant name: (identifier) @name)
      (method_declaration name: (identifier) @name)
      (variable_declarator name: (identifier) @name)
      (formal_parameter name: (identifier) @name)
      (spread_parameter (variable_declarator name: (identifier) @name))
      (receiver_parameter (identifier) @name)
    `,
    importBindings: JAVA_IMPORT_QUERY,
  },
  nodeTypes: {
    identifier: ["identifier", "type_identifier"],
    memberExpression: "field_access",
  },
  supportsCrossModuleSymbols: true,
  membersAreImplicitlyInScope: true,
  exportScopeBlockers: ["block", "constructor_body"],
  classifyDefinition: classifyByParentType({
    method_declaration: "method",
    constructor_declaration: "method",
    class_declaration: "class",
    record_declaration: "class",
    interface_declaration: "interface",
    annotation_type_declaration: "interface",
    enum_declaration: "type",
  }),
  createsFunctionScope: nodeTypeIn(["method_declaration", "constructor_declaration"]),
  createsBlockScope: nodeTypeIn(["block", "class_body"]),
  isDeclarationName: (node) =>
    isNameFieldOnParent(node, [
      "class_declaration",
      "record_declaration",
      "interface_declaration",
      "annotation_type_declaration",
      "enum_declaration",
      "enum_constant",
      "method_declaration",
      "constructor_declaration",
      "variable_declarator",
      "formal_parameter",
    ]) ||
    // `spread_parameter` (`int... rest`) has no `name` field; its declared name is the
    // `variable_declarator` child, so that node is the declaration name.
    (node.type === "variable_declarator" && node.parent?.type === "spread_parameter") ||
    (node.parent?.type === "receiver_parameter" && node.type === "identifier"),
  normalizeIdentifier: (name) =>
    hasNonAsciiCodePoint(name, true) ? name.replace(JAVA_IDENTIFIER_IGNORABLE_PATTERN, "") : name,
};
registerLanguage(JAVA_DEF);
