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
