import type { Language } from "tree-sitter";
import type { LanguageDefinition } from "../types.js";

let cachedLanguage: Language | null = null;

async function loadLanguage(): Promise<Language> {
  if (!cachedLanguage) {
    const mod = await import("tree-sitter-vue");
    cachedLanguage = mod.default;
  }
  return cachedLanguage;
}

export const VUE_DEF: LanguageDefinition = {
  id: "vue",
  extensions: [".vue"],
  grammar: () => loadLanguage(),
  structure: {
    blocks: [
      { type: "template_element", captureId: "template" },
      { type: "script_element", captureId: "script" },
      { type: "style_element", captureId: "style" },
    ],
    splitPoints: ["template_element", "script_element", "style_element"],
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
