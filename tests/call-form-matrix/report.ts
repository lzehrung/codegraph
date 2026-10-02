/**
 * Renders the call-form coverage report (`docs/coverage/call-forms.md`) from the cell tables.
 * Pure and deterministic: the output depends only on the cell data, never on a live test run, so
 * `tests/call-form-matrix.report.test.ts` can compare it byte for byte against the committed file.
 */
import {
  CALL_FORM_NAMES,
  CALL_FORM_ORDER,
  GAP_CLASSIFICATION_LABELS,
  LANGUAGE_NAMES,
  LANGUAGE_ORDER,
  type CallForm,
  type Language,
  type MatrixCell,
} from "./types.js";

type CellStatus = "covered" | "known-gap" | "omitted";

const STATUS_LABEL: Readonly<Record<CellStatus, string>> = {
  covered: "Covered",
  "known-gap": "Known gap",
  omitted: "Omitted",
};

function statusFor(cells: readonly MatrixCell[], language: Language, callForm: CallForm): CellStatus {
  const cell = cells.find((candidate) => candidate.language === language && candidate.callForm === callForm);
  if (!cell) return "omitted";
  return cell.knownGap ? "known-gap" : "covered";
}

export function renderCallFormReport(cells: readonly MatrixCell[]): string {
  const lines: string[] = [];
  lines.push("# Call-form coverage matrix");
  lines.push("");
  lines.push(
    "Generated from the cell tables in `tests/call-form-matrix/languages/` by " +
      "`tests/call-form-matrix.report.test.ts`. Regenerate with " +
      "`UPDATE_CALL_FORM_REPORT=1 npx vitest run tests/call-form-matrix.report.test.ts`.",
  );
  lines.push("");
  lines.push(
    "Each cell is one language and one call form: a small project, a use site, the declaration it must resolve " +
      "to (or `not_found`), and a same-named decoy declaration it must not resolve to. A cell passes when " +
      "`goToDefinition`, `findReferences`, and the detailed call graph agree on the use site, the decoy is " +
      "excluded, and three metamorphic checks hold: an unrelated same-named file elsewhere changes nothing, a " +
      "warm disk-cache build matches a cold build across a sequence of file mutations, and, where the cell gives " +
      "one, moving the declaration moves the answer with it. " +
      "`docs/plans/2026-09-28-unified-name-resolution.md` Step 1 is the design source.",
  );
  lines.push("");
  lines.push("Status key:");
  lines.push("");
  lines.push("- Covered = the cell passes today.");
  lines.push("- Known gap = the cell fails today; tracked with `it.fails` so it flips visibly once fixed.");
  lines.push("- Omitted = the language has no idiomatic form for this call shape.");
  lines.push("");

  const header = ["Language", ...CALL_FORM_ORDER.map((form) => CALL_FORM_NAMES[form])];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const language of LANGUAGE_ORDER) {
    const row = [LANGUAGE_NAMES[language]];
    for (const form of CALL_FORM_ORDER) row.push(STATUS_LABEL[statusFor(cells, language, form)]);
    lines.push(`| ${row.join(" | ")} |`);
  }
  lines.push("");
  const unstarted = LANGUAGE_ORDER.filter((language) => !cells.some((cell) => cell.language === language));
  if (unstarted.length) {
    lines.push(
      'A language with every column "Omitted" and zero cells below has no cell table yet; that is a ' +
        "coverage gap in this matrix, not a claim that the language cannot express any call form. Not yet " +
        `started: ${unstarted.map((language) => LANGUAGE_NAMES[language]).join(", ")}.`,
    );
    lines.push("");
  }

  lines.push("## Cell counts");
  lines.push("");
  lines.push("| Language | Cells | Known gaps |");
  lines.push("| --- | --- | --- |");
  let total = 0;
  let totalGaps = 0;
  for (const language of LANGUAGE_ORDER) {
    const languageCells = cells.filter((cell) => cell.language === language);
    const gaps = languageCells.filter((cell) => cell.knownGap).length;
    total += languageCells.length;
    totalGaps += gaps;
    lines.push(`| ${LANGUAGE_NAMES[language]} | ${languageCells.length} | ${gaps} |`);
  }
  lines.push("");
  lines.push(`Total: ${total} cells across ${LANGUAGE_ORDER.length} languages, ${totalGaps} known gaps.`);
  lines.push("");

  lines.push("## Known gaps");
  lines.push("");
  const gapCells = cells.filter((cell) => cell.knownGap);
  if (!gapCells.length) {
    lines.push("No known gaps.");
  } else {
    for (const cell of gapCells) {
      const gap = cell.knownGap;
      if (!gap) continue;
      lines.push(`- \`${cell.id}\` (${GAP_CLASSIFICATION_LABELS[gap.classification]}): ${gap.reason}`);
      lines.push(`  Repro: ${gap.repro}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}
