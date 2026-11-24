import type { SpecifierCollectionHooks } from "../../util/resolution/language-policy-types.js";
import { isJsTsTypeOnlySpecifierStatement } from "../../util/specifiers.js";
import type { ModuleSpecifier } from "../../util/specifiers.js";
import { appendUniqueSpecifiers, makeSeenSet } from "./collection-utils.js";

// `/// <reference path="./other.ts" />` - a type-only file dependency directive.
// Distinct from `<reference lib="..." />`/`<reference types="..." />`, which name
// a TS lib or an @types package rather than a project-relative file, and are left
// unresolved (no `path=` attribute to extract). Triple-slash directives allow their
// attributes in any order (and other attributes may appear alongside `path=`), so
// this matches the whole tag first and then searches within it for `path=`,
// rather than requiring `path=` to be the first/only attribute.
const TRIPLE_SLASH_REFERENCE_TAG_PATTERN = /^\/\/\/\s*<reference\s+([^>]*?)\/>/gm;
const TRIPLE_SLASH_PATH_ATTRIBUTE_PATTERN = /\bpath\s*=\s*["']([^"']+)["']/;

function extractTripleSlashReferenceSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  for (const tagMatch of source.matchAll(TRIPLE_SLASH_REFERENCE_TAG_PATTERN)) {
    const attributes = tagMatch[1] ?? "";
    const spec = TRIPLE_SLASH_PATH_ATTRIBUTE_PATTERN.exec(attributes)?.[1]?.trim();
    if (!spec) continue;
    out.push({ spec, typeOnly: true });
  }
  return out;
}

export const TYPESCRIPT_SPECIFIER_COLLECTION: SpecifierCollectionHooks = {
  statementTypeOnly: isJsTsTypeOnlySpecifierStatement,
  appendSpecifiers(_support, source, _options, output) {
    appendUniqueSpecifiers(output, extractTripleSlashReferenceSpecifiers(source), makeSeenSet(output));
  },
};
