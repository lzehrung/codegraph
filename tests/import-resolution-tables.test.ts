import { describe, expect, it } from "vitest";
import { LANGUAGE_SUPPORTS } from "../src/languages.js";
import { IMPORT_RESOLUTION_ROWS, type ImportResolutionRow } from "../src/indexer/import-resolution-tables.js";

/**
 * `src/indexer/import-resolution-tables.ts` holds declaration-resolved imports, implicit
 * compilation units, and external-specifier rules for each language.
 * These cases fail when a registered language has no row, a row names an unregistered language,
 * or an omitted capability has no reason.
 */

function declaredCapabilityFields(row: ImportResolutionRow): string[] {
  const fields: string[] = [];
  if (row.resolvesImportsFromDeclarations) fields.push("resolvesImportsFromDeclarations");
  if (row.resolvesImportsFromDeclarationsOmittedReason) fields.push("resolvesImportsFromDeclarationsOmittedReason");
  if (row.implicitCompilationUnit) fields.push("implicitCompilationUnit");
  if (row.implicitCompilationUnitOmittedReason) fields.push("implicitCompilationUnitOmittedReason");
  if (row.implicitCompilationUnitGroup) fields.push("implicitCompilationUnitGroup");
  if (row.externalSpecifierResolution) fields.push("externalSpecifierResolution");
  if (row.externalSpecifierResolutionOmittedReason) fields.push("externalSpecifierResolutionOmittedReason");
  return fields;
}

describe("import resolution tables", () => {
  it("declares a row for every registered language and nothing else", () => {
    const registeredIds = LANGUAGE_SUPPORTS.map((support) => support.id).sort();
    expect(Object.keys(IMPORT_RESOLUTION_ROWS).sort()).toEqual(registeredIds);
  });

  it("keeps omission rows reason-only", () => {
    for (const [languageId, row] of Object.entries(IMPORT_RESOLUTION_ROWS)) {
      if (row.omittedReason === undefined) continue;
      expect(row.omittedReason.length, `${languageId} omission reason must be non-empty`).toBeGreaterThan(0);
      expect(
        declaredCapabilityFields(row),
        `${languageId} declares capability data despite its omission reason`,
      ).toEqual([]);
    }
  });

  it("requires a reason for every omitted capability", () => {
    for (const [languageId, row] of Object.entries(IMPORT_RESOLUTION_ROWS)) {
      if (row.omittedReason !== undefined) continue;
      if (row.resolvesImportsFromDeclarations === undefined) {
        expect(
          row.resolvesImportsFromDeclarationsOmittedReason,
          `${languageId} does not resolve imports from declarations and gives no reason`,
        ).toBeTruthy();
      } else {
        expect(
          row.resolvesImportsFromDeclarationsOmittedReason,
          `${languageId} resolves imports from declarations and also gives an omission reason`,
        ).toBeUndefined();
      }
      if (row.implicitCompilationUnit === undefined) {
        expect(
          row.implicitCompilationUnitOmittedReason,
          `${languageId} has no implicit compilation unit and gives no reason`,
        ).toBeTruthy();
      } else {
        expect(
          row.implicitCompilationUnitOmittedReason,
          `${languageId} has an implicit compilation unit and also gives an omission reason`,
        ).toBeUndefined();
      }
      if (row.externalSpecifierResolution === undefined) {
        expect(
          row.externalSpecifierResolutionOmittedReason,
          `${languageId} keeps the default external-specifier rule and gives no reason`,
        ).toBeTruthy();
      } else {
        expect(
          row.externalSpecifierResolutionOmittedReason,
          `${languageId} overrides external-specifier resolution and also gives an omission reason`,
        ).toBeUndefined();
      }
      if (row.implicitCompilationUnitGroup !== undefined) {
        expect(row.implicitCompilationUnit, `${languageId} shares a unit group without a unit kind`).toBeTruthy();
      }
    }
  });
});
