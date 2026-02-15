import type { LanguageDefinition } from "../types.js";
import { loadTreeSitterLanguage } from "./loadLanguage.js";
import { registerLanguage } from "../registry.js";

export const SCSS_DEF: LanguageDefinition = {
  id: "scss",
  extensions: [".scss"],
  grammar: () => loadTreeSitterLanguage("tree-sitter-scss"),
  structure: {
    blocks: [
      { type: "rule_set", captureId: "rule" },
      { type: "mixin_statement", captureId: "mixin" },
      { type: "function_statement", captureId: "function" },
      { type: "media_statement", captureId: "media" },
      { type: "keyframes_statement", captureId: "keyframes" },
    ],
    splitPoints: ["rule_set", "mixin_statement", "function_statement"],
    comments: ["comment", "js_comment"],
  },
  graph: {
    imports: `
      (import_statement (string_value) @mod) @stmt
      (use_statement (string_value) @mod) @stmt
      (forward_statement (string_value) @mod) @stmt
    `,
    exports: `
      (mixin_statement (name) @name)
      (function_statement (name) @name)
      (variable_declaration (variable) @name)
    `,
    locals: `
      (mixin_statement (name) @name)
      (function_statement (name) @name)
      (variable_declaration (variable) @name)
      (class_selector (class_name) @name)
      (id_selector (id_name) @name)
    `,
    importBindings: `
      (import_statement (string_value) @from) @stmt
      (use_statement (string_value) @from) @stmt
      (forward_statement (string_value) @from) @stmt
    `,
  },
  nodeTypes: {
    identifier: ["name", "variable", "class_name", "id_name"],
  },
};
registerLanguage(SCSS_DEF);
