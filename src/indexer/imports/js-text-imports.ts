import { maskJsLikeCommentsStringsAndRegex, stripJsLikeComments } from "../../util/comments.js";
import { ECMASCRIPT_IDENTIFIER_SOURCE } from "../../util/identifiers.js";
import { collectLineStartOffsets, positionAtOffset } from "../../util/lines.js";
import type { Range } from "../../types.js";
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
const NAMED_REQUIRE_DECLARATION_PATTERN = /(?:^|[;{}])\s*(?:export\s+)?(?:const|let|var)\s*\{/gmu;
const REQUIRE_AFTER_BINDING_PATTERN = /^\s*=\s*require\s*\(\s*(["'])(?<module>[^"']+)\1\s*\)/u;

function sourceForTextImportExtraction(context: JsTextImportExtractionContext): string {
  if (context.languageId === "ts" || context.languageId === "tsx" || context.languageId === "js") {
    return stripJsLikeComments(context.source);
  }
  return context.source;
}

/**
 * Builds a binding token range only when the computed offset really holds `token`.
 * Text extraction can mis-locate a token for exotic syntax, and a wrong range would
 * be worse than an absent one, so an unverifiable offset yields `undefined`.
 */
function tokenRange(source: string, lineStarts: readonly number[], index: number, token: string): Range | undefined {
  if (index < 0 || !token) return undefined;
  if (source.slice(index, index + token.length) !== token) return undefined;
  return {
    start: positionAtOffset(lineStarts, index),
    end: positionAtOffset(lineStarts, index + token.length),
  };
}

function splitNamedImportsWithOffsets(namedBlock: string): Array<{ spec: string; start: number }> {
  const out: Array<{ spec: string; start: number }> = [];
  let cursor = 0;
  for (const raw of namedBlock.split(",")) {
    const leading = raw.length - raw.trimStart().length;
    const spec = raw.trim();
    if (spec) out.push({ spec, start: cursor + leading });
    cursor += raw.length + 1;
  }
  return out;
}
function closingBraceIndex(maskedSource: string, openingIndex: number): number {
  let depth = 0;
  for (let index = openingIndex; index < maskedSource.length; index += 1) {
    const character = maskedSource[index];
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export function splitNamedRequireBindingsWithOffsets(
  source: string,
  maskedSource: string,
  blockStart: number,
  blockEnd: number,
): Array<{ spec: string; start: number }> {
  const out: Array<{ spec: string; start: number }> = [];
  let specStart = blockStart;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  const push = (end: number): void => {
    const raw = source.slice(specStart, end);
    const leading = raw.length - raw.trimStart().length;
    const spec = raw.trim();
    if (spec) out.push({ spec, start: specStart - blockStart + leading });
  };
  for (let index = blockStart; index < blockEnd; index += 1) {
    const character = maskedSource[index];
    if (character === "{") braceDepth += 1;
    else if (character === "}") braceDepth -= 1;
    else if (character === "[") bracketDepth += 1;
    else if (character === "]") bracketDepth -= 1;
    else if (character === "(") parenDepth += 1;
    else if (character === ")") parenDepth -= 1;
    else if (character === "," && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      push(index);
      specStart = index + 1;
    }
  }
  push(blockEnd);
  return out;
}

function parseNamedImportSpecifier(spec: string): {
  imported: string;
  local: string;
  typeOnly: boolean;
  importedOffset: number;
  localOffset: number;
  explicitAlias: boolean;
} | null {
  // JS/TS identifiers permit Unicode ID_Start/ID_Continue plus $/_, not just ASCII.
  const typeOnlyMatch = spec.match(TYPE_NAMED_IMPORT_SPECIFIER_PATTERN);
  if (typeOnlyMatch) {
    const imported = typeOnlyMatch[1]!;
    // `type ` is a fixed-width prefix; anchors keep the imported/alias tokens at known edges.
    const importedOffset = /^type\s+/.exec(spec)![0].length;
    if (typeOnlyMatch[2] !== undefined) {
      const local = typeOnlyMatch[2]!;
      return {
        imported,
        local,
        typeOnly: true,
        importedOffset,
        localOffset: spec.length - local.length,
        explicitAlias: true,
      };
    }
    return {
      imported,
      local: imported,
      typeOnly: true,
      importedOffset,
      localOffset: importedOffset,
      explicitAlias: false,
    };
  }

  const namedMatch = spec.match(NAMED_IMPORT_SPECIFIER_PATTERN);
  if (!namedMatch) return null;
  const imported = namedMatch[1]!;
  if (namedMatch[2] !== undefined) {
    const local = namedMatch[2]!;
    return {
      imported,
      local,
      typeOnly: false,
      importedOffset: 0,
      localOffset: spec.length - local.length,
      explicitAlias: true,
    };
  }
  return { imported, local: imported, typeOnly: false, importedOffset: 0, localOffset: 0, explicitAlias: false };
}

function parseNamedRequireSpecifier(spec: string): {
  imported: string;
  local: string;
  importedOffset: number;
  localOffset: number;
  explicitAlias: boolean;
} | null {
  const bindingSpec = spec.replace(/\s*=\s*[\s\S]*$/u, "").trimEnd();
  // CommonJS destructuring uses `imported: local`, not ES's `imported as local`.
  const namedMatch = bindingSpec.match(NAMED_REQUIRE_SPECIFIER_PATTERN);
  if (!namedMatch) return null;
  const imported = namedMatch[1]!;
  if (namedMatch[2] !== undefined) {
    const local = namedMatch[2]!;
    return {
      imported,
      local,
      importedOffset: 0,
      localOffset: bindingSpec.length - local.length,
      explicitAlias: true,
    };
  }
  return { imported, local: imported, importedOffset: 0, localOffset: 0, explicitAlias: false };
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
  lineStarts: readonly number[],
): Promise<void> {
  const typeOnlyImport = /\bimport\s+type\b/;
  const fromPattern = /^\s*import\s+([^\n;]*?)\s+from\s+(["'])(?<module>[^"']+)\2/gm;
  for (const match of source.matchAll(fromPattern)) {
    if (!matchStartsInCode(maskedSource, match)) continue;
    const moduleSpecifier = match.groups?.module;
    if (!moduleSpecifier) continue;
    // `clauseStart` is the exact source offset of the clause capture: the pattern's
    // fixed `^\s*import\s+` prefix sits immediately before it, so no re-scan is needed.
    const importPrefix = /^\s*import\s+/.exec(match[0]);
    const clauseStart = importPrefix && match.index !== undefined ? match.index + importPrefix[0].length : -1;
    const clauseRaw = match[1]!;
    const leading = clauseRaw.length - clauseRaw.trimStart().length;
    const trimmedClause = clauseRaw.trim();
    const typePrefix = /^type\s+/.exec(trimmedClause);
    const clause = typePrefix ? trimmedClause.slice(typePrefix[0].length) : trimmedClause;
    const bodyStart = clauseStart < 0 ? -1 : clauseStart + leading + (typePrefix ? typePrefix[0].length : 0);
    const typeOnly = typeOnlyImport.test(match[0]);
    const resolved = await context.resolveFrom(moduleSpecifier);
    const namespaceMatch = clause.match(NAMESPACE_IMPORT_PATTERN);
    if (namespaceMatch) {
      const localNS = namespaceMatch[1]!;
      const localRange =
        bodyStart < 0
          ? undefined
          : tokenRange(source, lineStarts, bodyStart + namespaceMatch[0].indexOf(localNS), localNS);
      context.pushBinding({
        kind: "namespace",
        localNS,
        from: moduleSpecifier,
        ...(localRange ? { localRange } : {}),
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
      const localRange =
        bodyStart < 0
          ? undefined
          : tokenRange(source, lineStarts, bodyStart + clause.indexOf(defaultPart), defaultPart);
      context.pushBinding({
        kind: "default",
        local: defaultPart,
        from: moduleSpecifier,
        ...(localRange ? { localRange } : {}),
        resolved,
        typeOnly,
      });
    }
    if (namedBlockMatch?.index !== undefined && bodyStart >= 0) {
      const namedBlockContentStart = bodyStart + namedBlockMatch.index + namedBlockMatch[0].indexOf("{") + 1;
      for (const { spec, start } of splitNamedImportsWithOffsets(namedBlockMatch.groups?.named ?? "")) {
        const namedImport = parseNamedImportSpecifier(spec);
        if (!namedImport) continue;
        const specStart = namedBlockContentStart + start;
        const bindingTypeOnly = typeOnly || namedImport.typeOnly;
        const importedRange = tokenRange(
          source,
          lineStarts,
          specStart + namedImport.importedOffset,
          namedImport.imported,
        );
        const localRange = tokenRange(source, lineStarts, specStart + namedImport.localOffset, namedImport.local);
        context.pushBinding({
          kind: "named",
          local: namedImport.local,
          imported: namedImport.imported,
          from: moduleSpecifier,
          ...(namedImport.explicitAlias ? { explicitAlias: true } : {}),
          ...(importedRange ? { importedRange } : {}),
          ...(localRange ? { localRange } : {}),
          resolved,
          typeOnly: bindingTypeOnly,
        });
      }
    }
  }
}

async function collectCommonJsRequireDeclarations(
  context: JsTextImportExtractionContext,
  source: string,
  maskedSource: string,
  lineStarts: readonly number[],
): Promise<void> {
  const defaultRequirePattern = DEFAULT_REQUIRE_PATTERN;
  const defaultRequirePrefix = /(?:^|[;{}])\s*(?:export\s+)?(?:const|let|var)\s+/;
  for (const match of source.matchAll(defaultRequirePattern)) {
    if (!matchStartsInCode(maskedSource, match)) continue;
    const local = match[1]!;
    const moduleSpecifier = match.groups?.module;
    if (!moduleSpecifier) continue;
    const localStart = (match.index ?? 0) + (defaultRequirePrefix.exec(match[0])?.[0].length ?? 0);
    const localRange = tokenRange(source, lineStarts, localStart, local);
    const resolved = await context.resolveFrom(moduleSpecifier);
    context.pushBinding({
      kind: "default",
      local,
      from: moduleSpecifier,
      ...(localRange ? { localRange } : {}),
      resolved,
      mechanism: "cjs",
    });
  }

  for (const match of maskedSource.matchAll(NAMED_REQUIRE_DECLARATION_PATTERN)) {
    const openingIndex = (match.index ?? 0) + match[0].lastIndexOf("{");
    const closingIndex = closingBraceIndex(maskedSource, openingIndex);
    if (closingIndex < 0) continue;
    const requireMatch = REQUIRE_AFTER_BINDING_PATTERN.exec(source.slice(closingIndex + 1));
    const moduleSpecifier = requireMatch?.groups?.module;
    if (!moduleSpecifier) continue;
    const namedBlockStart = openingIndex + 1;
    const resolved = await context.resolveFrom(moduleSpecifier);
    for (const { spec, start } of splitNamedRequireBindingsWithOffsets(
      source,
      maskedSource,
      namedBlockStart,
      closingIndex,
    )) {
      const namedRequire = parseNamedRequireSpecifier(spec);
      if (!namedRequire) continue;
      const specStart = namedBlockStart + start;
      const importedRange = tokenRange(
        source,
        lineStarts,
        specStart + namedRequire.importedOffset,
        namedRequire.imported,
      );
      const localRange = tokenRange(source, lineStarts, specStart + namedRequire.localOffset, namedRequire.local);
      context.pushBinding({
        kind: "named",
        local: namedRequire.local,
        imported: namedRequire.imported,
        from: moduleSpecifier,
        ...(namedRequire.explicitAlias ? { explicitAlias: true } : {}),
        ...(importedRange ? { importedRange } : {}),
        ...(localRange ? { localRange } : {}),
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
  lineStarts: readonly number[],
): Promise<void> {
  const importEqualsPattern = IMPORT_EQUALS_REQUIRE_PATTERN;
  const importEqualsPrefix = /(?:^|[;{}])\s*import\s+/;
  for (const match of source.matchAll(importEqualsPattern)) {
    if (!matchStartsInCode(maskedSource, match)) continue;
    const local = match[1]!;
    const moduleSpecifier = match.groups?.module;
    if (!moduleSpecifier) continue;
    const localStart = (match.index ?? 0) + (importEqualsPrefix.exec(match[0])?.[0].length ?? 0);
    const localRange = tokenRange(source, lineStarts, localStart, local);
    const resolved = await context.resolveFrom(moduleSpecifier);
    context.pushBinding({
      kind: "default",
      local,
      from: moduleSpecifier,
      ...(localRange ? { localRange } : {}),
      resolved,
      mechanism: "cjs",
    });
  }
}

async function collectCommonJsImports(
  context: JsTextImportExtractionContext,
  source: string,
  maskedSource: string,
  lineStarts: readonly number[],
): Promise<void> {
  await collectCommonJsRequireDeclarations(context, source, maskedSource, lineStarts);
  await collectCommonJsImportEquals(context, source, maskedSource, lineStarts);
}

export async function collectJsTextValueRequireImports(context: JsTextImportExtractionContext): Promise<void> {
  const source = sourceForTextImportExtraction(context);
  const lineStarts = collectLineStartOffsets(source);
  await collectCommonJsRequireDeclarations(context, source, maskJsLikeCommentsStringsAndRegex(source), lineStarts);
}

export async function collectJsTextImports(context: JsTextImportExtractionContext): Promise<void> {
  const source = sourceForTextImportExtraction(context);
  const maskedSource = maskJsLikeCommentsStringsAndRegex(source);
  const lineStarts = collectLineStartOffsets(source);
  await collectEsImports(context, source, maskedSource, lineStarts);
  await collectCommonJsImports(context, source, maskedSource, lineStarts);
}
