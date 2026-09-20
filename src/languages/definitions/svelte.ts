import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";
import { sfcExternalScriptGraph } from "./sfc-graph.js";

export const SVELTE_DEF: LanguageDefinition = {
  id: "svelte",
  extensions: [".svelte"],
  structure: {
    blocks: [
      { type: "script_element", captureId: "script" },
      { type: "style_element", captureId: "style" },
      { type: "element", captureId: "element" },
    ],
    splitPoints: ["script_element", "style_element"],
    comments: ["comment"],
  },
  graph: sfcExternalScriptGraph(),
  nodeTypes: {
    identifier: ["attribute_value"],
  },
};
registerLanguage(SVELTE_DEF);
