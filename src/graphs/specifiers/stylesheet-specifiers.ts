import type { ModuleSpecifier } from "../../util/specifiers.js";
import type { SpecifierCollectionHooks } from "../../util/resolution/language-policy-types.js";
import { appendUniqueSpecifiers, makeSeenSet } from "./collection-utils.js";

function extractCssUrlSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  const re = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)\s]+))\s*\)/gi;
  for (const match of source.matchAll(re)) {
    const spec = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!spec || spec.startsWith("#")) continue;
    out.push({ spec, resolutionKind: "document" });
  }
  return out;
}
function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\r\n]/g, " "));
}

// A directive can start a line or follow ;, {, or }. Check that boundary at the directive
// instead of retrying `\s*` from every line: masked SFC scripts can have thousands of blank lines.
// The whitespace in the lookbehind excludes JavaScript's four multiline line terminators.
const CSS_IMPORT_SPECIFIER_PATTERN =
  /(?<![^\s;{}][^\S\r\n\u2028\u2029]*)@(import|use|forward)\s+(?:\([^)]*\)\s*)?(?:url\(\s*(?:"([^"]+)"|'([^']+)'|([^)\s]+))\s*\)|"([^"]+)"|'([^']+)')(?=\s*(?:[^;{}]*;|$))/gim;

function extractCssImportSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  const cleaned = stripCssComments(source);
  for (const match of cleaned.matchAll(CSS_IMPORT_SPECIFIER_PATTERN)) {
    const spec = (match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? "").trim();
    if (!spec) continue;
    out.push({ spec, typeOnly: false, resolutionKind: "stylesheet" });
  }
  return out;
}

function extractCssModuleSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  const cleaned = stripCssComments(source);
  const patterns = [
    /(?<![^\s;{}][^\S\r\n\u2028\u2029]*)composes\s*:\s*[^;{}]*?\bfrom\s+(?:"([^"]+)"|'([^']+)')/gim,
    /(?<![^\s;{}][^\S\r\n\u2028\u2029]*)@value\s+[^;{}]*?\bfrom\s+(?:"([^"]+)"|'([^']+)')/gim,
    /(?<![^\s;{}][^\S\r\n\u2028\u2029]*)@value\s+[A-Za-z_-][\w-]*\s*:\s*(?:"([^"]+)"|'([^']+)')/gim,
  ];
  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const spec = (match[1] ?? match[2] ?? "").trim();
      if (spec) out.push({ spec, typeOnly: false, resolutionKind: "stylesheet" });
    }
  }
  return out;
}

export const STYLESHEET_SPECIFIER_COLLECTION: SpecifierCollectionHooks = {
  resolutionKind: "stylesheet",
  appendSpecifiers(_support, source, _options, output) {
    const seen = makeSeenSet(output);
    appendUniqueSpecifiers(output, extractCssImportSpecifiers(source), seen);
    appendUniqueSpecifiers(output, extractCssModuleSpecifiers(source), seen);
    appendUniqueSpecifiers(output, extractCssUrlSpecifiers(source), seen);
  },
};
