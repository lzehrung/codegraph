import { describe, expect, it } from "vitest";
import { LANGUAGE_SUPPORTS } from "../src/languages.js";
import { IMPORT_BINDING_ROWS, type ImportBindingRow } from "../src/indexer/imports/import-binding-tables.js";

/**
 * `src/indexer/imports/import-binding-tables.ts` holds the statement-override handlers, implicit
 * binding mappers, and flags `language-specific.ts` used to inline as language-id chains. These
 * cases fail when a registered language has no row, a row names an unregistered language, or an
 * omitted capability has no reason.
 */

function declaredCapabilityFields(row: ImportBindingRow): string[] {
  const fields: string[] = [];
  if (row.applyStatement) fields.push("applyStatement");
  if (row.appendImplicit) fields.push("appendImplicit");
  if (row.maskTrivia !== undefined) fields.push("maskTrivia");
  if (row.normalizeDots) fields.push("normalizeDots");
  if (row.statementKeyUsesOffset) fields.push("statementKeyUsesOffset");
  if (row.alwaysAliased) fields.push("alwaysAliased");
  if (row.rescanTextBindings) fields.push("rescanTextBindings");
  if (row.statementOmittedReason) fields.push("statementOmittedReason");
  if (row.implicitOmittedReason) fields.push("implicitOmittedReason");
  return fields;
}

describe("import binding tables", () => {
  it("declares a row for every registered language and nothing else", () => {
    const registeredIds = LANGUAGE_SUPPORTS.map((support) => support.id).sort();
    expect(Object.keys(IMPORT_BINDING_ROWS).sort()).toEqual(registeredIds);
  });

  it("keeps omission rows reason-only", () => {
    for (const [languageId, row] of Object.entries(IMPORT_BINDING_ROWS)) {
      if (row.omittedReason === undefined) continue;
      expect(row.omittedReason.length, `${languageId} omission reason must be non-empty`).toBeGreaterThan(0);
      expect(
        declaredCapabilityFields(row),
        `${languageId} declares capability data despite its omission reason`,
      ).toEqual([]);
    }
  });

  it("requires a reason for every omitted handler", () => {
    for (const [languageId, row] of Object.entries(IMPORT_BINDING_ROWS)) {
      if (row.omittedReason !== undefined) continue;
      if (row.applyStatement === undefined) {
        expect(row.statementOmittedReason, `${languageId} declares no statement override and no reason`).toBeTruthy();
      } else {
        expect(
          row.statementOmittedReason,
          `${languageId} declares a statement override and also an omission reason`,
        ).toBeUndefined();
        expect(row.maskTrivia, `${languageId} statement override is missing maskTrivia`).toBeDefined();
      }
      if (row.appendImplicit === undefined) {
        expect(row.implicitOmittedReason, `${languageId} declares no implicit mapper and no reason`).toBeTruthy();
      } else {
        expect(
          row.implicitOmittedReason,
          `${languageId} declares an implicit mapper and also an omission reason`,
        ).toBeUndefined();
      }
    }
  });
});
