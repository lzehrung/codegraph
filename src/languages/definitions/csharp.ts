import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";
import { classifyByParentType, isNameFieldOnParent, nodeTypeIn } from "./shared.js";
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
    // Path node is `identifier` | `qualified_name` | `alias_qualified_name` (`global::System`).
    // An identifier/qualified_name alternation misses `alias_qualified_name`, so keep `(_)`.
    imports: `
      (using_directive !name (_) @from) @stmt
      (using_directive name: (identifier) (_) @from) @stmt
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
      (record_declaration (parameter_list (parameter name: (identifier) @name)))
      (method_declaration (parameter_list (parameter name: (identifier) @name)))
      (constructor_declaration (parameter_list (parameter name: (identifier) @name)))
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
    // extern alias has no path node in the grammar, so there is no @from.
    // using path node: identifier | qualified_name | alias_qualified_name — keep `(_)`.
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
  membersAreImplicitlyInScope: true,
  classifyDefinition: classifyByParentType({
    method_declaration: "method",
    constructor_declaration: "method",
    destructor_declaration: "method",
    local_function_statement: "method",
    class_declaration: "class",
    record_declaration: "class",
    struct_declaration: "class",
    interface_declaration: "interface",
    enum_declaration: "type",
    delegate_declaration: "type",
  }),
  createsFunctionScope: nodeTypeIn([
    "method_declaration",
    "constructor_declaration",
    "destructor_declaration",
    "local_function_statement",
  ]),
  createsBlockScope: nodeTypeIn(["block", "declaration_list"]),
  isDeclarationName: (node) =>
    isNameFieldOnParent(node, [
      "class_declaration",
      "record_declaration",
      "struct_declaration",
      "interface_declaration",
      "enum_declaration",
      "delegate_declaration",
      "enum_member_declaration",
      "method_declaration",
      "constructor_declaration",
      "destructor_declaration",
      "local_function_statement",
      "property_declaration",
      "variable_declarator",
      "parameter",
      "declaration_pattern",
    ]),
  normalizeIdentifier: (name) => {
    const withoutVerbatimPrefix = name.startsWith("@") ? name.slice(1) : name;
    return hasNonAsciiCodePoint(withoutVerbatimPrefix)
      ? withoutVerbatimPrefix.replace(CSHARP_IDENTIFIER_FORMAT_PATTERN, "")
      : withoutVerbatimPrefix;
  },
};
registerLanguage(CSHARP_DEF);
