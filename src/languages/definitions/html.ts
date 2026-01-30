import type { Language } from "tree-sitter";
import type { LanguageDefinition } from "../types.js";

let cachedLanguage: Language | null = null;

async function loadLanguage(): Promise<Language> {
  if (!cachedLanguage) {
    const mod = await import("tree-sitter-html");
    cachedLanguage = mod.default;
  }
  return cachedLanguage;
}

export const HTML_DEF: LanguageDefinition = {
  id: "html",
  extensions: [".html", ".htm"],
  grammar: () => loadLanguage(),
  structure: {
    blocks: [
      {
        type: "element",
        nameQuery: `(start_tag (attribute (attribute_name) @attr (#eq? @attr "id") (quoted_attribute_value (attribute_value) @chunk.name)))`,
        captureId: "element",
      },
      { type: "script_element", captureId: "script" },
      { type: "style_element", captureId: "style" },
    ],
    splitPoints: ["element"],
    comments: ["comment"],
  },
  graph: {
    imports: `
      (script_element (start_tag (attribute (attribute_name) @attr (#eq? @attr "src") (quoted_attribute_value (attribute_value) @mod)))) @stmt
      (element (start_tag (tag_name) @tag (attribute (attribute_name) @attr (#eq? @attr "href") (quoted_attribute_value (attribute_value) @mod)))) @stmt (#eq? @tag "link")
      (element (self_closing_tag (tag_name) @tag (attribute (attribute_name) @attr (#eq? @attr "href") (quoted_attribute_value (attribute_value) @mod)))) @stmt (#eq? @tag "link")
    `,
    exports: "",
    locals: `
      (attribute (attribute_name) @attr (#eq? @attr "id") (quoted_attribute_value (attribute_value) @name))
    `,
    importBindings: `
      (script_element (start_tag (attribute (attribute_name) @attr (#eq? @attr "src") (quoted_attribute_value (attribute_value) @from)))) @stmt
      (element (start_tag (tag_name) @tag (attribute (attribute_name) @attr (#eq? @attr "href") (quoted_attribute_value (attribute_value) @from)))) @stmt (#eq? @tag "link")
      (element (self_closing_tag (tag_name) @tag (attribute (attribute_name) @attr (#eq? @attr "href") (quoted_attribute_value (attribute_value) @from)))) @stmt (#eq? @tag "link")
    `,
  },
  nodeTypes: {
    identifier: ["attribute_value", "tag_name"],
  },
};
