import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";
import { classifyByParentType, isNameFieldOnParent, nodeTypeIn } from "./shared.js";
import { normalizeCsharpIdentifier } from "../../util/identifiers.js";

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
    // C# using directives are read from the syntax tree (src/util/csharp-tree.ts), so no imports query runs.
    imports: "",
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
    // C# using and extern-alias directives are read from the syntax tree (src/util/csharp-tree.ts), so no
    // import-binding query runs.
    importBindings: "",
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
  normalizeIdentifier: normalizeCsharpIdentifier,
};
registerLanguage(CSHARP_DEF);
