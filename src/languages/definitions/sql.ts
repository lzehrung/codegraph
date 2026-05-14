import type { LanguageDefinition } from "../types.js";
import { loadTreeSitterLanguage } from "./loadLanguage.js";
import { registerLanguage } from "../registry.js";

export const SQL_DEF: LanguageDefinition = {
  id: "sql",
  extensions: [".sql"],
  grammar: () => loadTreeSitterLanguage("@derekstride/tree-sitter-sql"),
  structure: {
    blocks: [
      { type: "statement", nameQuery: "(create_table)", captureId: "create" },
      { type: "statement", nameQuery: "(create_view)", captureId: "create" },
      { type: "statement", nameQuery: "(create_materialized_view)", captureId: "create" },
      { type: "statement", nameQuery: "(create_index)", captureId: "create" },
      { type: "statement", nameQuery: "(create_function)", captureId: "routine" },
      { type: "statement", nameQuery: "(create_trigger)", captureId: "routine" },
      { type: "statement", nameQuery: "(alter_table)", captureId: "alter" },
      { type: "statement", nameQuery: "(drop_table)", captureId: "drop" },
      { type: "statement", nameQuery: "(drop_view)", captureId: "drop" },
      { type: "statement", nameQuery: "(drop_index)", captureId: "drop" },
      { type: "statement", nameQuery: "(insert)", captureId: "write" },
      { type: "statement", nameQuery: "(update)", captureId: "write" },
      { type: "statement", nameQuery: "(delete)", captureId: "write" },
      { type: "statement", nameQuery: "(select)", captureId: "select" },
    ],
    splitPoints: [],
    comments: ["comment"],
  },
  graph: {
    imports: "(statement) @stmt",
    exports: "",
    locals: "",
    importBindings: "",
  },
  supportsCrossModuleSymbols: false,
};

registerLanguage(SQL_DEF);
