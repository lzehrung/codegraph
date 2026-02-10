import type { Language } from "tree-sitter";
import type { LanguageDefinition } from "../types.js";
import { loadTreeSitterLanguage } from "./loadLanguage.js";
import { registerLanguage } from "../registry.js";

export const HTML_DEF: LanguageDefinition = {
  id: "html",
  extensions: [".html", ".htm"],
  grammar: () => loadTreeSitterLanguage("tree-sitter-html"),
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
      (element (start_tag (tag_name) @tag (attribute (attribute_name) @attr (#eq? @attr "href") (quoted_attribute_value (attribute_value) @mod)))) @stmt (#match? @tag "^(link|a)$")
      (element (self_closing_tag (tag_name) @tag (attribute (attribute_name) @attr (#eq? @attr "href") (quoted_attribute_value (attribute_value) @mod)))) @stmt (#match? @tag "^(link|a)$")
      (element (start_tag (tag_name) @tag (attribute (attribute_name) @attr (#eq? @attr "src") (quoted_attribute_value (attribute_value) @mod)))) @stmt (#eq? @tag "img")
      (element (self_closing_tag (tag_name) @tag (attribute (attribute_name) @attr (#eq? @attr "src") (quoted_attribute_value (attribute_value) @mod)))) @stmt (#eq? @tag "img")
    `,
    exports: "",
    locals: `
      (attribute (attribute_name) @attr (#eq? @attr "id") (quoted_attribute_value (attribute_value) @name))
    `,
    importBindings: `
      (script_element (start_tag (attribute (attribute_name) @attr (#eq? @attr "src") (quoted_attribute_value (attribute_value) @from)))) @stmt
      (element (start_tag (tag_name) @tag (attribute (attribute_name) @attr (#eq? @attr "href") (quoted_attribute_value (attribute_value) @from)))) @stmt (#match? @tag "^(link|a)$")
      (element (self_closing_tag (tag_name) @tag (attribute (attribute_name) @attr (#eq? @attr "href") (quoted_attribute_value (attribute_value) @from)))) @stmt (#match? @tag "^(link|a)$")
      (element (start_tag (tag_name) @tag (attribute (attribute_name) @attr (#eq? @attr "src") (quoted_attribute_value (attribute_value) @from)))) @stmt (#eq? @tag "img")
      (element (self_closing_tag (tag_name) @tag (attribute (attribute_name) @attr (#eq? @attr "src") (quoted_attribute_value (attribute_value) @from)))) @stmt (#eq? @tag "img")
    `,
  },
  nodeTypes: {
    identifier: ["attribute_value", "tag_name"],
  },
};
registerLanguage(HTML_DEF);
