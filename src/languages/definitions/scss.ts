import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";

export const SCSS_DEF: LanguageDefinition = {
  id: "scss",
  extensions: [".scss"],
  usesQueryDrivenLocals: true,
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
      (import_statement (_ (string_value) @mod)) @stmt
      (use_statement (string_value) @mod) @stmt
      (use_statement (_ (string_value) @mod)) @stmt
      (forward_statement (string_value) @mod) @stmt
      (forward_statement (_ (string_value) @mod)) @stmt
    `,
    exports: `
      (stylesheet (mixin_statement name: (identifier) @name))
      (stylesheet (function_statement name: (identifier) @name))
      ((stylesheet (declaration (property_name) @name)) (#match? @name "^[$]"))
      (stylesheet (rule_set (selectors (placeholder (identifier) @name))))
    `,
    locals: `
      (mixin_statement name: (identifier) @name)
      (function_statement name: (identifier) @name)
      ((declaration (property_name) @name) (#match? @name "^[$]"))
      (placeholder (identifier) @name)
      (class_selector (class_name) @name)
      (id_selector (id_name) @name)
    `,
    importBindings: `
      (import_statement (string_value) @from) @stmt
      (import_statement (_ (string_value) @from)) @stmt
      (use_statement (string_value) @from) @stmt
      (use_statement (_ (string_value) @from)) @stmt
      (forward_statement (string_value) @from) @stmt
      (forward_statement (_ (string_value) @from)) @stmt
    `,
  },
  nodeTypes: {
    identifier: ["identifier", "variable", "class_name", "id_name", "property_name"],
  },
  classifyDefinition: (node) => {
    const parent = node.parent?.type;
    if (parent === "mixin_statement" || parent === "function_statement") return "function";
    return "variable";
  },
};
registerLanguage(SCSS_DEF);
