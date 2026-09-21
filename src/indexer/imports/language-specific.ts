import path from "node:path";
import { GO_IDENTIFIER_SOURCE } from "../../util/identifiers.js";
import { getPhpComposerImplicitFiles } from "../../util/resolution.js";
import { attributeNamedBindingRanges, maskImportBindingTrivia } from "./binding-ranges.js";
import {
  IMPORT_BINDING_ROWS,
  type ImplicitImportBindingArgs,
  type ImportBindingRow,
  type LanguageSpecificImportContext,
} from "./import-binding-tables.js";
import { collectTextImportBindingRequests, hasTextImportBindings } from "./text-import-extractors.js";
import type { ImportBinding } from "../types.js";

export type { LanguageSpecificImportContext } from "./import-binding-tables.js";

export type StatementImportOverrideState = {
  handledStatements: Set<string>;
};

export function createStatementImportOverrideState(): StatementImportOverrideState {
  return { handledStatements: new Set() };
}

function normalizeGoImports(context: LanguageSpecificImportContext): void {
  const imports = context.getBindings();
  if (context.languageId !== "go" || !imports.length) {
    return;
  }
  const aliasByFrom = new Map<string, string>();
  // Go alias is either the standalone dot-import token or a real Go identifier (Unicode
  // letter/underscore start, decimal-digit continuation); the blank identifier "_" is a
  // valid identifier already covered by GO_IDENTIFIER_SOURCE.
  const importPattern = new RegExp(
    String.raw`^\s*(?:import\s+)?(?:(?<alias>\.|${GO_IDENTIFIER_SOURCE})\s+)?["'\u0060](?<from>[^"'\u0060]+)["'\u0060]`,
    "gmu",
  );
  for (const match of context.source.matchAll(importPattern)) {
    const from = match.groups?.from;
    if (!from) continue;
    const alias = match.groups?.alias;
    if (alias) {
      aliasByFrom.set(from, alias);
    }
  }

  if (!aliasByFrom.size) {
    return;
  }

  const normalized: ImportBinding[] = [];
  const seen = new Set<string>();
  for (const imp of imports) {
    const alias = aliasByFrom.get(imp.from);
    let next: ImportBinding | null = imp;
    if (alias === ".") {
      next = {
        kind: "star",
        from: imp.from,
        ...(imp.resolved !== undefined ? { resolved: imp.resolved } : {}),
        ...(imp.typeOnly ? { typeOnly: imp.typeOnly } : {}),
      };
    } else if (alias === "_") {
      next = null;
    } else if (alias && imp.kind === "namespace") {
      next = {
        ...imp,
        localNS: alias,
      };
    }
    if (!next) continue;
    const key = JSON.stringify(next);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(next);
  }

  context.replaceBindings(normalized);
}

/**
 * Recovers import bindings from the shared text extractor registry.
 *
 * Java, Kotlin, C#, and PHP already own bindings when the native query ran, so their text path
 * only fills in when it produced none. Rust always re-scans because its statement override
 * de-duplicates against the bindings that already exist.
 */
async function appendTextImportBindings(context: LanguageSpecificImportContext): Promise<void> {
  if (!hasTextImportBindings(context.languageId)) return;
  const row = IMPORT_BINDING_ROWS[context.languageId];
  if (!row?.rescanTextBindings && context.getBindings().length) return;
  const state = createStatementImportOverrideState();
  for (const request of collectTextImportBindingRequests(context.languageId, context.source, {
    file: context.file,
  })) {
    const bindingCountBefore = context.getBindings().length;
    const handled = await applyStatementImportOverride(context, state, request.raw, false, request.start);
    if (!handled) continue;
    attributeNamedBindingRanges({
      bindings: context.getBindings(),
      fromIndex: bindingCountBefore,
      text: maskImportBindingTrivia(request.raw, context.languageId),
      textStartIndex: request.start,
      source: context.source,
      ...(row?.alwaysAliased ? { alwaysAliased: true } : {}),
    });
  }
}

async function appendPhpComposerImplicitImports(context: LanguageSpecificImportContext): Promise<void> {
  if (context.languageId !== "php") {
    return;
  }

  const implicitFiles = await getPhpComposerImplicitFiles(context.projectRoot, context.file);
  const seenResolved = new Set(
    context
      .getBindings()
      .map((entry) => (typeof entry.resolved === "string" ? entry.resolved : null))
      .filter((entry): entry is string => !!entry),
  );

  for (const implicitFile of implicitFiles) {
    const normalizedResolved = implicitFile.replace(/\\/g, "/");
    if (normalizedResolved === context.file.replace(/\\/g, "/")) {
      continue;
    }
    if (seenResolved.has(normalizedResolved)) {
      continue;
    }

    const relativeFrom = path.relative(path.dirname(context.file), implicitFile).replace(/\\/g, "/");
    const from = relativeFrom.startsWith(".") || relativeFrom.startsWith("/") ? relativeFrom : `./${relativeFrom}`;
    context.pushBinding({
      kind: "star",
      from,
      resolved: normalizedResolved,
      mechanism: "php",
    });
    seenResolved.add(normalizedResolved);
  }
}

export async function finalizeLanguageSpecificImports(context: LanguageSpecificImportContext): Promise<void> {
  normalizeGoImports(context);
  await appendTextImportBindings(context);
  await appendPhpComposerImplicitImports(context);
}

function masksStatementTrivia(row: ImportBindingRow, normalizedStmt: string): boolean {
  if (row.maskTrivia === "use-keyword") return /^\s*use\b/i.test(normalizedStmt);
  return row.maskTrivia ?? false;
}

function parserTextForStatement(row: ImportBindingRow, languageId: string, normalizedStmt: string): string {
  if (!masksStatementTrivia(row, normalizedStmt)) return normalizedStmt;
  let parserStmt = maskImportBindingTrivia(normalizedStmt, languageId);
  if (row.normalizeDots) parserStmt = parserStmt.replace(/\s*\.\s*/gu, ".");
  return parserStmt;
}

function statementImportOverrideKey(
  row: ImportBindingRow,
  normalizedStmt: string,
  statementStartIndex?: number,
): string {
  if (row.statementKeyUsesOffset && statementStartIndex !== undefined) {
    return `${normalizedStmt}@${statementStartIndex}`;
  }
  return normalizedStmt;
}

export async function applyStatementImportOverride(
  context: LanguageSpecificImportContext,
  state: StatementImportOverrideState,
  stmtText: string,
  typeOnly: boolean,
  statementStartIndex?: number,
): Promise<boolean> {
  const normalizedStmt = stmtText.trim();
  if (!normalizedStmt) return false;
  const row = IMPORT_BINDING_ROWS[context.languageId];
  const applyStatement = row?.applyStatement;
  if (!row || !applyStatement) return false;

  const statementKey = statementImportOverrideKey(row, normalizedStmt, statementStartIndex);
  if (state.handledStatements.has(statementKey)) return true;

  const handled = await applyStatement(
    context,
    parserTextForStatement(row, context.languageId, normalizedStmt),
    typeOnly,
    statementStartIndex,
  );
  if (!handled) return false;
  state.handledStatements.add(statementKey);
  return true;
}

export function appendImplicitImportBinding(
  context: LanguageSpecificImportContext,
  args: ImplicitImportBindingArgs,
): void {
  IMPORT_BINDING_ROWS[context.languageId]?.appendImplicit?.(context, args);
}
