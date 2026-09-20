import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";
import { sfcExternalScriptGraph } from "./sfc-graph.js";

export const VUE_DEF: LanguageDefinition = {
  id: "vue",
  extensions: [".vue"],
  structure: {
    blocks: [
      { type: "template_element", captureId: "template" },
      { type: "script_element", captureId: "script" },
      { type: "style_element", captureId: "style" },
    ],
    splitPoints: ["template_element", "script_element", "style_element"],
    comments: ["comment"],
  },
  graph: sfcExternalScriptGraph(),
  nodeTypes: {
    identifier: ["attribute_value"],
  },
};
registerLanguage(VUE_DEF);
