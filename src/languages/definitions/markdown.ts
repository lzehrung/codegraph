import type { LanguageDefinition } from "../types.js";
import { loadTreeSitterLanguage } from "./loadLanguage.js";
import { registerLanguage } from "../registry.js";

export const MARKDOWN_DEF: LanguageDefinition = {
  id: "markdown",
  extensions: [".md"],
  // Markdown is graph-first for now; HTML is only used as a permissive stub
  // when generic parser plumbing asks for a language object.
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

registerLanguage(MARKDOWN_DEF);
