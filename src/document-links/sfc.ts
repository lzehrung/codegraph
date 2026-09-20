import { extractJsTsSpecifiers, type ModuleSpecifier } from "../util/specifiers.js";
import { DOCUMENT_HTML_FORMS } from "./html-forms.js";
import { extractDocumentHtmlSpecifiers } from "./html.js";
import { dedupeModuleSpecifiers, markResolutionKind, normalizeLinkSpecifier } from "./shared.js";

export function extractAstroModuleSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  out.push(...extractDocumentHtmlSpecifiers(source, DOCUMENT_HTML_FORMS.astro));

  const frontmatterMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (frontmatterMatch?.[1]) {
    out.push(...markResolutionKind(extractJsTsSpecifiers(frontmatterMatch[1]), "source"));
  }

  return dedupeModuleSpecifiers(out);
}

export function extractHandlebarsModuleSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  out.push(...extractDocumentHtmlSpecifiers(source, DOCUMENT_HTML_FORMS.hbs));

  for (const match of source.matchAll(/\{\{\s*(?:#\s*)?>\s*(?:"([^"]+)"|'([^']+)'|([^\s}]+))/g)) {
    const rawSpecifier = match[1] ?? match[2] ?? match[3];
    if (!rawSpecifier) continue;
    const normalized = normalizeLinkSpecifier(rawSpecifier, {
      preferRelative: true,
      resolutionKind: "document",
    });
    if (normalized) out.push(normalized);
  }

  return dedupeModuleSpecifiers(out);
}
