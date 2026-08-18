import { describe, expect, it } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";

import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  buildSymbolGraphDetailed,
  findReferences,
  goToDefinition,
} from "../src/index.js";
import { fileIdentityKey, normalizePath } from "../src/util/paths.js";
import { mkTmpDir } from "./helpers/filesystem.js";

describe("languageExtensions survive reparse with keepParsed default", () => {
  it("keeps .tpl navigation and detailed symbols across a disk-cache snapshot reload", async () => {
    const root = await mkTmpDir("dg-language-extension-reparse-");
    const tplPath = path.join(root, "widget.tpl");
    const consumerPath = path.join(root, "consumer.ts");
    await fsp.writeFile(tplPath, ["export function tplWidget() {", "  return 42;", "}", ""].join("\n"), "utf8");
    await fsp.writeFile(
      consumerPath,
      ['import { tplWidget } from "./widget.tpl";', "console.log(tplWidget());", ""].join("\n"),
      "utf8",
    );

    const languageExtensions = { ".tpl": "ts" };
    // Default keepParsed is false: navigation must reparse using ProjectIndex.languageExtensions.
    const initial = await buildProjectIndex(root, {
      cache: "disk",
      threads: 1,
      languageExtensions,
    });

    expect(initial.parsed).toBeUndefined();
    expect(initial.languageExtensions).toEqual({ ".tpl": "ts" });
    expect(initial.byFile.has(fileIdentityKey(normalizePath(tplPath)))).toBe(true);

    const references = await findReferences(initial, {
      file: normalizePath(tplPath),
      line: 1,
      column: 17,
    });
    expect(references.status).toBe("ok");
    if (references.status === "ok") {
      expect(references.definition.localName).toBe("tplWidget");
      expect(references.definition.file.endsWith("widget.tpl")).toBe(true);
    }

    const goto = await goToDefinition(initial, {
      file: normalizePath(consumerPath),
      line: 2,
      column: 13,
    });
    expect(goto.status).toBe("ok");
    if (goto.status === "ok") {
      expect(goto.definition.localName).toBe("tplWidget");
      expect(goto.definition.file.endsWith("widget.tpl")).toBe(true);
    }

    const detailed = await buildSymbolGraphDetailed(initial);
    expect(
      [...detailed.nodes.values()].some((node) => node.name === "tplWidget" && node.file.endsWith("widget.tpl")),
    ).toBe(true);

    const reloaded = await buildProjectIndexIncremental(root, {
      cache: "disk",
      threads: 1,
      languageExtensions,
    });

    expect(reloaded.parsed).toBeUndefined();
    expect(reloaded.languageExtensions).toEqual({ ".tpl": "ts" });
    expect(reloaded.byFile.has(fileIdentityKey(normalizePath(tplPath)))).toBe(true);

    const reloadedReferences = await findReferences(reloaded, {
      file: normalizePath(tplPath),
      line: 1,
      column: 17,
    });
    expect(reloadedReferences.status).toBe("ok");
    if (reloadedReferences.status === "ok") {
      expect(reloadedReferences.definition.localName).toBe("tplWidget");
    }

    const reloadedDetailed = await buildSymbolGraphDetailed(reloaded);
    expect(
      [...reloadedDetailed.nodes.values()].some(
        (node) => node.name === "tplWidget" && node.file.endsWith("widget.tpl"),
      ),
    ).toBe(true);
  });
});
