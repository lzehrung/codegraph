import type { LanguageDefinition } from "../types.js";

/**
 * Builds a registry placeholder for graph-only markup languages.
 *
 * Languages like AsciiDoc, Astro, Handlebars, reStructuredText, MDX, and
 * Markdown register here so they have a language id and extensions. Native
 * extraction is skipped entirely: the addon has no grammar mapping for these
 * ids. Dependency extraction lives in `src/document-links.ts`.
 *
 * Once a language gains real native queries, give it its own definition
 * instead of this factory.
 *
 * @param id Stable language id, also used as the registry key.
 * @param extensions File extensions to associate, e.g. `[".md"]`.
 */
export function htmlStubLanguage(id: string, extensions: string[]): LanguageDefinition {
  return {
    id,
    extensions,
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
