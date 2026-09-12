import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";
import { CSHARP_IDENTIFIER_FORMAT_SOURCE, hasNonAsciiCodePoint } from "../../util/identifiers.js";

const CSHARP_IDENTIFIER_FORMAT_PATTERN = new RegExp(`[${CSHARP_IDENTIFIER_FORMAT_SOURCE}]`, "gu");

export const CSHARP_DEF: LanguageDefinition = {
  id: "csharp",
  extensions: [".cs", ".csx"],
  usesQueryDrivenLocals: true,
  structure: {
    blocks: [
      {
        type: "class_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "class",
      },
      {
        type: "struct_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "struct",
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
        type: "method_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "method",
      },
      {
        type: "namespace_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "namespace",
      },
      {
        type: "file_scoped_namespace_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "namespace",
      },
    ],
    splitPoints: [
      "if_statement",
      "for_statement",
      "foreach_statement",
      "while_statement",
      "switch_statement",
      "try_statement",
    ],
    comments: ["comment"],
  },
  graph: {
    imports: `
      (using_directive !name (_) @mod) @stmt
      (using_directive name: (identifier) (_) @mod) @stmt
      (extern_alias_directive name: (identifier) @mod) @stmt
    `,
    exports: `
      (class_declaration name: (identifier) @name)
      (record_declaration name: (identifier) @name)
      (struct_declaration name: (identifier) @name)
      (interface_declaration name: (identifier) @name)
      (enum_declaration name: (identifier) @name)
      (enum_member_declaration name: (identifier) @name)
      (method_declaration name: (identifier) @name)
      (delegate_declaration name: (identifier) @name)
      (property_declaration name: (identifier) @name)
      (field_declaration (variable_declaration (variable_declarator name: (identifier) @name)))
      (event_field_declaration (variable_declaration (variable_declarator name: (identifier) @name)))
    `,
    locals: `
      (class_declaration name: (identifier) @name)
      (record_declaration name: (identifier) @name)
      (struct_declaration name: (identifier) @name)
      (interface_declaration name: (identifier) @name)
      (enum_declaration name: (identifier) @name)
      (enum_member_declaration name: (identifier) @name)
      (method_declaration name: (identifier) @name)
      (delegate_declaration name: (identifier) @name)
      (local_function_statement name: (identifier) @name)
      (property_declaration name: (identifier) @name)
      (variable_declarator name: (identifier) @name)
      (declaration_pattern name: (identifier) @name)
    `,
    importBindings: `
      (using_directive name: (identifier) @alias (_) @from) @stmt
      (using_directive !name (_) @from) @stmt
      (extern_alias_directive name: (identifier) @alias) @stmt
    `,
  },
  nodeTypes: {
    identifier: ["identifier"],
    memberExpression: "member_access_expression",
  },
  supportsCrossModuleSymbols: true,
  classifyDefinition: (node) => {
    const parent = node.parent;
    if (!parent) return "variable";
    if (
      parent.type === "method_declaration" ||
      parent.type === "constructor_declaration" ||
      parent.type === "destructor_declaration" ||
      parent.type === "local_function_statement"
    )
      return "method";
    if (
      parent.type === "class_declaration" ||
      parent.type === "record_declaration" ||
      parent.type === "struct_declaration"
    )
      return "class";
    if (parent.type === "interface_declaration") return "interface";
    if (parent.type === "enum_declaration" || parent.type === "delegate_declaration") return "type";
    return "variable";
  },
  createsFunctionScope: (node) =>
    node.type === "method_declaration" ||
    node.type === "constructor_declaration" ||
    node.type === "destructor_declaration" ||
    node.type === "local_function_statement",
  createsBlockScope: (node) => node.type === "block" || node.type === "declaration_list",
  isDeclarationName: (node) => {
    const p = node.parent;
    if (!p) return false;
    if (
      (p.type === "class_declaration" ||
        p.type === "record_declaration" ||
        p.type === "struct_declaration" ||
        p.type === "interface_declaration" ||
        p.type === "enum_declaration" ||
        p.type === "delegate_declaration" ||
        p.type === "enum_member_declaration" ||
        p.type === "method_declaration" ||
        p.type === "constructor_declaration" ||
        p.type === "destructor_declaration" ||
        p.type === "local_function_statement" ||
        p.type === "property_declaration") &&
      p.childForFieldName("name")?.id === node.id
    )
      return true;
    if (p.type === "variable_declarator" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "parameter" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "declaration_pattern" && p.childForFieldName("name")?.id === node.id) return true;
    return false;
  },
  normalizeIdentifier: (name) => {
    const withoutVerbatimPrefix = name.startsWith("@") ? name.slice(1) : name;
    return hasNonAsciiCodePoint(withoutVerbatimPrefix)
      ? withoutVerbatimPrefix.replace(CSHARP_IDENTIFIER_FORMAT_PATTERN, "")
      : withoutVerbatimPrefix;
  },
};
registerLanguage(CSHARP_DEF);
