import { buildByteToStringIndexMap, stringIndexForByte, type ByteToStringIndexMap } from "../../native/byte-index.js";
import { capturesByName, capturesNamed, rangeFromNativeCapture } from "../../native/query-results.js";
import type { NativeCapture, NativeMatch } from "../../native/tree-sitter-native.js";
import { unquote } from "../../util/ast.js";
import { maskJsLikeCommentsStringsAndRegex } from "../../util/comments.js";
import { ECMASCRIPT_IDENTIFIER_SOURCE } from "../../util/identifiers.js";
import { collectLineStartOffsets } from "../../util/lines.js";
import { utf8ByteOffsetToStringIndex } from "../../util/rust-test-modules.js";
import { parseGoImportAlias } from "../shared.js";
import type { ImportBinding } from "../types.js";
import type { ImportResolver, ResolvedImportTarget } from "./context.js";
import { sourceRangeFromOffsets } from "./binding-ranges.js";
import { appendImplicitImportBinding, type LanguageSpecificImportContext } from "./language-specific.js";
import { splitNamedRequireBindingsWithOffsets } from "./js-text-imports.js";

type ImportCaptureExtractionContext = {
  source: string;
  languageId: string;
  isTypeOnly: (stmtText: string) => boolean;
  resolveFrom: ImportResolver;
  pushBinding: (binding: ImportBinding) => void;
  languageContext: LanguageSpecificImportContext;
  applyStatementOverride: (stmtText: string, typeOnly: boolean, statementStartIndex?: number) => Promise<boolean>;
};

const OBJECT_PATTERN_BINDING_PATTERN = new RegExp(
  String.raw`^(${ECMASCRIPT_IDENTIFIER_SOURCE})(?::\s*(${ECMASCRIPT_IDENTIFIER_SOURCE}))?$`,
  "u",
);

type ObjectPatternBinding = {
  imported: string;
  local: string;
  importedOffset: number;
  localOffset: number;
  explicitAlias: boolean;
};

function parseObjectPatternBindings(patternText: string): ObjectPatternBinding[] {
  const maskedPatternText = maskJsLikeCommentsStringsAndRegex(patternText);
  const openBrace = maskedPatternText.indexOf("{");
  const closeBrace = maskedPatternText.lastIndexOf("}");
  if (openBrace < 0 || closeBrace <= openBrace) return [];
  const bodyStart = openBrace + 1;
  const out: ObjectPatternBinding[] = [];
  for (const { spec, start } of splitNamedRequireBindingsWithOffsets(
    maskedPatternText,
    maskedPatternText,
    bodyStart,
    closeBrace,
  )) {
    const specStart = bodyStart + start;
    const withoutDefault = spec.replace(/\s*=\s*[\s\S]*$/u, "").trim();
    // JS/TS identifiers permit Unicode ID_Start/ID_Continue plus $/_, not just ASCII.
    const match = withoutDefault.match(OBJECT_PATTERN_BINDING_PATTERN);
    if (!match) continue;
    const imported = match[1]!;
    const local = match[2] ?? imported;
    const importedOffset = specStart + withoutDefault.indexOf(imported);
    const localOffset = match[2] === undefined ? importedOffset : specStart + withoutDefault.lastIndexOf(local);
    out.push({ imported, local, importedOffset, localOffset, explicitAlias: match[2] !== undefined });
  }
  return out;
}

async function pushTextObjectPatternBindings(
  context: ImportCaptureExtractionContext,
  patterns: NativeCapture[],
  from: string | undefined,
  typeOnly: boolean,
  byteIndexMap: ByteToStringIndexMap,
  lineStarts: readonly number[],
): Promise<void> {
  if (!from) return;
  for (const pattern of patterns) {
    if (pattern.nodeType !== "object_pattern") continue;
    const resolved = await context.resolveFrom(from);
    const patternStartIndex = stringIndexForByte(byteIndexMap, pattern.start.index);
    const patternBindings: ImportBinding[] = parseObjectPatternBindings(pattern.text).map((binding) => ({
      kind: "named",
      local: binding.local,
      imported: binding.imported,
      from,
      ...(binding.explicitAlias ? { explicitAlias: true } : {}),
      importedRange: sourceRangeFromOffsets(
        lineStarts,
        patternStartIndex + binding.importedOffset,
        patternStartIndex + binding.importedOffset + binding.imported.length,
      ),
      localRange: sourceRangeFromOffsets(
        lineStarts,
        patternStartIndex + binding.localOffset,
        patternStartIndex + binding.localOffset + binding.local.length,
      ),
      resolved,
      typeOnly,
    }));
    for (const binding of patternBindings) context.pushBinding(binding);
  }
}

function pushNamespaceBinding(
  context: ImportCaptureExtractionContext,
  caps: Record<string, NativeCapture | undefined>,
  stmtText: string,
  from: string,
  resolved: ResolvedImportTarget,
  typeOnly: boolean,
  byteIndexMap: ByteToStringIndexMap,
): void {
  const namespaceCapture = caps["ns"];
  if (!namespaceCapture) return;
  if (context.languageId === "go") {
    const alias = parseGoImportAlias(stmtText);
    if (alias === ".") {
      context.pushBinding({
        kind: "star",
        from,
        resolved,
        typeOnly,
      });
    } else if (alias !== "_") {
      context.pushBinding({
        kind: "namespace",
        localNS: alias ?? namespaceCapture.text,
        from,
        resolved,
        typeOnly,
      });
    }
    return;
  }

  context.pushBinding({
    kind: "namespace",
    localNS: namespaceCapture.text,
    from,
    localRange: rangeFromNativeCapture(namespaceCapture, byteIndexMap),
    resolved,
    typeOnly,
  });
}

async function pushStandardBindings(
  context: ImportCaptureExtractionContext,
  match: NativeMatch,
  caps: Record<string, NativeCapture | undefined>,
  stmtText: string,
  from: string | undefined,
  patternCount: number,
  typeOnly: boolean,
  byteIndexMap: ByteToStringIndexMap,
  statementStartIndex: number | undefined,
): Promise<void> {
  if (!from) return;
  const resolved = await context.resolveFrom(from);
  const defaultCapture = caps["def"];
  if (defaultCapture) {
    context.pushBinding({
      kind: "default",
      local: defaultCapture.text,
      from,
      localRange: rangeFromNativeCapture(defaultCapture, byteIndexMap),
      resolved,
      typeOnly,
    });
  }

  pushNamespaceBinding(context, caps, stmtText, from, resolved, typeOnly, byteIndexMap);

  const inames = capturesNamed(match, "iname");
  const aliases = capturesNamed(match, "alias");
  for (let i = 0; i < inames.length; i++) {
    const imported = inames[i]!.text;
    const importedRange = rangeFromNativeCapture(inames[i]!, byteIndexMap);
    const aliasCapture = aliases[i];
    const alias = aliasCapture?.text ?? imported;
    context.pushBinding({
      kind: "named",
      local: alias,
      imported,
      from,
      ...(aliasCapture ? { explicitAlias: true } : {}),
      importedRange,
      localRange: aliasCapture ? rangeFromNativeCapture(aliasCapture, byteIndexMap) : importedRange,
      resolved,
      typeOnly,
    });
  }

  if (!defaultCapture && !caps["ns"] && !inames.length && !patternCount) {
    appendImplicitImportBinding(context.languageContext, {
      from,
      resolved,
      typeOnly,
      stmtText,
      ...(statementStartIndex !== undefined ? { stmtStartIndex: statementStartIndex, source: context.source } : {}),
      ...(caps["alias"]?.text ? { alias: caps["alias"].text } : {}),
      ...(caps["wild"] ? { wildcard: true } : {}),
    });
  }
}

export async function collectNativeCaptureImportBindings(
  context: ImportCaptureExtractionContext,
  matches: NativeMatch[],
): Promise<void> {
  const byteIndexMap = buildByteToStringIndexMap(context.source);
  let lineStarts: number[] | undefined;
  for (const match of matches) {
    const caps = capturesByName(match);
    const statementCapture = caps["stmt"];
    const stmtText = statementCapture?.text ?? "";
    const statementTypeOnly = context.isTypeOnly(stmtText);
    const typeOnly = caps["type_kw"] !== undefined || statementTypeOnly;
    const statementStartIndex =
      statementCapture !== undefined
        ? utf8ByteOffsetToStringIndex(context.source, statementCapture.start.index)
        : undefined;
    if (await context.applyStatementOverride(stmtText, statementTypeOnly, statementStartIndex)) {
      continue;
    }
    const from = caps["from"] ? unquote(caps["from"].text) : undefined;
    const patterns = capturesNamed(match, "pattern");
    if (patterns.length) {
      const rangeLineStarts = lineStarts ?? collectLineStartOffsets(context.source);
      lineStarts = rangeLineStarts;
      await pushTextObjectPatternBindings(context, patterns, from, statementTypeOnly, byteIndexMap, rangeLineStarts);
    }
    await pushStandardBindings(
      context,
      match,
      caps,
      stmtText,
      from,
      patterns.length,
      typeOnly,
      byteIndexMap,
      statementStartIndex,
    );
  }
}
