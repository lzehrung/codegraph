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
      (selectors (placeholder (identifier) @name))
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
  isDeclarationName: (node) => {
    const parent = node.parent;
    if (!parent) return false;
    if (parent.type === "mixin_statement" || parent.type === "function_statement") {
      return parent.childForFieldName("name")?.id === node.id;
    }
    if (parent.type === "declaration" && node.type === "property_name") {
      return node.text.startsWith("$");
    }
    // A placeholder in a selector list is a declaration. `@extend %name` is a use;
    // the pinned grammar currently wraps that form in ERROR rather than extend_statement.
    if (parent.type === "placeholder") {
      return parent.parent?.type === "selectors";
    }
    if (node.type === "class_name") return parent.type === "class_selector";
    if (node.type === "id_name") return parent.type === "id_selector";
    return false;
  },
  scopeDeclarationNames: "all",
};
registerLanguage(SCSS_DEF);
