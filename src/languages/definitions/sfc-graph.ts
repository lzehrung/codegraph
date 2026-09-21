import type { LanguageDefinition } from "../types.js";
import { graphCapture } from "../graph-captures.js";

const from = graphCapture("from");
const stmt = graphCapture("stmt");

const sfcExternalScriptQuery = `
      (script_element (start_tag (attribute (attribute_name) @attr (#eq? @attr "src") (quoted_attribute_value (attribute_value) ${from})))) ${stmt}
    `;

/** Shared Vue/Svelte graph: only the external `<script src>` asset edge. */
export function sfcExternalScriptGraph(): LanguageDefinition["graph"] {
  return {
    imports: sfcExternalScriptQuery,
    exports: "",
    locals: "",
    importBindings: sfcExternalScriptQuery,
  };
}
