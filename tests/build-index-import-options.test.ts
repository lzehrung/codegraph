import { describe, it, expect } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildProjectIndex } from "../src/index.js";
import type { BuildReport } from "../src/index.js";

describe("Shared import-option builder (C10)", () => {
  it("threads onFallbackImportExtraction to embedded SFC blocks, not only the primary source", async () => {
    // The <script> block never triggers a fallback (valid TS), so any fallback event on
    // Widget.vue can only have come from the embedded <style> block's CSS import extraction.
    // If a future edit applied a shared option to only the primary collectImportsForFile
    // call, this event would silently stop firing for the embedded path.
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-c10-import-options-"));
    try {
      await fsp.writeFile(path.join(root, "other.css"), ".a { color: red; }\n", "utf8");
      await fsp.writeFile(
        path.join(root, "Widget.vue"),
        `<script setup lang="ts">\nexport const x = 1;\n</script>\n<style>\n@import "./other.css";\n</style>\n`,
        "utf8",
      );

      const report: BuildReport = { timings: {} };
      await buildProjectIndex(root, { cache: "off", logLevel: "silent", report });

      const fallback = report.graph?.fallbackImportExtraction;
      expect(fallback).toBeDefined();
      const widgetEvent = Object.entries(fallback!.files).find(([file]) => file.endsWith("/Widget.vue"));
      expect(widgetEvent?.[1]).toEqual({ language: "css", reason: "query-empty" });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
