import type { Language } from "tree-sitter";
import type { LanguageDefinition } from "../types.js";
import { loadTreeSitterLanguage } from "./loadLanguage.js";

const LangSvelte = loadTreeSitterLanguage("tree-sitter-svelte");

export const SVELTE_DEF: LanguageDefinition = {
  id: "svelte",
  extensions: [".svelte"],
  grammar: () => LangSvelte,
  structure: {
    blocks: [
      { type: "script_element", captureId: "script" },
      { type: "style_element", captureId: "style" },
      { type: "element", captureId: "element" },
    ],
    splitPoints: ["script_element", "style_element"],
    comments: ["comment"],
  },
  graph: {
    imports: `
      (script_element (start_tag (attribute (attribute_name) @attr (#eq? @attr "src") (quoted_attribute_value (attribute_value) @mod)))) @stmt
    `,
    exports: "",
    locals: "",
    importBindings: `
      (script_element (start_tag (attribute (attribute_name) @attr (#eq? @attr "src") (quoted_attribute_value (attribute_value) @from)))) @stmt
    `,
  },
  nodeTypes: {
    identifier: ["attribute_value"],
  },
};
