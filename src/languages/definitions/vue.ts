import type { Language } from "tree-sitter";
import Vue from "tree-sitter-vue";
import type { LanguageDefinition } from "../types.js";

const LangVue = Vue as unknown as Language;

export const VUE_DEF: LanguageDefinition = {
  id: "vue",
  extensions: [".vue"],
  grammar: () => LangVue,
  structure: {
    blocks: [
      { type: "template_element", captureId: "template" },
      { type: "script_element", captureId: "script" },
      { type: "style_element", captureId: "style" }
    ],
    splitPoints: ["template_element", "script_element", "style_element"],
    comments: ["comment"]
  },
  graph: {
    imports: `
      (script_element (start_tag (attribute (attribute_name) @attr (#eq? @attr "src") (quoted_attribute_value (attribute_value) @mod)))) @stmt
    `,
    exports: "",
    locals: "",
    importBindings: ""
  },
  nodeTypes: {
    identifier: ["attribute_value"],
  }
};

