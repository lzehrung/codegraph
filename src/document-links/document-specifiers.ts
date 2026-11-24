import type { ModuleSpecifier } from "../util/specifiers.js";
import { extractAsciidocModuleSpecifiers } from "./asciidoc.js";
import { extractMarkdownModuleSpecifiers, extractMdxModuleSpecifiers } from "./markdown.js";
import { extractRstModuleSpecifiers } from "./rst.js";
import { extractAstroModuleSpecifiers, extractHandlebarsModuleSpecifiers } from "./sfc.js";

export const DOCUMENT_SPECIFIER_EXTRACTORS: Readonly<Record<string, (source: string) => ModuleSpecifier[]>> = {
  markdown: extractMarkdownModuleSpecifiers,
  mdx: extractMdxModuleSpecifiers,
  astro: extractAstroModuleSpecifiers,
  hbs: extractHandlebarsModuleSpecifiers,
  rst: extractRstModuleSpecifiers,
  adoc: extractAsciidocModuleSpecifiers,
};
