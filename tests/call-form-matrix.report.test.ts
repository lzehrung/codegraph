/**
 * Renders `docs/coverage/call-forms.md` from the cell tables and the per-language omission lists,
 * and compares it with the committed file. `npm run format:check` runs `prettier --check .` over
 * the whole repo, so the comparison (and the regenerated file) must already be Prettier-formatted;
 * this test formats the renderer's raw Markdown with Prettier's API and the repo's own config
 * before using it either way. Regenerate after adding or changing cells:
 *   UPDATE_CALL_FORM_REPORT=1 npx vitest run tests/call-form-matrix.report.test.ts
 * A separate describe block below cross-checks every language/call-form pair against
 * `tests/call-form-matrix/omissions.ts`, independent of the rendered Markdown.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { describe, expect, it } from "vitest";
import { ALL_CELLS, OMISSIONS_BY_LANGUAGE } from "./call-form-matrix/index.js";
import { findCoverageProblems, type OmissionsByLanguage } from "./call-form-matrix/omissions.js";
import { renderCallFormReport } from "./call-form-matrix/report.js";
import type { CallForm, MatrixCell } from "./call-form-matrix/types.js";

const REPORT_PATH = path.resolve(process.cwd(), "docs/coverage/call-forms.md");
const REPO_PRETTIER_CONFIG_PATH = fileURLToPath(new URL("../.prettierrc.json", import.meta.url));

async function formatReportMarkdown(markdown: string): Promise<string> {
  const config = await prettier.resolveConfig(REPO_PRETTIER_CONFIG_PATH);
  if (!config) throw new Error(`Unable to resolve Prettier config from ${REPO_PRETTIER_CONFIG_PATH}`);
  return prettier.format(markdown, { ...config, filepath: REPORT_PATH });
}

// Minimal cell satisfying the MatrixCell shape; renderCallFormReport and findCoverageProblems only
// read language, callForm, knownGap, and moved, never the project files, so these placeholders are
// enough.
function fakeCell(id: string, knownGap: boolean, callForm: CallForm = "bare-call"): MatrixCell {
  return {
    id,
    language: "go",
    callForm,
    files: { "a.go": "package a\n" },
    use: { file: "a.go", line: 1, token: "a" },
    expected: { file: "a.go", line: 1, token: "a" },
    decoy: { file: "a.go", line: 1, token: "a" },
    decoyKind: "callable",
    ...(knownGap
      ? { knownGap: { reason: "synthetic", classification: "common-code-miss" as const, repro: "synthetic" } }
      : {}),
  };
}

describe("call-form coverage report", () => {
  it("matches the generated table", async () => {
    const rendered = await formatReportMarkdown(renderCallFormReport(ALL_CELLS, OMISSIONS_BY_LANGUAGE));
    if (process.env.UPDATE_CALL_FORM_REPORT === "1") {
      await fsp.writeFile(REPORT_PATH, rendered, "utf8");
      return;
    }
    const committed = await fsp.readFile(REPORT_PATH, "utf8");
    expect(rendered).toBe(committed);
  });
});

describe("call-form coverage report: multiple cells per language and call form", () => {
  function goBareCallStatus(cells: readonly MatrixCell[]): string {
    const rendered = renderCallFormReport(cells, {});
    const row = rendered.split("\n").find((line) => line.startsWith("| Go "));
    if (!row) throw new Error("no Go row in the rendered report");
    const cellsInRow = row
      .split("|")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return cellsInRow[1]!; // ["Go", <bare-call status>, ...]
  }

  it("shows Known gap when any cell sharing a language and call form has one, in either order", () => {
    const gapFirst = [fakeCell("go/bare-call-a", true), fakeCell("go/bare-call-b", false)];
    const gapSecond = [fakeCell("go/bare-call-a", false), fakeCell("go/bare-call-b", true)];
    expect(goBareCallStatus(gapFirst)).toBe("Known gap");
    expect(goBareCallStatus(gapSecond)).toBe("Known gap");
  });

  it("shows Covered when every cell sharing a language and call form passes", () => {
    const bothCovered = [fakeCell("go/bare-call-a", false), fakeCell("go/bare-call-b", false)];
    expect(goBareCallStatus(bothCovered)).toBe("Covered");
  });
});

describe("call-form coverage: every language/form pair has exactly one source", () => {
  it("has no problems for the real cell tables and omission lists", () => {
    expect(findCoverageProblems(ALL_CELLS, OMISSIONS_BY_LANGUAGE)).toEqual([]);
  });

  it("flags a pair with neither a cell nor a reason, and a pair with both, while leaving a normally covered or normally omitted pair clean", () => {
    const cells = [fakeCell("go/bare-call", false), fakeCell("go/static-receiver", false, "static-receiver")];
    const omissions: OmissionsByLanguage = {
      go: [
        { callForm: "self-member-call", reason: "no self keyword" },
        { callForm: "static-receiver", reason: "conflicts with its own cell above" },
      ],
    };

    const problems = findCoverageProblems(cells, omissions);

    // bare-call: a cell and no omission -- covered normally, must not be flagged.
    expect(problems).not.toContainEqual(expect.objectContaining({ language: "go", callForm: "bare-call" }));
    // self-member-call: an omission and no cell -- omitted normally, must not be flagged.
    expect(problems).not.toContainEqual(expect.objectContaining({ language: "go", callForm: "self-member-call" }));
    // qualified-call: neither a cell nor an omission -- an unrecorded coverage gap.
    expect(problems).toContainEqual({ language: "go", callForm: "qualified-call", kind: "uncovered" });
    // static-receiver: both a cell and an omission -- contradicts itself.
    expect(problems).toContainEqual({ language: "go", callForm: "static-receiver", kind: "conflicting" });
  });
});
