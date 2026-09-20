import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildProjectIndex, findReferences, goToDefinition, resolveExport } from "../src/index.js";
import { fileIdentityKey } from "../src/util/paths.js";
import type { ModuleIndex } from "../src/indexer/types.js";
import { testGoToDefinition } from "./test-utils.js";

function tokenColumn(line: string, token: string): number {
  const index = line.indexOf(token);
  if (index < 0) throw new Error(`missing token ${token} in ${JSON.stringify(line)}`);
  return index + 1;
}

function localExportNames(mod: ModuleIndex | undefined): string[] {
  return (mod?.exports ?? []).flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : []));
}

async function withTempRoot(prefix: string, run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("declaration visibility module exports", () => {
  it("keeps Rust non-pub items local while pub, pub(crate), and pub(super) stay importable", async () => {
    await withTempRoot("cg-vis-rust-", async (root) => {
      const src = path.join(root, "src");
      await mkdir(src, { recursive: true });
      const visFile = path.join(src, "vis.rs").replace(/\\/g, "/");
      const consumerFile = path.join(src, "consumer.rs").replace(/\\/g, "/");
      const visHiddenDef = "fn hidden() {}";
      const visHiddenUse = "    hidden();";
      const visExportedUse = "    exported();";
      const consumerExported = "    exported();";
      const consumerHidden = "    hidden();";
      const consumerCrate = "    crate_vis();";
      const consumerSuper = "    super_vis();";
      await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "vis-rust"\nversion = "0.1.0"\n');
      await writeFile(path.join(src, "lib.rs"), "mod vis;\npub mod consumer;\n");
      await writeFile(
        visFile,
        [
          "pub fn exported() {}",
          visHiddenDef,
          "pub(crate) fn crate_vis() {}",
          "pub(super) fn super_vis() {}",
          "",
          "fn uses_local() {",
          visHiddenUse,
          visExportedUse,
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        consumerFile,
        [
          "use crate::vis::exported;",
          "use crate::vis::hidden;",
          "use crate::vis::crate_vis;",
          "use crate::vis::super_vis;",
          "",
          "fn run() {",
          consumerExported,
          consumerHidden,
          consumerCrate,
          consumerSuper,
          "}",
          "",
        ].join("\n"),
      );

      const index = await buildProjectIndex(root, { cache: "off" });
      const visMod = index.byFile.get(fileIdentityKey(visFile));
      const exported = localExportNames(visMod);
      expect(exported).toEqual(expect.arrayContaining(["exported", "crate_vis", "super_vis"]));
      expect(exported).not.toContain("hidden");
      expect(visMod?.locals.map((local) => local.localName)).toEqual(
        expect.arrayContaining(["exported", "hidden", "crate_vis", "super_vis", "uses_local"]),
      );

      expect(resolveExport(index, visFile, "exported", { allowLocalFallback: false })?.kind).toBe("resolved");
      expect(resolveExport(index, visFile, "crate_vis", { allowLocalFallback: false })?.kind).toBe("resolved");
      expect(resolveExport(index, visFile, "super_vis", { allowLocalFallback: false })?.kind).toBe("resolved");
      expect(resolveExport(index, visFile, "hidden", { allowLocalFallback: false })).toBeNull();
      expect(resolveExport(index, visFile, "hidden")).toBeNull();

      await testGoToDefinition(index, visFile, 7, tokenColumn(visHiddenUse, "hidden"), visFile, 2);
      await testGoToDefinition(index, visFile, 8, tokenColumn(visExportedUse, "exported"), visFile, 1);
      const hiddenRefs = await findReferences(index, {
        file: visFile,
        line: 2,
        column: tokenColumn(visHiddenDef, "hidden"),
      });
      expect(hiddenRefs.status).toBe("ok");
      if (hiddenRefs.status === "ok") {
        expect(hiddenRefs.references.map((reference) => reference.range.start.line).sort()).toEqual(
          expect.arrayContaining([2, 7]),
        );
      }

      await testGoToDefinition(index, consumerFile, 7, tokenColumn(consumerExported, "exported"), visFile, 1);
      await testGoToDefinition(index, consumerFile, 9, tokenColumn(consumerCrate, "crate_vis"), visFile, 3);
      await testGoToDefinition(
        index,
        consumerFile,
        8,
        tokenColumn(consumerHidden, "hidden"),
        undefined,
        undefined,
        "not_found",
      );
      await testGoToDefinition(index, consumerFile, 10, tokenColumn(consumerSuper, "super_vis"), visFile, 4);
    });
  });

  it("keeps a Java private method out of module exports while the public sibling stays importable", async () => {
    await withTempRoot("cg-vis-java-", async (root) => {
      const libFile = path.join(root, "demo", "Lib.java").replace(/\\/g, "/");
      const consumerFile = path.join(root, "demo", "Consumer.java").replace(/\\/g, "/");
      const hiddenDef = "  private static void hidden() {}";
      const hiddenUse = "    hidden();";
      const visibleUse = "    visible();";
      const consumerVisible = "    visible();";
      const consumerHidden = "    hidden();";
      await mkdir(path.dirname(libFile), { recursive: true });
      await writeFile(
        libFile,
        [
          "package demo;",
          "public class Lib {",
          "  public static void visible() {}",
          hiddenDef,
          "  static void usesLocal() {",
          hiddenUse,
          visibleUse,
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        consumerFile,
        [
          "package demo;",
          "import static demo.Lib.visible;",
          "import static demo.Lib.hidden;",
          "class Consumer {",
          "  void run() {",
          consumerVisible,
          consumerHidden,
          "  }",
          "}",
          "",
        ].join("\n"),
      );

      const index = await buildProjectIndex(root, { cache: "off" });
      const libMod = index.byFile.get(fileIdentityKey(libFile));
      const exported = localExportNames(libMod);
      expect(exported).toEqual(expect.arrayContaining(["Lib", "visible"]));
      expect(exported).not.toContain("hidden");
      expect(libMod?.locals.map((local) => local.localName)).toEqual(
        expect.arrayContaining(["Lib", "visible", "hidden", "usesLocal"]),
      );

      expect(resolveExport(index, libFile, "visible", { allowLocalFallback: false })?.kind).toBe("resolved");
      expect(resolveExport(index, libFile, "hidden", { allowLocalFallback: false })).toBeNull();
      expect(resolveExport(index, libFile, "hidden")).toBeNull();

      await testGoToDefinition(index, libFile, 6, tokenColumn(hiddenUse, "hidden"), libFile, 4);
      const hiddenRefs = await findReferences(index, {
        file: libFile,
        line: 4,
        column: tokenColumn(hiddenDef, "hidden"),
      });
      expect(hiddenRefs.status).toBe("ok");
      if (hiddenRefs.status === "ok") {
        expect(hiddenRefs.references.map((reference) => reference.range.start.line).sort()).toEqual(
          expect.arrayContaining([4, 6]),
        );
      }

      await testGoToDefinition(index, consumerFile, 6, tokenColumn(consumerVisible, "visible"), libFile, 3);
      await testGoToDefinition(
        index,
        consumerFile,
        7,
        tokenColumn(consumerHidden, "hidden"),
        undefined,
        undefined,
        "not_found",
      );
    });
  });

  it("keeps C# private members and namespace-scope internal types out of module exports", async () => {
    await withTempRoot("cg-vis-csharp-", async (root) => {
      const libFile = path.join(root, "Lib.cs").replace(/\\/g, "/");
      const consumerFile = path.join(root, "Consumer.cs").replace(/\\/g, "/");
      const hiddenDef = "    private void Hid() {}";
      const hiddenUse = "      Hid();";
      const visUse = "      Vis();";
      const consumerVisible = "    var ok = new Visible();";
      const consumerHidden = "    var no = new Hidden();";
      await writeFile(
        libFile,
        [
          "namespace Demo {",
          "  public class Visible {",
          "    public void Vis() {}",
          hiddenDef,
          "    internal void Intern() {}",
          "    public void UsesLocal() {",
          hiddenUse,
          visUse,
          "    }",
          "  }",
          "  internal class Hidden {}",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        consumerFile,
        ["using Demo;", "class Consumer {", "  void Run() {", consumerVisible, consumerHidden, "  }", "}", ""].join(
          "\n",
        ),
      );

      const index = await buildProjectIndex(root, { cache: "off" });
      const libMod = index.byFile.get(fileIdentityKey(libFile));
      const exported = localExportNames(libMod);
      expect(exported).toEqual(expect.arrayContaining(["Visible", "Vis", "Intern", "UsesLocal"]));
      expect(exported).not.toContain("Hid");
      expect(exported).not.toContain("Hidden");
      expect(libMod?.locals.map((local) => local.localName)).toEqual(
        expect.arrayContaining(["Visible", "Vis", "Hid", "Intern", "UsesLocal", "Hidden"]),
      );

      expect(resolveExport(index, libFile, "Visible", { allowLocalFallback: false })?.kind).toBe("resolved");
      expect(resolveExport(index, libFile, "Intern", { allowLocalFallback: false })?.kind).toBe("resolved");
      expect(resolveExport(index, libFile, "Hid", { allowLocalFallback: false })).toBeNull();
      expect(resolveExport(index, libFile, "Hidden", { allowLocalFallback: false })).toBeNull();
      expect(resolveExport(index, libFile, "Hidden")).toBeNull();

      await testGoToDefinition(index, libFile, 7, tokenColumn(hiddenUse, "Hid"), libFile, 4);
      const hiddenRefs = await findReferences(index, {
        file: libFile,
        line: 4,
        column: tokenColumn(hiddenDef, "Hid"),
      });
      expect(hiddenRefs.status).toBe("ok");
      if (hiddenRefs.status === "ok") {
        expect(hiddenRefs.references.map((reference) => reference.range.start.line).sort()).toEqual(
          expect.arrayContaining([4, 7]),
        );
      }

      await testGoToDefinition(index, consumerFile, 4, tokenColumn(consumerVisible, "Visible"), libFile, 2);
      await testGoToDefinition(
        index,
        consumerFile,
        5,
        tokenColumn(consumerHidden, "Hidden"),
        undefined,
        undefined,
        "not_found",
      );
    });
  });

  it("keeps Kotlin private and internal declarations out of module exports", async () => {
    await withTempRoot("cg-vis-kotlin-", async (root) => {
      const libFile = path.join(root, "vis", "Lib.kt").replace(/\\/g, "/");
      const consumerFile = path.join(root, "Consumer.kt").replace(/\\/g, "/");
      const hiddenDef = "private fun hidden() {}";
      const hiddenUse = "    hidden()";
      const visibleUse = "    visible()";
      const consumerVisible = "    visible()";
      const consumerHidden = "    hidden()";
      const consumerIntern = "    intern()";
      await mkdir(path.dirname(libFile), { recursive: true });
      await writeFile(
        libFile,
        [
          "package vis",
          "fun visible() {}",
          hiddenDef,
          "internal fun intern() {}",
          "fun usesLocal() {",
          hiddenUse,
          visibleUse,
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        consumerFile,
        [
          "import vis.visible",
          "import vis.hidden",
          "import vis.intern",
          "fun run() {",
          consumerVisible,
          consumerHidden,
          consumerIntern,
          "}",
          "",
        ].join("\n"),
      );

      const index = await buildProjectIndex(root, { cache: "off" });
      const libMod = index.byFile.get(fileIdentityKey(libFile));
      const exported = localExportNames(libMod);
      expect(exported).toEqual(expect.arrayContaining(["visible", "usesLocal"]));
      expect(exported).not.toContain("hidden");
      expect(exported).not.toContain("intern");
      expect(libMod?.locals.map((local) => local.localName)).toEqual(
        expect.arrayContaining(["visible", "hidden", "intern", "usesLocal"]),
      );

      expect(resolveExport(index, libFile, "visible", { allowLocalFallback: false })?.kind).toBe("resolved");
      expect(resolveExport(index, libFile, "hidden", { allowLocalFallback: false })).toBeNull();
      expect(resolveExport(index, libFile, "intern", { allowLocalFallback: false })).toBeNull();
      expect(resolveExport(index, libFile, "hidden")).toBeNull();
      expect(resolveExport(index, libFile, "intern")).toBeNull();

      await testGoToDefinition(index, libFile, 6, tokenColumn(hiddenUse, "hidden"), libFile, 3);
      const hiddenRefs = await findReferences(index, {
        file: libFile,
        line: 3,
        column: tokenColumn(hiddenDef, "hidden"),
      });
      expect(hiddenRefs.status).toBe("ok");
      if (hiddenRefs.status === "ok") {
        expect(hiddenRefs.references.map((reference) => reference.range.start.line).sort()).toEqual(
          expect.arrayContaining([3, 6]),
        );
      }

      await testGoToDefinition(index, consumerFile, 5, tokenColumn(consumerVisible, "visible"), libFile, 2);
      await testGoToDefinition(
        index,
        consumerFile,
        6,
        tokenColumn(consumerHidden, "hidden"),
        undefined,
        undefined,
        "not_found",
      );
      await testGoToDefinition(
        index,
        consumerFile,
        7,
        tokenColumn(consumerIntern, "intern"),
        undefined,
        undefined,
        "not_found",
      );
    });
  });

  it("keeps Swift private and fileprivate declarations out of module exports", async () => {
    await withTempRoot("cg-vis-swift-", async (root) => {
      const libFile = path.join(root, "Vis.swift").replace(/\\/g, "/");
      const consumerFile = path.join(root, "Consumer.swift").replace(/\\/g, "/");
      const hiddenDef = "private func hidden() {}";
      const fileHiddenDef = "fileprivate func fileHidden() {}";
      const hiddenUse = "  hidden()";
      const fileHiddenUse = "  fileHidden()";
      const consumerVisible = "  Vis.visible()";
      const consumerIntern = "  Vis.intern()";
      const consumerHidden = "  Vis.hidden()";
      const consumerFileHidden = "  Vis.fileHidden()";
      await writeFile(
        libFile,
        [
          "public func visible() {}",
          hiddenDef,
          fileHiddenDef,
          "internal func intern() {}",
          "func usesLocal() {",
          hiddenUse,
          fileHiddenUse,
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        consumerFile,
        [
          "import Vis",
          "func run() {",
          consumerVisible,
          consumerHidden,
          consumerFileHidden,
          consumerIntern,
          "}",
          "",
        ].join("\n"),
      );

      const index = await buildProjectIndex(root, { cache: "off" });
      const libMod = index.byFile.get(fileIdentityKey(libFile));
      const exported = localExportNames(libMod);
      expect(exported).toEqual(expect.arrayContaining(["visible", "intern", "usesLocal"]));
      expect(exported).not.toContain("hidden");
      expect(exported).not.toContain("fileHidden");
      expect(libMod?.locals.map((local) => local.localName)).toEqual(
        expect.arrayContaining(["visible", "hidden", "fileHidden", "intern", "usesLocal"]),
      );

      expect(resolveExport(index, libFile, "visible", { allowLocalFallback: false })?.kind).toBe("resolved");
      expect(resolveExport(index, libFile, "intern", { allowLocalFallback: false })?.kind).toBe("resolved");
      expect(resolveExport(index, libFile, "hidden", { allowLocalFallback: false })).toBeNull();
      expect(resolveExport(index, libFile, "fileHidden", { allowLocalFallback: false })).toBeNull();
      expect(resolveExport(index, libFile, "hidden")).toBeNull();
      expect(resolveExport(index, libFile, "fileHidden")).toBeNull();

      await testGoToDefinition(index, libFile, 6, tokenColumn(hiddenUse, "hidden"), libFile, 2);
      await testGoToDefinition(index, libFile, 7, tokenColumn(fileHiddenUse, "fileHidden"), libFile, 3);
      const hiddenRefs = await findReferences(index, {
        file: libFile,
        line: 2,
        column: tokenColumn(hiddenDef, "hidden"),
      });
      expect(hiddenRefs.status).toBe("ok");
      if (hiddenRefs.status === "ok") {
        expect(hiddenRefs.references.map((reference) => reference.range.start.line).sort()).toEqual(
          expect.arrayContaining([2, 6]),
        );
      }

      await testGoToDefinition(index, consumerFile, 3, tokenColumn(consumerVisible, "visible"), libFile, 1);
      await testGoToDefinition(index, consumerFile, 6, tokenColumn(consumerIntern, "intern"), libFile, 4);
      await testGoToDefinition(
        index,
        consumerFile,
        4,
        tokenColumn(consumerHidden, "hidden"),
        undefined,
        undefined,
        "not_found",
      );
      await testGoToDefinition(
        index,
        consumerFile,
        5,
        tokenColumn(consumerFileHidden, "fileHidden"),
        undefined,
        undefined,
        "not_found",
      );
    });
  });
});

describe("Python star re-export", () => {
  it("resolves from b import name after from a import * and rejects a missing name", async () => {
    await withTempRoot("cg-py-star-reexport-", async (root) => {
      const aFile = path.join(root, "a.py").replace(/\\/g, "/");
      const bFile = path.join(root, "b.py").replace(/\\/g, "/");
      const cFile = path.join(root, "c.py").replace(/\\/g, "/");
      const consumerName = "    name()";
      const consumerMissing = "    missing()";
      await writeFile(aFile, "def name():\n    return 1\n\ndef other():\n    return 2\n");
      await writeFile(bFile, "from a import *\n");
      await writeFile(
        cFile,
        ["from b import name", "from b import missing", "def run():", consumerName, consumerMissing, ""].join("\n"),
      );

      const index = await buildProjectIndex(root, { cache: "off" });
      const barrel = index.byFile.get(fileIdentityKey(bFile));
      expect(barrel?.exports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "exportStar",
            fromModule: expect.stringMatching(/a\.py$/),
          }),
        ]),
      );

      await testGoToDefinition(index, cFile, 4, tokenColumn(consumerName, "name"), aFile, 1);
      const missing = await goToDefinition(index, {
        file: cFile,
        line: 5,
        column: tokenColumn(consumerMissing, "missing"),
      });
      expect(missing.status).toBe("not_found");

      const namedImport = await goToDefinition(index, {
        file: cFile,
        line: 1,
        column: tokenColumn("from b import name", "name"),
      });
      expect(namedImport.status).toBe("ok");
      if (namedImport.status === "ok") {
        expect(fileIdentityKey(namedImport.definition.file)).toBe(fileIdentityKey(aFile));
      }
    });
  });
});

describe("declaration visibility local-fallback quadrants", () => {
  it("refuses an importer bind when every declaration in the file is hidden", async () => {
    await withTempRoot("cg-vis-all-private-rust-", async (root) => {
      const src = path.join(root, "src");
      await mkdir(src, { recursive: true });
      const visFile = path.join(src, "vis.rs").replace(/\\/g, "/");
      const consumerFile = path.join(src, "consumer.rs").replace(/\\/g, "/");
      const visHiddenDef = "fn hidden() {}";
      const visHiddenUse = "    hidden();";
      const consumerHidden = "    hidden();";
      await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "vis-all-private"\nversion = "0.1.0"\n');
      await writeFile(path.join(src, "lib.rs"), "mod vis;\npub mod consumer;\n");
      await writeFile(visFile, [visHiddenDef, "", "fn uses_local() {", visHiddenUse, "}", ""].join("\n"));
      await writeFile(consumerFile, ["use crate::vis::hidden;", "", "fn run() {", consumerHidden, "}", ""].join("\n"));

      const index = await buildProjectIndex(root, { cache: "off" });
      const visMod = index.byFile.get(fileIdentityKey(visFile));
      expect(visMod?.exports).toEqual([]);
      expect(visMod?.locals.map((local) => local.localName)).toEqual(expect.arrayContaining(["hidden", "uses_local"]));
      expect(resolveExport(index, visFile, "hidden")).toBeNull();

      await testGoToDefinition(index, visFile, 4, tokenColumn(visHiddenUse, "hidden"), visFile, 1);
      await testGoToDefinition(
        index,
        consumerFile,
        4,
        tokenColumn(consumerHidden, "hidden"),
        undefined,
        undefined,
        "not_found",
      );
    });
  });

  it("still falls back to an unexported name in a language with no visibility row", async () => {
    await withTempRoot("cg-vis-norow-ts-", async (root) => {
      const libFile = path.join(root, "lib.ts").replace(/\\/g, "/");
      const consumerFile = path.join(root, "consumer.ts").replace(/\\/g, "/");
      const consumerVisible = "    visible();";
      const consumerHidden = "    hidden();";
      await writeFile(libFile, "export function visible() {}\nfunction hidden() {}\n");
      await writeFile(
        consumerFile,
        ['import { visible, hidden } from "./lib";', "function run() {", consumerVisible, consumerHidden, "}", ""].join(
          "\n",
        ),
      );

      const index = await buildProjectIndex(root, { cache: "off" });
      const libMod = index.byFile.get(fileIdentityKey(libFile));
      const exported = localExportNames(libMod);
      expect(exported).toContain("visible");
      expect(exported).not.toContain("hidden");
      expect(libMod?.locals.map((local) => local.localName)).toEqual(expect.arrayContaining(["visible", "hidden"]));

      expect(resolveExport(index, libFile, "visible")?.kind).toBe("resolved");
      expect(resolveExport(index, libFile, "hidden")?.kind).toBe("resolved");

      await testGoToDefinition(index, consumerFile, 3, tokenColumn(consumerVisible, "visible"), libFile, 1);
      await testGoToDefinition(index, consumerFile, 4, tokenColumn(consumerHidden, "hidden"), libFile, 2);
    });
  });
});
