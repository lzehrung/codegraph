import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareParserInput, UnsupportedParserInputError } from "../src/languages/filePrep.js";

describe("prepareParserInput", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects unsupported files before attempting file IO", async () => {
    const unsupportedFile = path.join(process.cwd(), "tests", "samples", "missing.project.json");

    await expect(prepareParserInput(unsupportedFile)).rejects.toBeInstanceOf(UnsupportedParserInputError);
  });
});
