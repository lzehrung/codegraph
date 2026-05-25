import type { LanguageDefinition } from "../types.js";
import { loadTreeSitterLanguage } from "./loadLanguage.js";

/**
 * Builds a graph-first markup language definition backed by an HTML parser stub.
 *
 * Languages like AsciiDoc, Astro, Handlebars, reStructuredText, MDX, and
 * Markdown have no dedicated tree-sitter grammar wired up yet, so they borrow
 * `tree-sitter-html` purely as a permissive parser and expose empty
 * structure/graph/nodeTypes (no structural or graph extraction).
 *
 * Use this for any new markup language that should register and parse without
 * (yet) participating in symbol or dependency extraction. Once a language gains
 * real queries, give it its own definition instead of this factory.
 *
 * @param id Stable language id, also used as the registry key.
 * @param extensions File extensions to associate, e.g. `[".md"]`.
 */
export function htmlStubLanguage(id: string, extensions: string[]): LanguageDefinition {
  return {
    id,
    extensions,
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
}
