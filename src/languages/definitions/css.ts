import type { Language } from "tree-sitter";
import type { LanguageDefinition } from "../types.js";

const { default: CSS } = await import("tree-sitter-css");
const LangCSS: Language = CSS;

export const CSS_DEF: LanguageDefinition = {
  id: "css",
  extensions: [".css"],
  grammar: () => LangCSS,
  structure: {
    blocks: [
      { type: "rule_set", captureId: "rule" },
      { type: "media_statement", captureId: "media" },
      { type: "keyframes_statement", captureId: "keyframes" },
    ],
    splitPoints: ["rule_set"],
    comments: ["comment", "js_comment"],
  },
  graph: {
    imports: `
      (import_statement (string_value) @mod) @stmt
    `,
    exports: "",
    locals: `
      (class_selector (class_name) @name)
      (id_selector (id_name) @name)
    `,
    importBindings: `
      (import_statement (string_value) @from) @stmt
    `,
  },
  nodeTypes: {
    identifier: ["class_name", "id_name"],
  },
};
