import { capturesByName, capturesNamed } from "../../native/queryResults.js";
import type { NativeCapture, NativeMatch } from "../../native/treeSitterNative.js";
import { unquote } from "../../util/ast.js";
import { utf8ByteOffsetToStringIndex } from "../../util/rustTestModules.js";
import { parseGoImportAlias } from "../shared.js";
import type { ImportBinding } from "../types.js";
import type { ImportResolver, ResolvedImportTarget } from "./context.js";
import { appendImplicitImportBinding, type LanguageSpecificImportContext } from "./languageSpecific.js";

type ImportCaptureExtractionContext = {
  source: string;
  languageId: string;
  isTypeOnly: (stmtText: string) => boolean;
  resolveFrom: ImportResolver;
  pushBinding: (binding: ImportBinding) => void;
  languageContext: LanguageSpecificImportContext;
  applyStatementOverride: (stmtText: string, typeOnly: boolean, statementStartIndex?: number) => Promise<boolean>;
};

function parseObjectPatternBindings(patternText: string): Array<{ imported: string; local: string }> {
  const trimmed = patternText.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return [];
  const body = trimmed.slice(1, -1).trim();
  if (!body) return [];
  const parts = body
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const out: Array<{ imported: string; local: string }> = [];
  for (const part of parts) {
    const withoutDefault = part.replace(/\s*=\s*.+$/, "").trim();
    // JS/TS identifiers permit Unicode ID_Start/ID_Continue plus $/_, not just ASCII.
    const match = withoutDefault.match(/^([\p{L}_$][\p{L}\p{N}_$]*)(?::\s*([\p{L}_$][\p{L}\p{N}_$]*))?$/u);
    if (!match) continue;
    const imported = match[1]!;
    const local = match[2] ?? imported;
    out.push({ imported, local });
  }
  return out;
}

async function pushTextObjectPatternBindings(
  context: ImportCaptureExtractionContext,
  patterns: NativeCapture[],
  from: string | undefined,
  typeOnly: boolean,
): Promise<void> {
  if (!from) return;
  for (const pattern of patterns) {
    if (pattern.nodeType !== "object_pattern") continue;
    const resolved = await context.resolveFrom(from);
    for (const binding of parseObjectPatternBindings(pattern.text)) {
      context.pushBinding({
        kind: "named",
        local: binding.local,
        imported: binding.imported,
        from,
        resolved,
        typeOnly,
      });
    }
  }
}

function pushNamespaceBinding(
  context: ImportCaptureExtractionContext,
  caps: Record<string, NativeCapture | undefined>,
  stmtText: string,
  from: string,
  resolved: ResolvedImportTarget,
  typeOnly: boolean,
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
): Promise<void> {
  if (!from) return;
  const resolved = await context.resolveFrom(from);
  const defaultCapture = caps["def"];
  if (defaultCapture) {
    context.pushBinding({
      kind: "default",
      local: defaultCapture.text,
      from,
      resolved,
      typeOnly,
    });
  }

  pushNamespaceBinding(context, caps, stmtText, from, resolved, typeOnly);

  const inames = capturesNamed(match, "iname");
  const aliases = capturesNamed(match, "alias");
  for (let i = 0; i < inames.length; i++) {
    const imported = inames[i]!.text;
    const alias = aliases[i]?.text ?? imported;
    context.pushBinding({
      kind: "named",
      local: alias,
      imported,
      from,
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
      ...(caps["alias"]?.text ? { alias: caps["alias"].text } : {}),
      ...(caps["wild"] ? { wildcard: true } : {}),
    });
  }
}

export async function collectNativeCaptureImportBindings(
  context: ImportCaptureExtractionContext,
  matches: NativeMatch[],
): Promise<void> {
  for (const match of matches) {
    const caps = capturesByName(match);
    const statementCapture = caps["stmt"];
    const stmtText = statementCapture?.text ?? "";
    const typeOnly = context.isTypeOnly(stmtText);
    const statementStartIndex =
      statementCapture !== undefined
        ? utf8ByteOffsetToStringIndex(context.source, statementCapture.start.index)
        : undefined;
    if (await context.applyStatementOverride(stmtText, typeOnly, statementStartIndex)) {
      continue;
    }
    const from = caps["from"] ? unquote(caps["from"].text) : undefined;
    const patterns = capturesNamed(match, "pattern");
    await pushTextObjectPatternBindings(context, patterns, from, typeOnly);
    await pushStandardBindings(context, match, caps, stmtText, from, patterns.length, typeOnly);
  }
}
