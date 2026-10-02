import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";
import { isNameFieldOnParent, nodeTypeIn } from "./shared.js";

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
    // Pinned tree-sitter-swift: the path is always one `identifier` node, including
    // dotted paths (`Foundation.NSString`). Kind keywords (`class`, `struct`, `func`,
    // `enum`, `typealias`) are anonymous. `simple_identifier` is not a child of
    // `import_declaration` (Impossible pattern). No alias or wildcard node.
    imports: `
      (import_declaration (identifier) @from) @stmt
    `,
    exports: `
      (source_file (class_declaration declaration_kind: "class" name: (_) @name))
      (class_body (class_declaration declaration_kind: "class" name: (_) @name))
      (enum_class_body (class_declaration declaration_kind: "class" name: (_) @name))
      (source_file (class_declaration declaration_kind: "struct" name: (_) @name))
      (class_body (class_declaration declaration_kind: "struct" name: (_) @name))
      (enum_class_body (class_declaration declaration_kind: "struct" name: (_) @name))
      (source_file (class_declaration declaration_kind: "enum" name: (_) @name))
      (class_body (class_declaration declaration_kind: "enum" name: (_) @name))
      (enum_class_body (class_declaration declaration_kind: "enum" name: (_) @name))
      (source_file (class_declaration declaration_kind: "extension" name: (user_type (type_identifier) @name)))
      (class_body (class_declaration declaration_kind: "extension" name: (user_type (type_identifier) @name)))
      (enum_class_body (class_declaration declaration_kind: "extension" name: (user_type (type_identifier) @name)))
      (source_file (class_declaration declaration_kind: "actor" name: (_) @name))
      (class_body (class_declaration declaration_kind: "actor" name: (_) @name))
      (enum_class_body (class_declaration declaration_kind: "actor" name: (_) @name))
      (enum_class_body (enum_entry name: (simple_identifier) @name))
      (source_file (protocol_declaration name: (type_identifier) @name))
      (class_body (protocol_declaration name: (type_identifier) @name))
      (enum_class_body (protocol_declaration name: (type_identifier) @name))
      (source_file (function_declaration name: (simple_identifier) @name))
      (class_body (function_declaration name: (simple_identifier) @name))
      (enum_class_body (function_declaration name: (simple_identifier) @name))
      (source_file (typealias_declaration name: (type_identifier) @name))
      (class_body (typealias_declaration name: (type_identifier) @name))
      (enum_class_body (typealias_declaration name: (type_identifier) @name))
      (protocol_body (typealias_declaration name: (type_identifier) @name))
      (source_file (property_declaration name: (pattern bound_identifier: (simple_identifier) @name)))
      (class_body (property_declaration name: (pattern bound_identifier: (simple_identifier) @name)))
      (enum_class_body (property_declaration name: (pattern bound_identifier: (simple_identifier) @name)))
      (protocol_body (protocol_function_declaration name: (simple_identifier) @name))
      (protocol_body (protocol_property_declaration name: (pattern bound_identifier: (simple_identifier) @name)))
      (source_file (associatedtype_declaration name: (type_identifier) @name))
      (protocol_body (associatedtype_declaration name: (type_identifier) @name))
      (class_body (associatedtype_declaration name: (type_identifier) @name))
      (enum_class_body (associatedtype_declaration name: (type_identifier) @name))
      (source_file (macro_declaration (simple_identifier) @name))
      (source_file (operator_declaration [(custom_operator) (simple_identifier) (bang)] @name))
      (class_body (operator_declaration [(custom_operator) (simple_identifier) (bang)] @name))
      (enum_class_body (operator_declaration [(custom_operator) (simple_identifier) (bang)] @name))
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
      (associatedtype_declaration name: (type_identifier) @name)
      (macro_declaration (simple_identifier) @name)
      (operator_declaration [(custom_operator) (simple_identifier) (bang)] @name)
    `,
    // Same path node as `imports`; Swift has no import alias or star token.
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
    if (
      parent.type === "function_declaration" ||
      parent.type === "protocol_function_declaration" ||
      parent.type === "init_declaration" ||
      parent.type === "deinit_declaration" ||
      parent.type === "subscript_declaration" ||
      parent.type === "macro_declaration" ||
      parent.type === "operator_declaration"
    )
      return "function";
    if (parent.type === "class_declaration") {
      const declarationKind = parent.childForFieldName("declaration_kind")?.text;
      if (declarationKind === "enum") return "type";
      return "class";
    }
    // Extension names are wrapped in a user_type node
    // (`extension Container { ... }` -> name: (user_type (type_identifier))).
    if (parent.type === "user_type" && parent.parent?.type === "class_declaration") return "class";
    if (
      parent.type === "protocol_declaration" ||
      parent.type === "typealias_declaration" ||
      parent.type === "associatedtype_declaration"
    )
      return "type";
    return "variable";
  },
  isDeclarationName: (node) => {
    const parent = node.parent;
    if (!parent) return false;
    if (isNameFieldOnParent(node, ["class_declaration"])) return true;
    // Extension names are wrapped in a user_type node
    // (`extension Container { ... }` -> name: (user_type (type_identifier))).
    if (
      parent.type === "user_type" &&
      parent.parent?.type === "class_declaration" &&
      parent.parent.childForFieldName("name")?.id === parent.id
    )
      return true;
    if (
      isNameFieldOnParent(node, [
        "protocol_declaration",
        "enum_entry",
        "function_declaration",
        "typealias_declaration",
        "associatedtype_declaration",
        "parameter",
        "protocol_function_declaration",
        "protocol_property_declaration",
      ])
    )
      return true;
    if (parent.type === "macro_declaration" && node.type === "simple_identifier") return true;
    if (
      parent.type === "operator_declaration" &&
      (node.type === "custom_operator" || node.type === "simple_identifier" || node.type === "bang")
    )
      return true;
    if (parent.type === "init_declaration" && node.type === "init") return true;
    if (parent.type === "deinit_declaration" && node.type === "deinit") return true;
    if (parent.type === "subscript_declaration" && node.type === "subscript") return true;
    return (
      parent.type === "pattern" &&
      parent.childForFieldName("bound_identifier")?.id === node.id &&
      (parent.parent?.type === "property_declaration" || parent.parent?.type === "protocol_property_declaration")
    );
  },
  scopeDeclarationNames: "all",
  createsFunctionScope: nodeTypeIn([
    "function_declaration",
    "init_declaration",
    "deinit_declaration",
    "subscript_declaration",
  ]),
  createsBlockScope: nodeTypeIn([
    "function_body",
    "class_body",
    "protocol_body",
    "enum_class_body",
    "catch_block",
    "willset_didset_block",
  ]),
  supportsCrossModuleSymbols: true,
  membersAreImplicitlyInScope: true,
  exportScopeBlockers: ["function_body", "lambda_literal"],
};
registerLanguage(SWIFT_DEF);
