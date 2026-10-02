/**
 * Renders `docs/coverage/call-forms.md` from the cell tables and compares it with the committed
 * file. `npm run format:check` runs `prettier --check .` over the whole repo, so the comparison
 * (and the regenerated file) must already be Prettier-formatted; this test formats the renderer's
 * raw Markdown with Prettier's API and the repo's own config before using it either way.
 * Regenerate after adding or changing cells:
 *   UPDATE_CALL_FORM_REPORT=1 npx vitest run tests/call-form-matrix.report.test.ts
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { describe, expect, it } from "vitest";
import { ALL_CELLS } from "./call-form-matrix/index.js";
import { renderCallFormReport } from "./call-form-matrix/report.js";
import type { MatrixCell } from "./call-form-matrix/types.js";

const REPORT_PATH = path.resolve(process.cwd(), "docs/coverage/call-forms.md");
const REPO_PRETTIER_CONFIG_PATH = fileURLToPath(new URL("../.prettierrc.json", import.meta.url));

async function formatReportMarkdown(markdown: string): Promise<string> {
  const config = await prettier.resolveConfig(REPO_PRETTIER_CONFIG_PATH);
  if (!config) throw new Error(`Unable to resolve Prettier config from ${REPO_PRETTIER_CONFIG_PATH}`);
  return prettier.format(markdown, { ...config, filepath: REPORT_PATH });
}

describe("call-form coverage report", () => {
  it("matches the generated table", async () => {
    const rendered = await formatReportMarkdown(renderCallFormReport(ALL_CELLS));
    if (process.env.UPDATE_CALL_FORM_REPORT === "1") {
      await fsp.writeFile(REPORT_PATH, rendered, "utf8");
      return;
    }
    const committed = await fsp.readFile(REPORT_PATH, "utf8");
    expect(rendered).toBe(committed);
  });
});

describe("call-form coverage report: multiple cells per language and call form", () => {
  // Minimal cell satisfying the MatrixCell shape; renderCallFormReport only reads language,
  // callForm, knownGap, and moved, never the project files, so these placeholders are enough.
  function fakeCell(id: string, knownGap: boolean): MatrixCell {
    return {
      id,
      language: "go",
      callForm: "bare-call",
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

  function goBareCallStatus(cells: readonly MatrixCell[]): string {
    const rendered = renderCallFormReport(cells);
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
