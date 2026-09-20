import type { LanguageDefinition } from "../types.js";
import { graphCapture, type GraphImportCapture } from "../graph-captures.js";
import { registerLanguage } from "../registry.js";

function htmlAssetImportQuery(valueCapture: GraphImportCapture): string {
  const value = graphCapture(valueCapture);
  const stmt = graphCapture("stmt");
  return `
      (script_element (start_tag (attribute (attribute_name) @attr (#match? @attr "^(?i)src$") (quoted_attribute_value (attribute_value) ${value})))) ${stmt}
      ((element (start_tag (tag_name) @tag (attribute (attribute_name) @attr (#match? @attr "^(?i)href$") (quoted_attribute_value (attribute_value) ${value})))) ${stmt} (#match? @tag "^(?i)(link|a)$"))
      ((element (self_closing_tag (tag_name) @tag (attribute (attribute_name) @attr (#match? @attr "^(?i)href$") (quoted_attribute_value (attribute_value) ${value})))) ${stmt} (#match? @tag "^(?i)(link|a)$"))
      ((element (start_tag (tag_name) @tag (attribute (attribute_name) @attr (#match? @attr "^(?i)src$") (quoted_attribute_value (attribute_value) ${value})))) ${stmt} (#match? @tag "^(?i)img$"))
      ((element (self_closing_tag (tag_name) @tag (attribute (attribute_name) @attr (#match? @attr "^(?i)src$") (quoted_attribute_value (attribute_value) ${value})))) ${stmt} (#match? @tag "^(?i)img$"))
    `;
}

const htmlAssetImports = htmlAssetImportQuery("from");

export const HTML_DEF: LanguageDefinition = {
  id: "html",
  extensions: [".html", ".htm", ".xhtml"],
  structure: {
    blocks: [
      {
        type: "element",
        nameQuery: `(start_tag (attribute (attribute_name) @attr (#match? @attr "^(?i)id$") (quoted_attribute_value (attribute_value) @chunk.name)))`,
        captureId: "element",
      },
      { type: "script_element", captureId: "script" },
      { type: "style_element", captureId: "style" },
    ],
    splitPoints: ["element"],
    comments: ["comment"],
  },
  graph: {
    imports: htmlAssetImports,
    exports: "",
    locals: `
      (attribute (attribute_name) @attr (#match? @attr "^(?i)id$") (quoted_attribute_value (attribute_value) @name))
    `,
    importBindings: htmlAssetImports,
  },
  nodeTypes: {
    identifier: ["attribute_value", "tag_name"],
  },
};
registerLanguage(HTML_DEF);
