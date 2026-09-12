/**
 * Graph-only language identity, kept apart from `src/document-links.ts` because that barrel imports
 * every extractor. Callers that only need to know which ids are graph-only — `doctor`, for one —
 * must not pull the extraction chain into the CLI startup module graph
 * (`tests/cli-startup-eager-modules.test.ts` bounds it).
 */
export const GRAPH_ONLY_LANGUAGE_IDS = new Set(["markdown", "mdx", "astro", "hbs", "rst", "adoc"]);

const GRAPH_ONLY_ALIAS_LANGUAGE_IDS = new Set(["mdx", "astro"]);

export function isGraphOnlyLanguage(languageId: string): boolean {
  return GRAPH_ONLY_LANGUAGE_IDS.has(languageId);
}

export function graphOnlyLanguageSupportsImportAliases(languageId: string): boolean {
  return GRAPH_ONLY_ALIAS_LANGUAGE_IDS.has(languageId);
}
