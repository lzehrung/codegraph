import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProjectIndex } from "../src/indexer/build-index.js";
import * as filePrep from "../src/languages/filePrep.js";

describe("default build file failures", () => {
  let root: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("returns a failed-file report without caller-supplied reporting or logging", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-build-file-failure-"));
    const file = path.join(root, "broken.ts");
    await fs.writeFile(file, "export const broken = true;\n", "utf8");
    vi.spyOn(filePrep, "prepareSourceInput").mockRejectedValueOnce(new Error("injected extraction failure"));

    const index = await buildProjectIndex(root);

    expect(index.buildReport?.files?.failed).toBe(1);
    expect(index.buildReport?.files?.errors).toEqual([
      {
        file: file.replace(/\\/g, "/"),
        message: "injected extraction failure",
      },
    ]);
  });
});
