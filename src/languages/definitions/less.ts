import type { LanguageDefinition } from "../types.js";
import { loadTreeSitterLanguage } from "./loadLanguage.js";
import { registerLanguage } from "../registry.js";

export const LESS_DEF: LanguageDefinition = {
  id: "less",
  extensions: [".less"],
  grammar: () => loadTreeSitterLanguage("tree-sitter-css"),
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
registerLanguage(LESS_DEF);
