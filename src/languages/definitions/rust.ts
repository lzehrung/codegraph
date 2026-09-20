import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";
import { classifyByParentType, isNameFieldOnParent, nodeTypeIn } from "./shared.js";
import { hasNonAsciiCodePoint } from "../../util/identifiers.js";

export const RUST_DEF: LanguageDefinition = {
  id: "rust",
  extensions: [".rs"],
  usesQueryDrivenLocals: true,
  structure: {
    blocks: [
      {
        type: "function_item",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "function",
      },
      {
        type: "struct_item",
        nameQuery: "name: (type_identifier) @chunk.name",
        captureId: "struct",
      },
      {
        type: "enum_item",
        nameQuery: "name: (type_identifier) @chunk.name",
        captureId: "enum",
      },
      {
        type: "impl_item",
        nameQuery: "type: (type_identifier) @chunk.name",
        captureId: "impl",
      },
      {
        type: "mod_item",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "module",
      },
      {
        type: "macro_definition",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "macro",
      },
    ],
    splitPoints: ["if_expression", "for_expression", "while_expression", "loop_expression", "match_expression"],
    comments: ["line_comment", "block_comment"],
  },
  graph: {
    imports: `
      (mod_item name: (identifier) @from) @stmt
      (extern_crate_declaration name: (identifier) @from) @stmt
      (use_declaration argument: (_) @from) @stmt
    `,
    exports: `
      (function_item name: (identifier) @name) @stmt
      (function_signature_item name: (identifier) @name) @stmt
      (struct_item name: (type_identifier) @name) @stmt
      (trait_item name: (type_identifier) @name) @stmt
      (type_item name: (type_identifier) @name) @stmt
      (associated_type name: (type_identifier) @name) @stmt
      (enum_item name: (type_identifier) @name) @stmt
      (enum_variant name: (identifier) @name) @stmt
      (const_item name: (identifier) @name) @stmt
      (static_item name: (identifier) @name) @stmt
      (macro_definition name: (identifier) @name) @stmt
      (use_declaration argument: (scoped_identifier path: (_) @from name: (identifier) @src)) @stmt
      (use_declaration argument: (identifier) @src) @stmt
      ;; Grouped imports: \`use foo::{Bar, Baz};\` (and scoped forms like
      ;; \`use crate::foo::{Bar, Baz};\`) - emit one export per named member
      ;; so each is a resolvable target, matching the plain scoped_identifier
      ;; form above. The shared path may itself be scoped, so it is captured
      ;; generically rather than requiring a single bare identifier segment.
      (use_declaration argument: (scoped_use_list path: (_) @from list: (use_list (identifier) @src))) @stmt
      ;; Aliased members (\`use foo::Bar as Baz;\` and \`use foo::{Bar as Baz}\`) export under the
      ;; alias while keeping the original member as the source, so a consumer of the alias
      ;; resolves to the real definition.
      (use_declaration argument: (use_as_clause path: (scoped_identifier path: (_) @from name: (identifier) @src) alias: (identifier) @alias)) @stmt
      (use_declaration argument: (scoped_use_list path: (_) @from list: (use_list (use_as_clause path: (identifier) @src alias: (identifier) @alias)))) @stmt
    `,
    locals: `
      (function_item name: (identifier) @name)
      (function_signature_item name: (identifier) @name)
      (struct_item name: (type_identifier) @name)
      (trait_item name: (type_identifier) @name)
      (type_item name: (type_identifier) @name)
      (associated_type name: (type_identifier) @name)
      (enum_item name: (type_identifier) @name)
      (enum_variant name: (identifier) @name)
      (const_item name: (identifier) @name)
      (static_item name: (identifier) @name)
      (macro_definition name: (identifier) @name)
      (let_declaration pattern: (identifier) @name)
      (parameter pattern: (identifier) @name)
    `,
    importBindings: `
      (mod_item name: (identifier) @from) @stmt
      (extern_crate_declaration name: (identifier) @from) @stmt
      (extern_crate_declaration name: (identifier) @from alias: (identifier) @alias) @stmt
      (use_declaration argument: (use_as_clause path: (identifier) @from alias: (identifier) @alias)) @stmt
      (use_declaration argument: (use_as_clause path: (scoped_identifier path: (_) @from name: (identifier) @iname) alias: (identifier) @alias)) @stmt
      (use_declaration argument: (scoped_identifier path: (_) @from name: (identifier) @iname)) @stmt
      (use_declaration argument: (use_wildcard) @from @wild) @stmt
      (use_declaration argument: (identifier) @from) @stmt
      (use_declaration argument: (scoped_use_list path: (_) @from list: (use_list (identifier) @iname))) @stmt
      ;; Aliased members inside a group (\`use foo::{Bar as Baz}\`): import
      ;; the original name under its local alias.
      (use_declaration argument: (scoped_use_list path: (_) @from list: (use_list (use_as_clause path: (identifier) @iname alias: (identifier) @alias)))) @stmt
    `,
  },
  nodeTypes: {
    identifier: ["identifier", "type_identifier"],
    memberExpression: "field_expression",
  },
  supportsCrossModuleSymbols: true,
  exportScopeBlockers: ["block"],
  scopeDeclarationNames: (node) => node.parent?.type === "macro_definition",
  classifyDefinition: classifyByParentType({
    function_item: "function",
    function_signature_item: "function",
    macro_definition: "function",
    enum_item: "type",
    type_item: "type",
    associated_type: "type",
    struct_item: "class",
    trait_item: "class",
  }),
  createsFunctionScope: nodeTypeIn(["function_item"]),
  createsBlockScope: nodeTypeIn(["block"]),
  isDeclarationName: (node) =>
    isNameFieldOnParent(node, [
      "function_item",
      "function_signature_item",
      "struct_item",
      "trait_item",
      "type_item",
      "associated_type",
      "enum_item",
      "enum_variant",
      "const_item",
      "static_item",
      "macro_definition",
    ]) || isNameFieldOnParent(node, ["let_declaration", "parameter"], "pattern"),
  normalizeIdentifier: (name) => (hasNonAsciiCodePoint(name) ? name.normalize("NFC") : name),
};
registerLanguage(RUST_DEF);
