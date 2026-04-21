import type { LanguageDefinition } from "../types.js";
import { loadTreeSitterLanguage } from "./loadLanguage.js";
import { registerLanguage } from "../registry.js";

export const ADOC_DEF: LanguageDefinition = {
  id: "adoc",
  extensions: [".adoc", ".asciidoc"],
  // AsciiDoc is graph-first for now; HTML is used only as a permissive parser stub.
  grammar: () => loadTreeSitterLanguage("tree-sitter-html"),
  structure: {
    blocks: [],
    splitPoints: [],
    comments: [],
  },
  graph: {
    imports: "",
    exports: "",
    locals: "",
    importBindings: "",
  },
  nodeTypes: {
    identifier: [],
  },
};

registerLanguage(ADOC_DEF);
