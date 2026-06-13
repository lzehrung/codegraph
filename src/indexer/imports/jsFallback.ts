import { maskJsLikeCommentsStringsAndRegex, stripJsLikeComments } from "../../util/comments.js";
import type { ImportBindingSink, ImportResolver } from "./context.js";

export type JsTextImportExtractionContext = ImportBindingSink & {
  source: string;
  languageId: string;
  resolveFrom: ImportResolver;
};

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
  const typeOnlyMatch = spec.match(/^type\s+([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
  if (typeOnlyMatch) {
    const imported = typeOnlyMatch[1]!;
    return { imported, local: typeOnlyMatch[2] ?? imported, typeOnly: true };
  }

  const namedMatch = spec.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
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
    const namespaceMatch = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
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
  const defaultRequirePattern =
    /(?:^|[;{}])\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*(["'])(?<module>[^"']+)\2\s*\)/gm;
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
      const namedMatch = spec.match(/^([A-Za-z_$][\w$]*)(?::\s*([A-Za-z_$][\w$]*))?$/);
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
  const importEqualsPattern =
    /(?:^|[;{}])\s*import\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*(["'])(?<module>[^"']+)\2\s*\)/gm;
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
