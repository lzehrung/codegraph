import { type ModuleSpecifier } from "./util/specifiers.js";
import { DOCUMENT_SPECIFIER_EXTRACTORS } from "./document-links/document-specifiers.js";

export { extractAsciidocModuleSpecifiers } from "./document-links/asciidoc.js";
export {
  extractHtmlAttributeSpecifiers,
  extractHtmlInlineScriptSpecifiers,
  extractHtmlStyleSpecifiers,
} from "./document-links/html.js";
export { extractMarkdownModuleSpecifiers, extractMdxModuleSpecifiers } from "./document-links/markdown.js";
export { extractRstModuleSpecifiers } from "./document-links/rst.js";
export { extractAstroModuleSpecifiers, extractHandlebarsModuleSpecifiers } from "./document-links/sfc.js";

export {
  GRAPH_ONLY_LANGUAGE_IDS,
  graphOnlyLanguageSupportsImportAliases,
  isGraphOnlyLanguage,
} from "./document-links/language-ids.js";

export function graphOnlySpecifierNeedsResolutionConfig(specifier: string): boolean {
  return !(
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier) ||
    /^[A-Za-z]:[\\/]/.test(specifier)
  );
}

export function extractGraphOnlyModuleSpecifiers(languageId: string, source: string): ModuleSpecifier[] {
  return DOCUMENT_SPECIFIER_EXTRACTORS[languageId]?.(source) ?? [];
}
