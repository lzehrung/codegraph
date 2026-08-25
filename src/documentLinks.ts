import { type ModuleSpecifier } from "./util/specifiers.js";
import { extractAsciidocModuleSpecifiers } from "./documentLinks/asciidoc.js";
import { extractMarkdownModuleSpecifiers, extractMdxModuleSpecifiers } from "./documentLinks/markdown.js";
import { extractRstModuleSpecifiers } from "./documentLinks/rst.js";
import { extractAstroModuleSpecifiers, extractHandlebarsModuleSpecifiers } from "./documentLinks/sfc.js";

export { extractAsciidocModuleSpecifiers } from "./documentLinks/asciidoc.js";
export {
  extractHtmlAttributeSpecifiers,
  extractHtmlInlineScriptSpecifiers,
  extractHtmlStyleSpecifiers,
} from "./documentLinks/html.js";
export { extractMarkdownModuleSpecifiers, extractMdxModuleSpecifiers } from "./documentLinks/markdown.js";
export { extractRstModuleSpecifiers } from "./documentLinks/rst.js";
export { extractAstroModuleSpecifiers, extractHandlebarsModuleSpecifiers } from "./documentLinks/sfc.js";

export const GRAPH_ONLY_LANGUAGE_IDS = new Set(["markdown", "mdx", "astro", "hbs", "rst", "adoc"]);

const GRAPH_ONLY_ALIAS_LANGUAGE_IDS = new Set(["mdx", "astro"]);

export function isGraphOnlyLanguage(languageId: string): boolean {
  return GRAPH_ONLY_LANGUAGE_IDS.has(languageId);
}

export function graphOnlyLanguageSupportsImportAliases(languageId: string): boolean {
  return GRAPH_ONLY_ALIAS_LANGUAGE_IDS.has(languageId);
}

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
  if (languageId === "markdown") {
    return extractMarkdownModuleSpecifiers(source);
  }
  if (languageId === "mdx") {
    return extractMdxModuleSpecifiers(source);
  }
  if (languageId === "astro") {
    return extractAstroModuleSpecifiers(source);
  }
  if (languageId === "hbs") {
    return extractHandlebarsModuleSpecifiers(source);
  }
  if (languageId === "rst") {
    return extractRstModuleSpecifiers(source);
  }
  if (languageId === "adoc") {
    return extractAsciidocModuleSpecifiers(source);
  }
  return [];
}
