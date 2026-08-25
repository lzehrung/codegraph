import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";

export const SWIFT_DEF: LanguageDefinition = {
  id: "swift",
  extensions: [".swift"],
  usesQueryDrivenLocals: true,
  structure: {
    blocks: [
      {
        type: "class_declaration",
        nameQuery: 'declaration_kind: "class" name: (_) @chunk.name',
        captureId: "class",
      },
      {
        type: "class_declaration",
        nameQuery: 'declaration_kind: "struct" name: (_) @chunk.name',
        captureId: "struct",
      },
      {
        type: "class_declaration",
        nameQuery: 'declaration_kind: "enum" name: (_) @chunk.name',
        captureId: "enum",
      },
      {
        type: "class_declaration",
        nameQuery: 'declaration_kind: "extension" name: (user_type (type_identifier) @chunk.name)',
        captureId: "extension",
      },
      {
        type: "class_declaration",
        nameQuery: 'declaration_kind: "actor" name: (_) @chunk.name',
        captureId: "actor",
      },
      {
        type: "protocol_declaration",
        nameQuery: "name: (type_identifier) @chunk.name",
        captureId: "protocol",
      },
      {
        type: "function_declaration",
        nameQuery: "name: (simple_identifier) @chunk.name",
        captureId: "function",
      },
      {
        type: "property_declaration",
        nameQuery: "name: (pattern bound_identifier: (simple_identifier) @chunk.name)",
        captureId: "property",
      },
      {
        type: "typealias_declaration",
        nameQuery: "name: (type_identifier) @chunk.name",
        captureId: "type",
      },
      {
        type: "init_declaration",
        captureId: "initializer",
      },
      {
        type: "deinit_declaration",
        captureId: "deinitializer",
      },
      {
        type: "subscript_declaration",
        captureId: "subscript",
      },
    ],
    splitPoints: [
      "if_statement",
      "guard_statement",
      "for_statement",
      "while_statement",
      "repeat_while_statement",
      "switch_statement",
      "do_statement",
      "catch_block",
    ],
    comments: ["comment", "multiline_comment"],
  },
  graph: {
    imports: `
      (import_declaration (identifier) @mod) @stmt
    `,
    exports: `
      (class_declaration declaration_kind: "class" name: (_) @name)
      (class_declaration declaration_kind: "struct" name: (_) @name)
      (class_declaration declaration_kind: "enum" name: (_) @name)
      (class_declaration declaration_kind: "extension" name: (user_type (type_identifier) @name))
      (class_declaration declaration_kind: "actor" name: (_) @name)
      (enum_entry name: (simple_identifier) @name)
      (protocol_declaration name: (type_identifier) @name)
      (function_declaration name: (simple_identifier) @name)
      (typealias_declaration name: (type_identifier) @name)
      (property_declaration name: (pattern bound_identifier: (simple_identifier) @name))
      (protocol_function_declaration name: (simple_identifier) @name)
      (protocol_property_declaration name: (pattern bound_identifier: (simple_identifier) @name))
    `,
    locals: `
      (class_declaration declaration_kind: "class" name: (_) @name)
      (class_declaration declaration_kind: "struct" name: (_) @name)
      (class_declaration declaration_kind: "enum" name: (_) @name)
      (class_declaration declaration_kind: "extension" name: (user_type (type_identifier) @name))
      (class_declaration declaration_kind: "actor" name: (_) @name)
      (enum_entry name: (simple_identifier) @name)
      (protocol_declaration name: (type_identifier) @name)
      (function_declaration name: (simple_identifier) @name)
      (typealias_declaration name: (type_identifier) @name)
      (property_declaration name: (pattern bound_identifier: (simple_identifier) @name))
      (parameter name: (simple_identifier) @name)
      (protocol_function_declaration name: (simple_identifier) @name)
      (protocol_property_declaration name: (pattern bound_identifier: (simple_identifier) @name))
    `,
    importBindings: `
      (import_declaration (identifier) @from) @stmt
    `,
  },
  nodeTypes: {
    identifier: ["identifier", "simple_identifier", "type_identifier"],
    propertyIdentifier: ["simple_identifier", "type_identifier"],
    memberExpression: "navigation_expression",
  },
  classifyDefinition: (node) => {
    const parent = node.parent;
    if (!parent) return "variable";
    if (parent.type === "function_declaration") return "function";
    if (parent.type === "protocol_function_declaration") return "function";
    if (parent.type === "class_declaration") {
      const declarationKind = parent.childForFieldName("declaration_kind")?.text;
      if (declarationKind === "enum") return "type";
      return "class";
    }
    // Extension names are wrapped in a user_type node
    // (`extension Container { ... }` -> name: (user_type (type_identifier))).
    if (parent.type === "user_type" && parent.parent?.type === "class_declaration") return "class";
    if (parent.type === "protocol_declaration" || parent.type === "typealias_declaration") return "type";
    return "variable";
  },
  isDeclarationName: (node) => {
    const parent = node.parent;
    if (!parent) return false;
    if (parent.type === "class_declaration" && parent.childForFieldName("name")?.id === node.id) return true;
    if (
      parent.type === "user_type" &&
      parent.parent?.type === "class_declaration" &&
      parent.parent.childForFieldName("name")?.id === parent.id
    )
      return true;
    if (parent.type === "protocol_declaration" && parent.childForFieldName("name")?.id === node.id) return true;
    if (parent.type === "enum_entry" && parent.childForFieldName("name")?.id === node.id) return true;
    if (parent.type === "function_declaration" && parent.childForFieldName("name")?.id === node.id) return true;
    if (parent.type === "typealias_declaration" && parent.childForFieldName("name")?.id === node.id) return true;
    if (parent.type === "parameter" && parent.childForFieldName("name")?.id === node.id) return true;
    if (parent.type === "protocol_function_declaration" && parent.childForFieldName("name")?.id === node.id)
      return true;
    if (parent.type === "protocol_property_declaration" && parent.childForFieldName("name")?.id === node.id)
      return true;
    if (
      parent.type === "pattern" &&
      parent.childForFieldName("bound_identifier")?.id === node.id &&
      (parent.parent?.type === "property_declaration" || parent.parent?.type === "protocol_property_declaration")
    )
      return true;
    return false;
  },
  scopeDeclarationNames: "all",
  createsFunctionScope: (node) =>
    node.type === "function_declaration" ||
    node.type === "init_declaration" ||
    node.type === "deinit_declaration" ||
    node.type === "subscript_declaration",
  createsBlockScope: (node) =>
    node.type === "function_body" ||
    node.type === "class_body" ||
    node.type === "protocol_body" ||
    node.type === "enum_class_body" ||
    node.type === "catch_block" ||
    node.type === "willset_didset_block",
  supportsCrossModuleSymbols: true,
};
registerLanguage(SWIFT_DEF);
