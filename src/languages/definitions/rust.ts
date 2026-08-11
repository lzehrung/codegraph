import type { LanguageDefinition } from "../types.js";
import { loadTreeSitterLanguage } from "./loadLanguage.js";
import { registerLanguage } from "../registry.js";

export const RUST_DEF: LanguageDefinition = {
  id: "rust",
  extensions: [".rs"],
  grammar: () => loadTreeSitterLanguage("tree-sitter-rust"),
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
      (mod_item name: (identifier) @mod) @stmt
      (extern_crate_declaration name: (identifier) @mod) @stmt
      (use_declaration argument: (_) @mod) @stmt
    `,
    exports: `
      (function_item name: (identifier) @name) @stmt
      (struct_item name: (type_identifier) @name) @stmt
      (trait_item name: (type_identifier) @name) @stmt
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
      ;; Aliased members inside a group (\`use foo::{Bar as Baz}\`) export
      ;; under their alias, matching how a single aliased import behaves.
      (use_declaration argument: (scoped_use_list path: (_) @from list: (use_list (use_as_clause alias: (identifier) @src)))) @stmt
    `,
    locals: `
      (function_item name: (identifier) @name)
      (struct_item name: (type_identifier) @name)
      (trait_item name: (type_identifier) @name)
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
  scopeDeclarationNames: (node) => node.parent?.type === "macro_definition",
  classifyDefinition: (node) => {
    const parent = node.parent;
    if (!parent) return "variable";
    if (parent.type === "function_item" || parent.type === "macro_definition") return "function";
    if (parent.type === "enum_item") return "type";
    if (parent.type === "struct_item" || parent.type === "trait_item") return "class";
    return "variable";
  },
  createsFunctionScope: (node) => node.type === "function_item",
  createsBlockScope: (node) => node.type === "block",
  membersAreImplicitlyInScope: false,
  isDeclarationName: (node) => {
    const p = node.parent;
    if (!p) return false;
    if (p.type === "function_item" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "struct_item" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "trait_item" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "enum_item" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "enum_variant" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "const_item" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "static_item" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "macro_definition" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "let_declaration" && p.childForFieldName("pattern")?.id === node.id) return true;
    if (p.type === "parameter" && p.childForFieldName("pattern")?.id === node.id) return true;
    return false;
  },
};
registerLanguage(RUST_DEF);
