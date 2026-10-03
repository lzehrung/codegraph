/**
 * Cross-checks each language's explicit call-form omissions (`CallFormOmission` in `./types.ts`)
 * against its cell table: every language/call-form pair must come from exactly one of a covering
 * cell or a stated omission reason, never neither (an unrecorded coverage gap) and never both (a
 * cell that contradicts its own omission reason). `tests/call-form-matrix.report.test.ts` enforces
 * this for the real matrix; `report.ts` reads the same reason lookup to render why a pair is
 * omitted.
 */
import { CALL_FORM_ORDER, LANGUAGE_ORDER } from "./types.js";
import type { CallForm, CallFormOmission, Language, MatrixCell } from "./types.js";

/** Keyed by language; a fully covered language maps to an empty list or no entry at all. */
export type OmissionsByLanguage = Readonly<Partial<Record<Language, readonly CallFormOmission[]>>>;

/** The stated reason a language omits a call form, or undefined when the pair has no omission entry. */
export function omissionReason(
  omissionsByLanguage: OmissionsByLanguage,
  language: Language,
  callForm: CallForm,
): string | undefined {
  const omissions = omissionsByLanguage[language] ?? [];
  return omissions.find((omission) => omission.callForm === callForm)?.reason;
}

export type CoverageProblem = {
  language: Language;
  callForm: CallForm;
  /** "uncovered": no cell and no omission reason. "conflicting": both a cell and an omission reason. */
  kind: "uncovered" | "conflicting";
};

/** Every (language, call form) pair in the matrix must have exactly one of a covering cell or an omission reason. */
export function findCoverageProblems(
  cells: readonly MatrixCell[],
  omissionsByLanguage: OmissionsByLanguage,
): CoverageProblem[] {
  const problems: CoverageProblem[] = [];
  for (const language of LANGUAGE_ORDER) {
    for (const callForm of CALL_FORM_ORDER) {
      const hasCell = cells.some((cell) => cell.language === language && cell.callForm === callForm);
      const hasReason = omissionReason(omissionsByLanguage, language, callForm) !== undefined;
      if (!hasCell && !hasReason) problems.push({ language, callForm, kind: "uncovered" });
      if (hasCell && hasReason) problems.push({ language, callForm, kind: "conflicting" });
    }
  }
  return problems;
}
