import type { LanguageDefinition } from "../types.js";

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
    imports: `
      (import_statement (string_value) @mod) @stmt
    `,
    exports: "",
    locals: `
      (class_selector (class_name) @name)
      (id_selector (id_name) @name)
    `,
    importBindings: `
      (import_statement (string_value) @from) @stmt
    `,
  };
}

export function cssLikeNodeTypes(): NonNullable<LanguageDefinition["nodeTypes"]> {
  return {
    identifier: ["class_name", "id_name"],
  };
}
