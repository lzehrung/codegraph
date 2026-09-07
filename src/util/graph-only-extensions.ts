export const GRAPH_ONLY_DOCUMENT_EXTENSIONS = [".md", ".mdx", ".rst", ".adoc", ".asciidoc"] as const;

export type GraphOnlyDocumentExtension = (typeof GRAPH_ONLY_DOCUMENT_EXTENSIONS)[number];

export const GRAPH_ONLY_RESOLUTION_EXTENSIONS = [
  ".md",
  ".mdx",
  ".astro",
  ".hbs",
  ".handlebars",
  ".rst",
  ".adoc",
  ".asciidoc",
] as const;

export type GraphOnlyResolutionExtension = (typeof GRAPH_ONLY_RESOLUTION_EXTENSIONS)[number];
