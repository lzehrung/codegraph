import { attributeNamedBindingRanges, maskImportBindingTrivia } from "./binding-ranges.js";
import { IMPORT_BINDING_ROWS, type ImplicitImportBindingArgs, type ImportBindingRow } from "./import-binding-tables.js";
import { collectTextImportBindingRequests, hasTextImportBindings } from "./text-import-extractors.js";

import type { LanguageSpecificImportContext } from "./context.js";

export type StatementImportOverrideState = {
  handledStatements: Set<string>;
};

export function createStatementImportOverrideState(): StatementImportOverrideState {
  return { handledStatements: new Set() };
}

/**
 * Recovers import bindings from the shared text extractor registry.
 *
 * PHP already owns bindings when the native query ran, so its text path only fills in when it
 * produced none. Rust always re-scans because its statement override de-duplicates against the
 * bindings that already exist.
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
    });
  }
}

export async function finalizeLanguageSpecificImports(context: LanguageSpecificImportContext): Promise<void> {
  const row = IMPORT_BINDING_ROWS[context.languageId];
  row?.normalizeBindings?.(context);
  await appendTextImportBindings(context);
  await row?.appendImplicitFiles?.(context);
}

function masksStatementTrivia(row: ImportBindingRow, normalizedStmt: string): boolean {
  if (row.maskTrivia === "use-keyword") return /^\s*use\b/i.test(normalizedStmt);
  return row.maskTrivia ?? false;
}

function parserTextForStatement(row: ImportBindingRow, languageId: string, normalizedStmt: string): string {
  if (!masksStatementTrivia(row, normalizedStmt)) return normalizedStmt;
  return maskImportBindingTrivia(normalizedStmt, languageId);
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
