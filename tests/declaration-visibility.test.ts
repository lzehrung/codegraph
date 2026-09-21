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

  it("publishes Rust pub(in path) and keeps pub(self) file-local, including spaced spellings", async () => {
    await withTempRoot("cg-vis-rust-restricted-", async (root) => {
      const src = path.join(root, "src");
      await mkdir(src, { recursive: true });
      const visFile = path.join(src, "vis.rs").replace(/\\/g, "/");
      const consumerFile = path.join(src, "consumer.rs").replace(/\\/g, "/");
      const visSelfDef = "pub(self) fn self_vis() {}";
      const visSpacedSelfDef = "pub ( self ) fn spaced_self() {}";
      const visInPathDef = "pub(in crate) fn in_path_vis() {}";
      const visSelfStructDef = "pub(self) struct SelfStruct {}";
      const visInPathStructDef = "pub(in crate) struct InPathStruct {}";
      const visSelfConstDef = "pub(self) const SELF_CONST: i32 = 2;";
      const visInPathConstDef = "pub(in crate) const IN_PATH_CONST: i32 = 3;";
      const visSelfUse = "    self_vis();";
      const visSpacedSelfUse = "    spaced_self();";
      const visInPathUse = "    in_path_vis();";
      const visSelfStructUse = "    let _ = SelfStruct {};";
      const visInPathStructUse = "    let _ = InPathStruct {};";
      const visSelfConstUse = "    let _ = SELF_CONST;";
      const visInPathConstUse = "    let _ = IN_PATH_CONST;";
      const consumerSelf = "    self_vis();";
      const consumerSpacedSelf = "    spaced_self();";
      const consumerInPath = "    in_path_vis();";
      const consumerInPathStruct = "    let _ = InPathStruct {};";
      const consumerInPathConst = "    let _ = IN_PATH_CONST;";
      await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "vis-rust-restricted"\nversion = "0.1.0"\n');
      await writeFile(path.join(src, "lib.rs"), "mod vis;\npub mod consumer;\n");
      await writeFile(
        visFile,
        [
          "pub fn exported() {}",
          visSelfDef,
          visSpacedSelfDef,
          visInPathDef,
          visSelfStructDef,
          visInPathStructDef,
          visSelfConstDef,
          visInPathConstDef,
          "",
          "fn uses_local() {",
          visSelfUse,
          visSpacedSelfUse,
          visInPathUse,
          visSelfStructUse,
          visInPathStructUse,
          visSelfConstUse,
          visInPathConstUse,
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        consumerFile,
        [
          "use crate::vis::self_vis;",
          "use crate::vis::spaced_self;",
          "use crate::vis::in_path_vis;",
          "use crate::vis::SelfStruct;",
          "use crate::vis::InPathStruct;",
          "use crate::vis::SELF_CONST;",
          "use crate::vis::IN_PATH_CONST;",
          "",
          "fn run() {",
          consumerSelf,
          consumerSpacedSelf,
          consumerInPath,
          "    let _ = SelfStruct {};",
          consumerInPathStruct,
          "    let _ = SELF_CONST;",
          consumerInPathConst,
          "}",
          "",
        ].join("\n"),
      );

      const index = await buildProjectIndex(root, { cache: "off" });
      const visMod = index.byFile.get(fileIdentityKey(visFile));
      const exported = localExportNames(visMod);
      expect(exported).toEqual(expect.arrayContaining(["exported", "in_path_vis", "InPathStruct", "IN_PATH_CONST"]));
      expect(exported).not.toContain("self_vis");
      expect(exported).not.toContain("spaced_self");
      expect(exported).not.toContain("SelfStruct");
      expect(exported).not.toContain("SELF_CONST");
      expect(visMod?.locals.map((local) => local.localName)).toEqual(
        expect.arrayContaining([
          "exported",
          "self_vis",
          "spaced_self",
          "in_path_vis",
          "SelfStruct",
          "InPathStruct",
          "SELF_CONST",
          "IN_PATH_CONST",
          "uses_local",
        ]),
      );

      expect(resolveExport(index, visFile, "in_path_vis", { allowLocalFallback: false })?.kind).toBe("resolved");
      expect(resolveExport(index, visFile, "InPathStruct", { allowLocalFallback: false })?.kind).toBe("resolved");
      expect(resolveExport(index, visFile, "IN_PATH_CONST", { allowLocalFallback: false })?.kind).toBe("resolved");
      expect(resolveExport(index, visFile, "self_vis", { allowLocalFallback: false })).toBeNull();
      expect(resolveExport(index, visFile, "spaced_self", { allowLocalFallback: false })).toBeNull();
      expect(resolveExport(index, visFile, "self_vis")).toBeNull();
      expect(resolveExport(index, visFile, "spaced_self")).toBeNull();
      expect(resolveExport(index, visFile, "SelfStruct")).toBeNull();
      expect(resolveExport(index, visFile, "SELF_CONST")).toBeNull();

      await testGoToDefinition(index, visFile, 11, tokenColumn(visSelfUse, "self_vis"), visFile, 2);
      await testGoToDefinition(index, visFile, 12, tokenColumn(visSpacedSelfUse, "spaced_self"), visFile, 3);
      await testGoToDefinition(index, visFile, 13, tokenColumn(visInPathUse, "in_path_vis"), visFile, 4);
      const selfRefs = await findReferences(index, {
        file: visFile,
        line: 2,
        column: tokenColumn(visSelfDef, "self_vis"),
      });
      expect(selfRefs.status).toBe("ok");
      if (selfRefs.status === "ok") {
        expect(selfRefs.references.map((reference) => reference.range.start.line).sort()).toEqual(
          expect.arrayContaining([2, 11]),
        );
      }

      await testGoToDefinition(index, consumerFile, 12, tokenColumn(consumerInPath, "in_path_vis"), visFile, 4);
      await testGoToDefinition(index, consumerFile, 14, tokenColumn(consumerInPathStruct, "InPathStruct"), visFile, 6);
      await testGoToDefinition(index, consumerFile, 16, tokenColumn(consumerInPathConst, "IN_PATH_CONST"), visFile, 8);
      await testGoToDefinition(
        index,
        consumerFile,
        10,
        tokenColumn(consumerSelf, "self_vis"),
        undefined,
        undefined,
        "not_found",
      );
      await testGoToDefinition(
        index,
        consumerFile,
        11,
        tokenColumn(consumerSpacedSelf, "spaced_self"),
        undefined,
        undefined,
        "not_found",
      );
    });
  });

  it("exports crate-root and nested pub(crate), inline-mod pub items, and a pub use of pub(super)", async () => {
    await withTempRoot("cg-vis-rust-lattice-", async (root) => {
      const src = path.join(root, "src");
      await mkdir(src, { recursive: true });
      const visFile = path.join(src, "vis.rs").replace(/\\/g, "/");
      const consumerFile = path.join(src, "consumer.rs").replace(/\\/g, "/");
      const libFile = path.join(src, "lib.rs").replace(/\\/g, "/");
      const nestedCrateDef = "pub(crate) fn nested_crate() {}";
      const innerSuperDef = "        pub(super) fn inner_super() {}";
      const innerSelfDef = "        pub(self) fn inner_self() {}";
      const innerPrivDef = "        fn inner_priv() {}";
      const innerInDef = "        pub(in crate::vis) fn inner_in() {}";
      const consumerNestedCrate = "    nested_crate();";
      const consumerRootCrate = "    root_crate();";
      const consumerInnerSuper = "    inner_super();";
      const consumerInnerSelf = "    inner_self();";
      const consumerInnerIn = "    inner_in();";
      await writeFile(path.join(root, "Cargo.toml"), '[package]\nname = "vis-rust-lattice"\nversion = "0.1.0"\n');
      await writeFile(libFile, "mod vis;\npub mod consumer;\npub(crate) fn root_crate() {}\n");
      await writeFile(
        visFile,
        [
          nestedCrateDef,
          "mod inner {",
          "        pub fn inner_pub() {}",
          innerSuperDef,
          innerSelfDef,
          innerPrivDef,
          innerInDef,
          "}",
          "pub use inner::inner_super;",
          "",
        ].join("\n"),
      );
      await writeFile(
        consumerFile,
        [
          "use crate::vis::nested_crate;",
          "use crate::root_crate;",
          "use crate::vis::inner_super;",
          "use crate::vis::inner_self;",
          "use crate::vis::inner_in;",
          "use crate::vis::inner_pub;",
          "",
          "fn run() {",
          consumerNestedCrate,
          consumerRootCrate,
          consumerInnerSuper,
          consumerInnerSelf,
          consumerInnerIn,
          "    inner_pub();",
          "}",
          "",
        ].join("\n"),
      );

      const index = await buildProjectIndex(root, { cache: "off" });
      const visMod = index.byFile.get(fileIdentityKey(visFile));
      const libMod = index.byFile.get(fileIdentityKey(libFile));
      const visExported = localExportNames(visMod);
      expect(visExported).toEqual(expect.arrayContaining(["nested_crate", "inner_pub", "inner_super", "inner_in"]));
      expect(visExported).not.toContain("inner_self");
      expect(visExported).not.toContain("inner_priv");
      expect(localExportNames(libMod)).toContain("root_crate");
      expect(
        (visMod?.exports ?? []).some((entry) => entry.type === "reexport" && entry.exportedAs === "inner_super"),
      ).toBe(true);

      expect(resolveExport(index, visFile, "nested_crate", { allowLocalFallback: false })?.kind).toBe("resolved");
      expect(resolveExport(index, libFile, "root_crate", { allowLocalFallback: false })?.kind).toBe("resolved");
      expect(resolveExport(index, visFile, "inner_in", { allowLocalFallback: false })?.kind).toBe("resolved");
      expect(resolveExport(index, visFile, "inner_self", { allowLocalFallback: false })).toBeNull();
      expect(resolveExport(index, visFile, "inner_priv")).toBeNull();

      await testGoToDefinition(index, consumerFile, 9, tokenColumn(consumerNestedCrate, "nested_crate"), visFile, 1);
      await testGoToDefinition(index, consumerFile, 10, tokenColumn(consumerRootCrate, "root_crate"), libFile, 3);
      await testGoToDefinition(index, consumerFile, 11, tokenColumn(consumerInnerSuper, "inner_super"), visFile, 4);
      await testGoToDefinition(index, consumerFile, 13, tokenColumn(consumerInnerIn, "inner_in"), visFile, 7);
      await testGoToDefinition(
        index,
        consumerFile,
        12,
        tokenColumn(consumerInnerSelf, "inner_self"),
        undefined,
        undefined,
        "not_found",
      );
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

  it("keeps C file-scope static names local while non-static siblings stay importable", async () => {
    await withTempRoot("cg-vis-c-", async (root) => {
      const visFile = path.join(root, "vis.c").replace(/\\/g, "/");
      const consumerFile = path.join(root, "consumer.c").replace(/\\/g, "/");
      const visHiddenDef = "static int helper(void) {";
      const visHiddenUse = "  return helper();";
      const consumerUse = "int run(void) { return helper() + visible(); }";
      await writeFile(visFile, [visHiddenDef, visHiddenUse, "}", "int visible(void) { return 1; }", ""].join("\n"));
      await writeFile(consumerFile, ['#include "./vis.c"', consumerUse, ""].join("\n"));

      const index = await buildProjectIndex(root, { cache: "off" });
      const visMod = index.byFile.get(fileIdentityKey(visFile));
      const exported = localExportNames(visMod);
      expect(exported).toEqual(expect.arrayContaining(["visible"]));
      expect(exported).not.toContain("helper");
      expect(visMod?.locals.map((local) => local.localName)).toEqual(expect.arrayContaining(["helper", "visible"]));

      expect(resolveExport(index, visFile, "visible", { allowLocalFallback: false })?.kind).toBe("resolved");
      expect(resolveExport(index, visFile, "helper", { allowLocalFallback: false })).toBeNull();
      expect(resolveExport(index, visFile, "helper")).toBeNull();

      await testGoToDefinition(index, visFile, 2, tokenColumn(visHiddenUse, "helper"), visFile, 1);
      const hiddenRefs = await findReferences(index, {
        file: visFile,
        line: 1,
        column: tokenColumn(visHiddenDef, "helper"),
      });
      expect(hiddenRefs.status).toBe("ok");
      if (hiddenRefs.status === "ok") {
        expect(hiddenRefs.references.map((reference) => reference.range.start.line).sort()).toEqual(
          expect.arrayContaining([1, 2]),
        );
        expect(
          hiddenRefs.references.some((reference) => fileIdentityKey(reference.file) === fileIdentityKey(consumerFile)),
        ).toBe(false);
      }

      await testGoToDefinition(index, consumerFile, 2, tokenColumn(consumerUse, "visible"), visFile, 4);
      await testGoToDefinition(
        index,
        consumerFile,
        2,
        tokenColumn(consumerUse, "helper"),
        undefined,
        undefined,
        "not_found",
      );
    });
  });

  it("keeps C++ file-scope static names local while class and struct static members stay exported", async () => {
    await withTempRoot("cg-vis-cpp-", async (root) => {
      const visFile = path.join(root, "vis.cpp").replace(/\\/g, "/");
      const consumerFile = path.join(root, "consumer.cpp").replace(/\\/g, "/");
      const visHiddenDef = "static int helper() {";
      const visHiddenUse = "  return helper();";
      const visClass = "class Foo { public: static int member; static int method(); };";
      const visStruct = "struct Bar { static int field; };";
      const consumerUse = "int run() { return helper() + visible(); }";
      await writeFile(
        visFile,
        [visHiddenDef, visHiddenUse, "}", "int visible() { return 1; }", visClass, visStruct, ""].join("\n"),
      );
      await writeFile(consumerFile, ['#include "./vis.cpp"', consumerUse, ""].join("\n"));

      const index = await buildProjectIndex(root, { cache: "off" });
      const visMod = index.byFile.get(fileIdentityKey(visFile));
      const exported = localExportNames(visMod);
      expect(exported).toEqual(expect.arrayContaining(["visible", "Foo", "method", "Bar"]));
      expect(exported).not.toContain("helper");
      expect(visMod?.locals.map((local) => local.localName)).toEqual(
        expect.arrayContaining(["helper", "visible", "Foo", "member", "method", "Bar", "field"]),
      );

      expect(resolveExport(index, visFile, "visible", { allowLocalFallback: false })?.kind).toBe("resolved");
      expect(resolveExport(index, visFile, "method", { allowLocalFallback: false })?.kind).toBe("resolved");
      expect(resolveExport(index, visFile, "helper", { allowLocalFallback: false })).toBeNull();
      expect(resolveExport(index, visFile, "helper")).toBeNull();

      await testGoToDefinition(index, visFile, 2, tokenColumn(visHiddenUse, "helper"), visFile, 1);
      const hiddenRefs = await findReferences(index, {
        file: visFile,
        line: 1,
        column: tokenColumn(visHiddenDef, "helper"),
      });
      expect(hiddenRefs.status).toBe("ok");
      if (hiddenRefs.status === "ok") {
        expect(hiddenRefs.references.map((reference) => reference.range.start.line).sort()).toEqual(
          expect.arrayContaining([1, 2]),
        );
        expect(
          hiddenRefs.references.some((reference) => fileIdentityKey(reference.file) === fileIdentityKey(consumerFile)),
        ).toBe(false);
      }

      await testGoToDefinition(index, consumerFile, 2, tokenColumn(consumerUse, "visible"), visFile, 4);
      await testGoToDefinition(
        index,
        consumerFile,
        2,
        tokenColumn(consumerUse, "helper"),
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
