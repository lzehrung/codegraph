import { maskJsLikeCommentsStringsAndRegex, stripJsLikeComments } from "../../util/comments.js";
import { ECMASCRIPT_IDENTIFIER_SOURCE } from "../../util/identifiers.js";
import type { ImportBindingSink, ImportResolver } from "./context.js";

export type JsTextImportExtractionContext = ImportBindingSink & {
  source: string;
  languageId: string;
  resolveFrom: ImportResolver;
};

const TYPE_NAMED_IMPORT_SPECIFIER_PATTERN = new RegExp(
  String.raw`^type\s+(${ECMASCRIPT_IDENTIFIER_SOURCE})(?:\s+as\s+(${ECMASCRIPT_IDENTIFIER_SOURCE}))?$`,
  "u",
);
const NAMED_IMPORT_SPECIFIER_PATTERN = new RegExp(
  String.raw`^(${ECMASCRIPT_IDENTIFIER_SOURCE})(?:\s+as\s+(${ECMASCRIPT_IDENTIFIER_SOURCE}))?$`,
  "u",
);
const NAMESPACE_IMPORT_PATTERN = new RegExp(String.raw`^\*\s+as\s+(${ECMASCRIPT_IDENTIFIER_SOURCE})$`, "u");
const DEFAULT_REQUIRE_PATTERN = new RegExp(
  String.raw`(?:^|[;{}])\s*(?:export\s+)?(?:const|let|var)\s+(${ECMASCRIPT_IDENTIFIER_SOURCE})\s*=\s*require\s*\(\s*(["'])(?<module>[^"']+)\2\s*\)`,
  "gmu",
);
const NAMED_REQUIRE_SPECIFIER_PATTERN = new RegExp(
  String.raw`^(${ECMASCRIPT_IDENTIFIER_SOURCE})(?::\s*(${ECMASCRIPT_IDENTIFIER_SOURCE}))?$`,
  "u",
);
const IMPORT_EQUALS_REQUIRE_PATTERN = new RegExp(
  String.raw`(?:^|[;{}])\s*import\s+(${ECMASCRIPT_IDENTIFIER_SOURCE})\s*=\s*require\s*\(\s*(["'])(?<module>[^"']+)\2\s*\)`,
  "gmu",
);

function sourceForTextImportExtraction(context: JsTextImportExtractionContext): string {
  if (context.languageId === "ts" || context.languageId === "tsx" || context.languageId === "js") {
    return stripJsLikeComments(context.source);
  }
  return context.source;
}

function splitNamedImports(namedBlock: string): string[] {
  return namedBlock
    .replace(/[{}]/g, "")
    .split(",")
    .map((spec) => spec.trim())
    .filter(Boolean);
}

function parseNamedImportSpecifier(spec: string): { imported: string; local: string; typeOnly: boolean } | null {
  // JS/TS identifiers permit Unicode ID_Start/ID_Continue plus $/_, not just ASCII.
  const typeOnlyMatch = spec.match(TYPE_NAMED_IMPORT_SPECIFIER_PATTERN);
  if (typeOnlyMatch) {
    const imported = typeOnlyMatch[1]!;
    return { imported, local: typeOnlyMatch[2] ?? imported, typeOnly: true };
  }

  const namedMatch = spec.match(NAMED_IMPORT_SPECIFIER_PATTERN);
  if (!namedMatch) return null;
  const imported = namedMatch[1]!;
  return { imported, local: namedMatch[2] ?? imported, typeOnly: false };
}

function matchStartsInCode(maskedSource: string, match: RegExpMatchArray): boolean {
  const index = match.index;
  if (index === undefined) return true;
  const text = match[0] ?? "";
  for (let offset = 0; offset < text.length; offset += 1) {
    const ch = text[offset]!;
    if (/\s/.test(ch)) continue;
    return maskedSource[index + offset] === ch;
  }
  return true;
}

async function collectEsImports(
  context: JsTextImportExtractionContext,
  source: string,
  maskedSource: string,
): Promise<void> {
  const typeOnlyImport = /\bimport\s+type\b/;
  const fromPattern = /^\s*import\s+([^\n;]*?)\s+from\s+(["'])(?<module>[^"']+)\2/gm;
  for (const match of source.matchAll(fromPattern)) {
    if (!matchStartsInCode(maskedSource, match)) continue;
    const clause = match[1]!.trim().replace(/^type\s+/, "");
    const moduleSpecifier = match.groups?.module;
    if (!moduleSpecifier) continue;
    const typeOnly = typeOnlyImport.test(match[0]);
    const resolved = await context.resolveFrom(moduleSpecifier);
    const namespaceMatch = clause.match(NAMESPACE_IMPORT_PATTERN);
    if (namespaceMatch) {
      context.pushBinding({
        kind: "namespace",
        localNS: namespaceMatch[1]!,
        from: moduleSpecifier,
        resolved,
        typeOnly,
      });
      continue;
    }

    const namedBlockMatch = clause.match(/\{(?<named>[^}]*)\}/);
    const defaultPart =
      namedBlockMatch?.index === undefined
        ? clause.split(",", 1)[0]!.trim()
        : clause.slice(0, namedBlockMatch.index).replace(/,\s*$/, "").trim();
    if (defaultPart) {
      context.pushBinding({
        kind: "default",
        local: defaultPart,
        from: moduleSpecifier,
        resolved,
        typeOnly,
      });
    }
    const namedBlock = namedBlockMatch?.groups?.named ?? "";
    for (const spec of splitNamedImports(namedBlock)) {
      const namedImport = parseNamedImportSpecifier(spec);
      if (!namedImport) continue;
      const bindingTypeOnly = typeOnly || namedImport.typeOnly;
      context.pushBinding({
        kind: "named",
        local: namedImport.local,
        imported: namedImport.imported,
        from: moduleSpecifier,
        resolved,
        typeOnly: bindingTypeOnly,
      });
    }
  }
}

async function collectCommonJsRequireDeclarations(
  context: JsTextImportExtractionContext,
  source: string,
  maskedSource: string,
): Promise<void> {
  const defaultRequirePattern = DEFAULT_REQUIRE_PATTERN;
  for (const match of source.matchAll(defaultRequirePattern)) {
    if (!matchStartsInCode(maskedSource, match)) continue;
    const local = match[1]!;
    const moduleSpecifier = match.groups?.module;
    if (!moduleSpecifier) continue;
    const resolved = await context.resolveFrom(moduleSpecifier);
    context.pushBinding({
      kind: "default",
      local,
      from: moduleSpecifier,
      resolved,
      mechanism: "cjs",
    });
  }

  const namedRequirePattern =
    /(?:^|[;{}])\s*(?:export\s+)?(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\s*\(\s*(["'])(?<module>[^"']+)\2\s*\)/gm;
  for (const match of source.matchAll(namedRequirePattern)) {
    if (!matchStartsInCode(maskedSource, match)) continue;
    const specs = match[1]!
      .split(",")
      .map((spec) => spec.trim())
      .filter(Boolean);
    const moduleSpecifier = match.groups?.module;
    if (!moduleSpecifier) continue;
    const resolved = await context.resolveFrom(moduleSpecifier);
    for (const spec of specs) {
      const namedMatch = spec.match(NAMED_REQUIRE_SPECIFIER_PATTERN);
      if (!namedMatch) continue;
      const imported = namedMatch[1]!;
      const local = namedMatch[2] ?? imported;
      context.pushBinding({
        kind: "named",
        local,
        imported,
        from: moduleSpecifier,
        resolved,
        mechanism: "cjs",
      });
    }
  }
}

async function collectCommonJsImportEquals(
  context: JsTextImportExtractionContext,
  source: string,
  maskedSource: string,
): Promise<void> {
  const importEqualsPattern = IMPORT_EQUALS_REQUIRE_PATTERN;
  for (const match of source.matchAll(importEqualsPattern)) {
    if (!matchStartsInCode(maskedSource, match)) continue;
    const local = match[1]!;
    const moduleSpecifier = match.groups?.module;
    if (!moduleSpecifier) continue;
    const resolved = await context.resolveFrom(moduleSpecifier);
    context.pushBinding({
      kind: "default",
      local,
      from: moduleSpecifier,
      resolved,
      mechanism: "cjs",
    });
  }
}

async function collectCommonJsImports(
  context: JsTextImportExtractionContext,
  source: string,
  maskedSource: string,
): Promise<void> {
  await collectCommonJsRequireDeclarations(context, source, maskedSource);
  await collectCommonJsImportEquals(context, source, maskedSource);
}

export async function collectJsTextValueRequireImports(context: JsTextImportExtractionContext): Promise<void> {
  const source = sourceForTextImportExtraction(context);
  await collectCommonJsRequireDeclarations(context, source, maskJsLikeCommentsStringsAndRegex(source));
}

export async function collectJsTextImports(context: JsTextImportExtractionContext): Promise<void> {
  const source = sourceForTextImportExtraction(context);
  const maskedSource = maskJsLikeCommentsStringsAndRegex(source);
  await collectEsImports(context, source, maskedSource);
  await collectCommonJsImports(context, source, maskedSource);
}
