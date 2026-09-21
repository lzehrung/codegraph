import type { LanguageDefinition } from "../types.js";
import { graphCapture } from "../graph-captures.js";

const from = graphCapture("from");
const stmt = graphCapture("stmt");

const cssLikeImportQuery = `
      (import_statement (string_value) ${from}) ${stmt}
    `;

const cssLikeLocalsQuery = `
      (class_selector (class_name) @name)
      (id_selector (id_name) @name)
    `;

export function cssLikeStructure(): LanguageDefinition["structure"] {
  return {
    blocks: [
      { type: "rule_set", captureId: "rule" },
      { type: "media_statement", captureId: "media" },
      { type: "keyframes_statement", captureId: "keyframes" },
    ],
    splitPoints: ["rule_set"],
    comments: ["comment", "js_comment"],
  };
}

export function cssLikeGraph(): LanguageDefinition["graph"] {
  return {
    imports: cssLikeImportQuery,
    exports: "",
    locals: cssLikeLocalsQuery,
    importBindings: cssLikeImportQuery,
  };
}

export function cssLikeNodeTypes(): NonNullable<LanguageDefinition["nodeTypes"]> {
  return {
    identifier: ["class_name", "id_name"],
  };
}
