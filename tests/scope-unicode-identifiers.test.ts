import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { previewRenameWithSession } from "../src/agent/renamePreview.js";
import { createAgentSession } from "../src/agent/session.js";
import { workspaceSymbolsWithSession } from "../src/agent/workspaceSymbols.js";
import { buildProjectIndexFromFiles } from "../src/indexer/build-index.js";
import { buildScopeIndexFromSource } from "../src/indexer/scope.js";
import { workspaceSymbols } from "../src/indexer/workspace-symbols.js";
import { supportById } from "../src/languages.js";
import type { ImportBinding } from "../src/indexer/types.js";

describe("Unicode scope bindings", () => {
  it("uses one canonical PHP binding for a use alias and same-named variable declaration", () => {
    const support = supportById("php")!;
    const imports: ImportBinding[] = [{ kind: "named", from: "App\\Widget", imported: "Widget", local: "widget" }];
    const scope = buildScopeIndexFromSource(
      "consumer.php",
      "<?php\n$widget = new stdClass();\n$widget;\n",
      support,
      imports,
    );

    // The binding under test is the `use ... as widget` alias, which carries no `$` sigil,
    // so its exact source spelling and its canonical key are the same string here.
    const bindings = scope.bindings.get("widget");
    expect(bindings).toHaveLength(1);
    expect(bindings![0]!.name).toBe("widget");
    expect(bindings![0]!.canonicalName).toBe("widget");
    expect(bindings![0]!.occurrences).not.toHaveLength(0);
  });

  it("preserves the exact source spelling in workspace symbol output", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-unicode-scope-symbol-"));
    try {
      const file = path.join(root, "consumer.cs");
      await fsp.writeFile(
        file,
        "using @Widget = Namespace.Widget;\nnamespace Namespace { public class Widget {} }\nclass Use { @Widget field; }\n",
        "utf8",
      );
      const index = await buildProjectIndexFromFiles(root, [file], { cache: "off", keepParsed: true });
      const moduleIndex = [...index.byFile.values()][0]!;
      const importBinding = moduleIndex.imports[0]!;
      importBinding.resolved = file;

      const result = await workspaceSymbols(index, { query: "@Widget", includeImports: true });

      const imported = result.symbols.find((symbol) => symbol.imported);
      expect(imported).toEqual(expect.objectContaining({ name: "@Widget", localName: "@Widget" }));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("renames a Python Unicode binding and its occurrence", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-unicode-scope-rename-"));
    try {
      const file = path.join(root, "consumer.py");
      await fsp.writeFile(file, "def caf\u00e9():\n    return 1\n\ncaf\u00e9()\n", "utf8");
      const session = createAgentSession({ root, freshness: { policy: "manual" } });
      const symbols = await workspaceSymbolsWithSession(session, {
        root,
        query: "caf\u00e9",
        exportedOnly: true,
      });
      const target = symbols.symbols.find((symbol) => symbol.name === "caf\u00e9");
      expect(target).toBeDefined();

      const result = await previewRenameWithSession(session, {
        root,
        handle: target!.handle,
        newName: "renamed",
      });

      const renameEdits = result.edits.filter((edit) => edit.oldText === "caf\u00e9" && edit.newText === "renamed");
      expect(renameEdits).toHaveLength(2);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
