import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed } from "../src/graphs/symbol-graph-detailed.js";
import { buildProjectIndex, buildProjectIndexFromFiles, findReferences, goToDefinition } from "../src/index.js";
import type { ProjectIndex } from "../src/indexer/types.js";
import { fileIdentityKey, normalizePath } from "../src/util/paths.js";
import { mkTmpDir } from "./helpers/filesystem.js";

const files = {
  "kotlin/utils/Helper.kt": "package utils\nfun helperFunction(value: Int): Int = value + 1\n",
  "kotlin/utils/UtilityClass.kt": [
    "package utils",
    "class UtilityClass(val value: Int) {",
    "  companion object {",
    "    fun member(): Int = 2",
    "  }",
    "}",
  ].join("\n"),
  "kotlin/other/Decoy.kt":
    "package other\nfun helperFunction(value: Int): Int = -1\nclass UtilityClass(val value: Int)\n",
  "kotlin/app/Consumer.kt": [
    "package app",
    "import utils.*",
    "fun consumeHelper(): Int = helperFunction(4)",
    "fun consumeClass(): UtilityClass = UtilityClass(5)",
    "fun consumeMember(): Int = member()",
  ].join("\n"),
  "java/p/Mode.java": "package p; public enum Mode { FAST, SLOW }",
  "java/p/Other.java": "package p; public class Other {}",
  "java/p/PackageService.java": "package p; public interface PackageService { void serve(); }",
  "java/p/PackageTypes.java": "package p; public class PackageTypes { public static class NestedValue {} }",
  "java/other/Mode.java": "package other; public enum Mode { FAST, SLOW }",
  "java/client/WildcardImports.java": [
    "package client;",
    "import p.*;",
    "class WildcardImports {",
    "  Mode mode = Mode.FAST;",
    "  PackageService service;",
    "  NestedValue nested;",
    "  void use() { serve(); }",
    "}",
  ].join("\n"),
};

describe("JVM package wildcard graph edges", () => {
  it("keeps Kotlin use and binding edges for all package files without importing decoys", async () => {
    const root = await mkTmpDir("cg-kotlin-star-edges-");
    try {
      for (const [name, source] of Object.entries(files)) {
        const file = path.join(root, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, source);
      }
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      const graph = await buildSymbolGraphDetailed(index);
      const nodes = [...graph.nodes.values()];
      const node = (file: string, name: string, kind?: string) =>
        nodes.find(
          (entry) =>
            entry.file === normalizePath(path.join(root, file)) &&
            entry.name === name &&
            (!kind || entry.kind === kind),
        );
      const helper = node("kotlin/utils/Helper.kt", "helperFunction");
      const util = node("kotlin/utils/UtilityClass.kt", "UtilityClass");
      const decoy = node("kotlin/other/Decoy.kt", "helperFunction");
      const consumer = node("kotlin/app/Consumer.kt", "consumeHelper");
      const helperImport = node("kotlin/app/Consumer.kt", "helperFunction", "import");
      const classImport = node("kotlin/app/Consumer.kt", "UtilityClass", "import");
      const member = node("kotlin/utils/UtilityClass.kt", "member");
      const consumerMember = node("kotlin/app/Consumer.kt", "consumeMember");
      const memberImport = node("kotlin/app/Consumer.kt", "member", "import");
      expect(helper).toBeDefined();
      expect(util).toBeDefined();
      expect(decoy).toBeDefined();
      expect(consumer).toBeDefined();
      expect(helperImport).toBeDefined();
      expect(classImport).toBeDefined();
      expect(member).toBeDefined();
      expect(consumerMember).toBeDefined();
      expect(memberImport).toBeUndefined();
      const edge = (from: string | undefined, to: string | undefined, label?: string) =>
        graph.edges.some(
          (candidate) => candidate.from === from && candidate.to === to && (!label || candidate.label === label),
        );
      expect(edge(consumer?.id, helper?.id, "uses")).toBe(true);
      expect(edge(helperImport?.id, helper?.id)).toBe(true);
      expect(edge(classImport?.id, util?.id)).toBe(true);
      expect(edge(consumer?.id, decoy?.id, "uses")).toBe(false);
      expect(edge(helperImport?.id, decoy?.id)).toBe(false);
      expect(edge(consumerMember?.id, member?.id)).toBe(false);
      const kotlinConsumer = path.join(root, "kotlin/app/Consumer.kt");
      const memberLine = files["kotlin/app/Consumer.kt"].split("\n")[4]!;
      const memberGoto = await goToDefinition(index, {
        file: kotlinConsumer,
        line: 5,
        column: memberLine.lastIndexOf("member") + 1,
      });
      expect(memberGoto.status).toBe("not_found");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("binds only Java package types, not their members or nested types", async () => {
    const root = await mkTmpDir("cg-java-star-edges-");
    try {
      for (const [name, source] of Object.entries(files)) {
        const file = path.join(root, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, source);
      }
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      const graph = await buildSymbolGraphDetailed(index);
      const nodes = [...graph.nodes.values()];
      const node = (file: string, name: string, kind?: string) =>
        nodes.find(
          (entry) =>
            entry.file === normalizePath(path.join(root, file)) &&
            entry.name === name &&
            (!kind || entry.kind === kind),
        );
      const mode = node("java/p/Mode.java", "Mode");
      const service = node("java/p/PackageService.java", "PackageService");
      const serve = node("java/p/PackageService.java", "serve");
      const fast = node("java/p/Mode.java", "FAST");
      const decoy = node("java/other/Mode.java", "Mode");
      const modeImport = node("java/client/WildcardImports.java", "Mode", "import");
      const serviceImport = node("java/client/WildcardImports.java", "PackageService", "import");
      const fastImport = node("java/client/WildcardImports.java", "FAST", "import");
      const serveImport = node("java/client/WildcardImports.java", "serve", "import");
      const nestedImport = node("java/client/WildcardImports.java", "NestedValue", "import");
      const caller = node("java/client/WildcardImports.java", "use");
      expect(mode).toBeDefined();
      expect(service).toBeDefined();
      expect(serve).toBeDefined();
      expect(fast).toBeDefined();
      expect(decoy).toBeDefined();
      expect(modeImport).toBeDefined();
      expect(serviceImport).toBeDefined();
      expect(fastImport).toBeUndefined();
      expect(serveImport).toBeUndefined();
      expect(nestedImport).toBeUndefined();
      expect(caller).toBeDefined();
      const edge = (from: string | undefined, to: string | undefined) =>
        graph.edges.some((candidate) => candidate.from === from && candidate.to === to);
      expect(edge(modeImport?.id, mode?.id)).toBe(true);
      expect(edge(serviceImport?.id, service?.id)).toBe(true);
      expect(edge(modeImport?.id, decoy?.id)).toBe(false);
      expect(edge(caller?.id, serve?.id)).toBe(false);
      const javaConsumer = path.join(root, "java/client/WildcardImports.java");
      const javaLines = files["java/client/WildcardImports.java"].split("\n");
      const serveGoto = await goToDefinition(index, {
        file: javaConsumer,
        line: 7,
        column: javaLines[6]!.indexOf("serve") + 1,
      });
      expect(serveGoto.status).toBe("not_found");
      const serviceGoto = await goToDefinition(index, {
        file: javaConsumer,
        line: 5,
        column: javaLines[4]!.indexOf("PackageService") + 1,
      });
      expect(serviceGoto.status).toBe("ok");
      if (serviceGoto.status === "ok")
        expect(serviceGoto.definition.file).toBe(normalizePath(path.join(root, "java/p/PackageService.java")));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("resolves mixed Java and Kotlin package wildcards without Java importing Kotlin functions", async () => {
    const root = await mkTmpDir("cg-mixed-jvm-package-");
    const sources = {
      "java/p/Mode.java": "package p; public enum Mode { FAST, SLOW }",
      "kotlin/p/Helpers.kt": "package p\nclass KotlinWidget\nfun helperFunction(): Int = 1\n",
      "kotlin/app/Consumer.kt": [
        "package app",
        "import p.*",
        "fun consumeMode(): Mode = Mode.FAST",
        "fun consumeWidget(): KotlinWidget = KotlinWidget()",
        "fun consumeHelper(): Int = helperFunction()",
      ].join("\n"),
      "java/client/Consumer.java": [
        "package client;",
        "import p.*;",
        "class Consumer {",
        "  KotlinWidget widget;",
        "  Mode mode;",
        "  void use() { helperFunction(); }",
        "}",
      ].join("\n"),
    };
    try {
      for (const [name, source] of Object.entries(sources)) {
        const file = path.join(root, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, source);
      }
      const index = await buildProjectIndex(root, { cache: "disk", native: "on" });
      const graph = await buildSymbolGraphDetailed(index);
      const nodes = [...graph.nodes.values()];
      const node = (file: keyof typeof sources, name: string, kind?: string) =>
        nodes.find(
          (entry) =>
            entry.file === normalizePath(path.join(root, file)) &&
            entry.name === name &&
            (!kind || entry.kind === kind),
        );
      const mode = node("java/p/Mode.java", "Mode");
      const widget = node("kotlin/p/Helpers.kt", "KotlinWidget");
      const helper = node("kotlin/p/Helpers.kt", "helperFunction");
      const kotlinMode = node("kotlin/app/Consumer.kt", "Mode", "import");
      const kotlinWidget = node("kotlin/app/Consumer.kt", "KotlinWidget", "import");
      const kotlinHelper = node("kotlin/app/Consumer.kt", "helperFunction", "import");
      const javaMode = node("java/client/Consumer.java", "Mode", "import");
      const javaWidget = node("java/client/Consumer.java", "KotlinWidget", "import");
      const javaHelper = node("java/client/Consumer.java", "helperFunction", "import");
      const kotlinCaller = node("kotlin/app/Consumer.kt", "consumeHelper");
      const javaCaller = node("java/client/Consumer.java", "use");
      const edge = (from?: string, to?: string) => graph.edges.some((entry) => entry.from === from && entry.to === to);
      expect(mode).toBeDefined();
      expect(widget).toBeDefined();
      expect(helper).toBeDefined();
      expect(kotlinMode).toBeDefined();
      expect(kotlinWidget).toBeDefined();
      expect(kotlinHelper).toBeDefined();
      expect(javaMode).toBeDefined();
      expect(javaWidget).toBeDefined();
      expect(javaHelper).toBeUndefined();
      expect(kotlinCaller).toBeDefined();
      expect(javaCaller).toBeDefined();
      expect(edge(kotlinMode?.id, mode?.id)).toBe(true);
      expect(edge(kotlinWidget?.id, widget?.id)).toBe(true);
      expect(edge(kotlinHelper?.id, helper?.id)).toBe(true);
      expect(edge(javaMode?.id, mode?.id)).toBe(true);
      expect(edge(javaWidget?.id, widget?.id)).toBe(true);
      expect(edge(kotlinCaller?.id, helper?.id)).toBe(true);
      expect(edge(javaCaller?.id, helper?.id)).toBe(false);
      const goto = async (file: keyof typeof sources, line: number, token: string, projectIndex = index) => {
        const sourceLine = sources[file].split("\n")[line - 1]!;
        return await goToDefinition(projectIndex, {
          file: path.join(root, file),
          line,
          column: sourceLine.lastIndexOf(token) + 1,
        });
      };
      const kotlinModeGoto = await goto("kotlin/app/Consumer.kt", 3, "Mode");
      const javaWidgetGoto = await goto("java/client/Consumer.java", 4, "KotlinWidget");
      const kotlinHelperGoto = await goto("kotlin/app/Consumer.kt", 5, "helperFunction");
      const javaHelperGoto = await goto("java/client/Consumer.java", 6, "helperFunction");
      expect(kotlinModeGoto.status).toBe("ok");
      if (kotlinModeGoto.status === "ok") expect(kotlinModeGoto.definition.file).toBe(mode?.file);
      expect(javaWidgetGoto.status).toBe("ok");
      if (javaWidgetGoto.status === "ok") expect(javaWidgetGoto.definition.file).toBe(widget?.file);
      expect(kotlinHelperGoto.status).toBe("ok");
      if (kotlinHelperGoto.status === "ok") expect(kotlinHelperGoto.definition.file).toBe(helper?.file);
      expect(javaHelperGoto.status).toBe("not_found");
      const widgetReferences = await findReferences(index, {
        file: path.join(root, "kotlin/p/Helpers.kt"),
        line: 2,
        column: sources["kotlin/p/Helpers.kt"].split("\n")[1]!.indexOf("KotlinWidget") + 1,
      });
      expect(widgetReferences.status).toBe("ok");
      if (widgetReferences.status === "ok") {
        const javaSites = widgetReferences.references
          .filter((reference) => reference.file === normalizePath(path.join(root, "java/client/Consumer.java")))
          .map((reference) => reference.range.start.line);
        expect(javaSites).toContain(4);
        expect(javaSites).not.toContain(6);
      }
      const helperReferences = await findReferences(index, {
        file: path.join(root, "kotlin/p/Helpers.kt"),
        line: 3,
        column: sources["kotlin/p/Helpers.kt"].split("\n")[2]!.indexOf("helperFunction") + 1,
      });
      expect(helperReferences.status).toBe("ok");
      if (helperReferences.status === "ok") {
        const kotlinSites = helperReferences.references
          .filter((reference) => reference.file === normalizePath(path.join(root, "kotlin/app/Consumer.kt")))
          .map((reference) => reference.range.start.line);
        const javaSites = helperReferences.references
          .filter((reference) => reference.file === normalizePath(path.join(root, "java/client/Consumer.java")))
          .map((reference) => reference.range.start.line);
        expect(kotlinSites).toContain(5);
        expect(javaSites).not.toContain(6);
      }
      const warm = await buildProjectIndex(root, { cache: "disk", native: "on" });
      const warmGraph = await buildSymbolGraphDetailed(warm);
      const warmNodes = [...warmGraph.nodes.values()];
      const warmJavaWidget = warmNodes.find(
        (entry) =>
          entry.file === normalizePath(path.join(root, "java/client/Consumer.java")) &&
          entry.name === "KotlinWidget" &&
          entry.kind === "import",
      );
      const warmWidgetTarget = warmNodes.find(
        (entry) =>
          entry.file === normalizePath(path.join(root, "kotlin/p/Helpers.kt")) &&
          entry.name === "KotlinWidget" &&
          entry.kind === "class",
      );
      const warmJavaHelper = warmNodes.find(
        (entry) =>
          entry.file === normalizePath(path.join(root, "java/client/Consumer.java")) &&
          entry.name === "helperFunction" &&
          entry.kind === "import",
      );
      const warmJavaCaller = warmNodes.find(
        (entry) => entry.file === normalizePath(path.join(root, "java/client/Consumer.java")) && entry.name === "use",
      );
      const warmHelperTarget = warmNodes.find(
        (entry) =>
          entry.file === normalizePath(path.join(root, "kotlin/p/Helpers.kt")) && entry.name === "helperFunction",
      );
      expect(
        warmGraph.edges.some((entry) => entry.from === warmJavaWidget?.id && entry.to === warmWidgetTarget?.id),
      ).toBe(true);
      expect(warmJavaHelper).toBeUndefined();
      expect(warmJavaCaller).toBeDefined();
      expect(warmHelperTarget).toBeDefined();
      expect(
        warmGraph.edges.some((entry) => entry.from === warmJavaCaller?.id && entry.to === warmHelperTarget?.id),
      ).toBe(false);
      const warmJavaWidgetGoto = await goto("java/client/Consumer.java", 4, "KotlinWidget", warm);
      const warmJavaHelperGoto = await goto("java/client/Consumer.java", 6, "helperFunction", warm);
      expect(warmJavaWidgetGoto.status).toBe("ok");
      if (warmJavaWidgetGoto.status === "ok") expect(warmJavaWidgetGoto.definition.file).toBe(widget?.file);
      expect(warmJavaHelperGoto.status).toBe("not_found");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves JVM type-on-demand nested types without importing ordinary class members", async () => {
    const root = await mkTmpDir("cg-jvm-type-wildcard-");
    const sources = {
      "java/p/C.java": [
        "package p;",
        "public class C {",
        "  public static class Inner {}",
        "  static class PackageInner {}",
        "  private static class Secret {}",
        "  public static int ping() { return 1; }",
        "}",
        "class Neighbor { public static class Inner {} public static class Other {} }",
      ].join("\n"),
      "java/q/C.java": "package q; public class C { public static class Inner {} }",
      "java/p/I.java": "package p; public interface I { class Member {} }",
      "java/q/I.java": "package q; public interface I { class Member {} }",
      "java/client/IUse.java": "package client;\nimport p.I.*;\nclass IUse { Member member; }",
      "java/p/Peer.java": "package p;\nimport p.C.*;\nclass Peer { PackageInner value; }",
      "java/client/Use.java": [
        "package client;",
        "import p.C.*;",
        "class Use {",
        "  Inner value;",
        "  Other other;",
        "  int call() { return ping(); }",
        "  PackageInner packageInner;",
        "  Secret secret;",
        "}",
      ].join("\n"),
      "kotlin/p/Box.kt": [
        "package p",
        "class Box {",
        "  class Nested",
        "  object Singleton",
        "  private class Hidden",
        "  fun run(): Int = 1",
        "}",
        "class Neighbor { class Nested; class Other }",
      ].join("\n"),
      "kotlin/q/Box.kt": "package q\nclass Box { class Nested }",
      "kotlin/client/Use.kt": [
        "package client",
        "import p.Box.*",
        "class Use(val nested: Nested, val singleton: Singleton, val other: Other)",
        "fun call(): Int = run()",
        "class PrivateReference(val hidden: Hidden)",
      ].join("\n"),
    };
    try {
      for (const [name, source] of Object.entries(sources)) {
        const file = path.join(root, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, source);
      }
      const index = await buildProjectIndex(root, { cache: "disk", native: "on" });
      const goto = async (file: keyof typeof sources, line: number, token: string) => {
        const sourceLine = sources[file].split("\n")[line - 1]!;
        return goToDefinition(index, { file: path.join(root, file), line, column: sourceLine.indexOf(token) + 1 });
      };
      const inner = await goto("java/client/Use.java", 4, "Inner");
      const nested = await goto("kotlin/client/Use.kt", 3, "Nested");
      const singleton = await goto("kotlin/client/Use.kt", 3, "Singleton");
      const packageInner = await goto("java/p/Peer.java", 3, "PackageInner");
      const interfaceMember = await goto("java/client/IUse.java", 3, "Member");
      expect(interfaceMember.status).toBe("ok");
      if (interfaceMember.status === "ok")
        expect(interfaceMember.definition.file).toBe(normalizePath(path.join(root, "java/p/I.java")));
      expect(packageInner.status).toBe("ok");
      if (packageInner.status === "ok")
        expect(packageInner.definition.file).toBe(normalizePath(path.join(root, "java/p/C.java")));
      expect(inner.status).toBe("ok");
      expect(nested.status).toBe("ok");
      expect(singleton.status).toBe("ok");
      if (inner.status === "ok") expect(inner.definition.file).toBe(normalizePath(path.join(root, "java/p/C.java")));
      if (nested.status === "ok")
        expect(nested.definition.file).toBe(normalizePath(path.join(root, "kotlin/p/Box.kt")));
      if (singleton.status === "ok")
        expect(singleton.definition.file).toBe(normalizePath(path.join(root, "kotlin/p/Box.kt")));
      if (inner.status === "ok") expect(inner.definition.range.start.line).toBe(3);
      if (nested.status === "ok") expect(nested.definition.range.start.line).toBe(3);
      expect((await goto("java/client/Use.java", 5, "Other")).status).toBe("not_found");
      expect((await goto("java/client/Use.java", 6, "ping")).status).toBe("not_found");
      expect((await goto("kotlin/client/Use.kt", 3, "Other")).status).toBe("not_found");
      expect((await goto("kotlin/client/Use.kt", 4, "run")).status).toBe("not_found");
      expect((await goto("java/client/Use.java", 7, "PackageInner")).status).toBe("not_found");
      expect((await goto("java/client/Use.java", 8, "Secret")).status).toBe("not_found");
      expect((await goto("kotlin/client/Use.kt", 5, "Hidden")).status).toBe("not_found");
      const refs = async (file: keyof typeof sources, line: number, token: string) => {
        const sourceLine = sources[file].split("\n")[line - 1]!;
        return findReferences(index, { file: path.join(root, file), line, column: sourceLine.indexOf(token) + 1 });
      };
      const innerRefs = await refs("java/p/C.java", 3, "Inner");
      const nestedRefs = await refs("kotlin/p/Box.kt", 3, "Nested");
      const javaDecoyRefs = await refs("java/p/C.java", 8, "Inner");
      const kotlinDecoyRefs = await refs("kotlin/p/Box.kt", 8, "Nested");
      expect(innerRefs.status).toBe("ok");
      expect(nestedRefs.status).toBe("ok");
      expect(javaDecoyRefs.status).toBe("ok");
      expect(kotlinDecoyRefs.status).toBe("ok");
      if (innerRefs.status === "ok") {
        expect(
          innerRefs.references.some(
            (ref) => ref.file === normalizePath(path.join(root, "java/client/Use.java")) && ref.range.start.line === 4,
          ),
        ).toBe(true);
      }
      if (nestedRefs.status === "ok") {
        expect(
          nestedRefs.references.some(
            (ref) => ref.file === normalizePath(path.join(root, "kotlin/client/Use.kt")) && ref.range.start.line === 3,
          ),
        ).toBe(true);
      }
      if (javaDecoyRefs.status === "ok") {
        expect(
          javaDecoyRefs.references.some((ref) => ref.file === normalizePath(path.join(root, "java/client/Use.java"))),
        ).toBe(false);
      }
      if (kotlinDecoyRefs.status === "ok") {
        expect(
          kotlinDecoyRefs.references.some((ref) => ref.file === normalizePath(path.join(root, "kotlin/client/Use.kt"))),
        ).toBe(false);
      }
      const graph = await buildSymbolGraphDetailed(index);
      const node = (file: keyof typeof sources, name: string, kind?: string) =>
        [...graph.nodes.values()].find(
          (entry) =>
            entry.file === normalizePath(path.join(root, file)) &&
            entry.name === name &&
            (!kind || entry.kind === kind),
        );
      const edge = (from?: string, to?: string) => graph.edges.some((entry) => entry.from === from && entry.to === to);
      expect(node("java/client/Use.java", "Inner", "import")).toBeDefined();
      expect(node("kotlin/client/Use.kt", "Nested", "import")).toBeDefined();
      expect(edge(node("java/client/Use.java", "Inner", "import")?.id, node("java/p/C.java", "Inner")?.id)).toBe(true);
      expect(edge(node("kotlin/client/Use.kt", "Nested", "import")?.id, node("kotlin/p/Box.kt", "Nested")?.id)).toBe(
        true,
      );
      expect(edge(node("java/client/IUse.java", "Member", "import")?.id, node("java/p/I.java", "Member")?.id)).toBe(
        true,
      );
      expect(edge(node("java/client/IUse.java", "Member", "import")?.id, node("java/q/I.java", "Member")?.id)).toBe(
        false,
      );
      expect(node("java/client/Use.java", "ping", "import")).toBeUndefined();
      expect(node("java/client/Use.java", "PackageInner", "import")).toBeUndefined();
      expect(node("java/client/Use.java", "Secret", "import")).toBeUndefined();
      expect(node("kotlin/client/Use.kt", "Hidden", "import")).toBeUndefined();
      expect(node("kotlin/client/Use.kt", "run", "import")).toBeUndefined();
      const warm = await buildProjectIndex(root, { cache: "disk", native: "on" });
      const warmType = await goToDefinition(warm, {
        file: path.join(root, "java/client/Use.java"),
        line: 4,
        column: sources["java/client/Use.java"].split("\n")[3]!.indexOf("Inner") + 1,
      });
      expect(warmType.status).toBe("ok");
      if (warmType.status === "ok") expect(warmType.definition.range.start.line).toBe(3);
      const warmGraph = await buildSymbolGraphDetailed(warm);
      expect(
        warmGraph.edges.some(
          (entry) =>
            entry.from === node("java/client/Use.java", "Inner", "import")?.id &&
            entry.to === node("java/p/C.java", "Inner")?.id,
        ),
      ).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("imports Java nested enums and nested types of enums only from their declared owner", async () => {
    const root = await mkTmpDir("cg-jvm-enum-wildcard-");
    const sources = {
      "java/p/Outer.java": [
        "package p;",
        "public class Outer {",
        "  public enum Mode { FAST }",
        "}",
        "class Other { public enum Mode { SLOW } }",
      ].join("\n"),
      "java/p/OuterEnum.java": "package p; public enum OuterEnum { ONE; public static class Inner {} }",
      "java/q/Outer.java": "package q; public class Outer { public enum Mode { WRONG } }",
      "java/client/Use.java": [
        "package client;",
        "import p.Outer.*;",
        "import p.OuterEnum.*;",
        "class Use {",
        "  Mode value = Mode.FAST;",
        "  Inner inner;",
        "}",
      ].join("\n"),
    };
    try {
      for (const [name, source] of Object.entries(sources)) {
        const file = path.join(root, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, source);
      }
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      const consumer = path.join(root, "java/client/Use.java");
      const goto = async (line: number, name: string) =>
        goToDefinition(index, {
          file: consumer,
          line,
          column: sources["java/client/Use.java"].split("\n")[line - 1]!.indexOf(name) + 1,
        });
      const mode = await goto(5, "Mode");
      const inner = await goto(6, "Inner");
      expect(mode.status).toBe("ok");
      expect(inner.status).toBe("ok");
      if (mode.status === "ok") {
        expect(mode.definition.file).toBe(normalizePath(path.join(root, "java/p/Outer.java")));
        expect(mode.definition.range.start.line).toBe(3);
      }
      if (inner.status === "ok")
        expect(inner.definition.file).toBe(normalizePath(path.join(root, "java/p/OuterEnum.java")));
      const graph = await buildSymbolGraphDetailed(index);
      const node = (file: keyof typeof sources, name: string, kind?: string) =>
        [...graph.nodes.values()].find(
          (entry) =>
            entry.file === normalizePath(path.join(root, file)) &&
            entry.name === name &&
            (!kind || entry.kind === kind),
        );
      const edge = (from?: string, to?: string) => graph.edges.some((entry) => entry.from === from && entry.to === to);
      expect(
        edge(node("java/client/Use.java", "Mode", "import")?.id, node("java/p/Outer.java", "Mode", "type")?.id),
      ).toBe(true);
      expect(
        edge(node("java/client/Use.java", "Inner", "import")?.id, node("java/p/OuterEnum.java", "Inner", "class")?.id),
      ).toBe(true);
      expect(
        edge(node("java/client/Use.java", "Mode", "import")?.id, node("java/q/Outer.java", "Mode", "type")?.id),
      ).toBe(false);
      const otherModeRefs = await findReferences(index, {
        file: path.join(root, "java/p/Outer.java"),
        line: 5,
        column: sources["java/p/Outer.java"].split("\n")[4]!.indexOf("Mode") + 1,
      });
      expect(otherModeRefs.status).toBe("ok");
      if (otherModeRefs.status === "ok") {
        expect(otherModeRefs.references.some((ref) => ref.file === normalizePath(consumer))).toBe(false);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("resolves cross-language package-qualified JVM types and members without imports", async () => {
    const root = await mkTmpDir("cg-jvm-qualified-");
    const sources = {
      "java/p/JavaType.java": "package p; public class JavaType { public static int util() { return 1; } }",
      "java/q/JavaType.java": "package q; public class JavaType { public static int util() { return -1; } }",
      "java/p/Hidden.java": "package p; class Hidden { public static int util() { return 3; } }",
      "java/p/Peer.java": "package p; class Peer { p.Hidden visible; }",
      "kotlin/p/KotlinType.kt":
        "package p\nclass KotlinType { fun run(): Int = 2; private fun hidden(): Int = 3 }\nfun topLevelKotlinFun(): Int = 3",
      "kotlin/q/KotlinType.kt": "package q\nclass KotlinType { fun run(): Int = -2 }",
      "kotlin/client/Use.kt": [
        "package client",
        "fun useJava(): Int = p.JavaType.util()",
        "fun blocked(): Int = p.KotlinType().hidden()",
        "fun blockedJava(): Int = p.Hidden.util()",
        "class Use(val secret: p.Secret)",
        "fun blockedPrivate(): Int = p.Secret().run()",
      ].join("\n"),
      "kotlin/p/Secret.kt": "package p\nprivate class Secret { fun run(): Int = 4 }",
      "kotlin/p/Peer.kt": "package p\nfun peer(): Int = p.Hidden.util()",
      "java/client/Use.java": [
        "package client;",
        "class Use {",
        "  p.KotlinType value;",
        "  int call() { return new p.KotlinType().run(); }",
        "  int absent() { return p.topLevelKotlinFun(); }",
        "  p.Hidden hidden;",
        "  p.Secret secret;",
        "  int hidden() { return new p.KotlinType().hidden(); }",
        "}",
      ].join("\n"),
    };
    try {
      for (const [name, source] of Object.entries(sources)) {
        const file = path.join(root, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, source);
      }
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      const goto = async (file: keyof typeof sources, line: number, token: string) => {
        const sourceLine = sources[file].split("\n")[line - 1]!;
        return goToDefinition(index, { file: path.join(root, file), line, column: sourceLine.lastIndexOf(token) + 1 });
      };
      const javaType = await goto("kotlin/client/Use.kt", 2, "JavaType");
      const javaMember = await goto("kotlin/client/Use.kt", 2, "util");
      const kotlinType = await goto("java/client/Use.java", 3, "KotlinType");
      const constructed = await goto("java/client/Use.java", 4, "KotlinType");
      const kotlinMember = await goto("java/client/Use.java", 4, "run");
      const topLevel = await goto("java/client/Use.java", 5, "topLevelKotlinFun");
      expect(javaType.status).toBe("ok");
      expect(javaMember.status).toBe("ok");
      expect(kotlinType.status).toBe("ok");
      expect(constructed.status).toBe("ok");
      expect(kotlinMember.status).toBe("ok");
      expect(topLevel.status).toBe("not_found");
      expect((await goto("kotlin/client/Use.kt", 4, "Hidden")).status).toBe("not_found");
      expect((await goto("kotlin/client/Use.kt", 5, "Secret")).status).toBe("not_found");
      expect((await goto("java/client/Use.java", 6, "Hidden")).status).toBe("not_found");
      expect((await goto("kotlin/client/Use.kt", 6, "Secret")).status).toBe("not_found");
      expect((await goto("kotlin/client/Use.kt", 6, "run")).status).toBe("not_found");
      expect((await goto("java/client/Use.java", 7, "Secret")).status).toBe("not_found");
      expect((await goto("java/client/Use.java", 8, "hidden")).status).toBe("not_found");
      expect((await goto("kotlin/client/Use.kt", 3, "hidden")).status).toBe("not_found");
      const javaPeer = await goto("java/p/Peer.java", 1, "Hidden");
      const kotlinPeer = await goto("kotlin/p/Peer.kt", 2, "Hidden");
      expect(javaPeer.status).toBe("ok");
      expect(kotlinPeer.status).toBe("ok");
      if (javaPeer.status === "ok")
        expect(javaPeer.definition.file).toBe(normalizePath(path.join(root, "java/p/Hidden.java")));
      if (kotlinPeer.status === "ok")
        expect(kotlinPeer.definition.file).toBe(normalizePath(path.join(root, "java/p/Hidden.java")));
      const norm = (file: keyof typeof sources) => normalizePath(path.join(root, file));
      if (
        javaType.status === "ok" &&
        javaMember.status === "ok" &&
        kotlinType.status === "ok" &&
        constructed.status === "ok" &&
        kotlinMember.status === "ok"
      ) {
        expect(javaType.definition.file).toBe(norm("java/p/JavaType.java"));
        expect(javaMember.definition.file).toBe(norm("java/p/JavaType.java"));
        expect(kotlinType.definition.file).toBe(norm("kotlin/p/KotlinType.kt"));
        expect(constructed.definition.file).toBe(norm("kotlin/p/KotlinType.kt"));
        expect(kotlinMember.definition.file).toBe(norm("kotlin/p/KotlinType.kt"));
      }
      const refs = (file: keyof typeof sources, line: number, token: string) =>
        findReferences(index, {
          file: path.join(root, file),
          line,
          column: sources[file].split("\n")[line - 1]!.indexOf(token) + 1,
        });
      const javaTypeRefs = await refs("java/p/JavaType.java", 1, "JavaType");
      const javaMemberRefs = await refs("java/p/JavaType.java", 1, "util");
      const kotlinTypeRefs = await refs("kotlin/p/KotlinType.kt", 2, "KotlinType");
      const kotlinMemberRefs = await refs("kotlin/p/KotlinType.kt", 2, "run");
      const topLevelRefs = await refs("kotlin/p/KotlinType.kt", 3, "topLevelKotlinFun");
      const hiddenTypeRefs = await refs("java/p/Hidden.java", 1, "Hidden");
      const privateTypeRefs = await refs("kotlin/p/Secret.kt", 2, "Secret");
      const hiddenMemberRefs = await refs("kotlin/p/KotlinType.kt", 2, "hidden");
      for (const result of [
        javaTypeRefs,
        javaMemberRefs,
        kotlinTypeRefs,
        kotlinMemberRefs,
        topLevelRefs,
        hiddenTypeRefs,
        privateTypeRefs,
        hiddenMemberRefs,
      ]) {
        expect(result.status).toBe("ok");
      }
      if (javaTypeRefs.status === "ok") {
        expect(
          javaTypeRefs.references.some(
            (ref) => ref.file === norm("kotlin/client/Use.kt") && ref.range.start.line === 2,
          ),
        ).toBe(true);
        expect(javaTypeRefs.references.some((ref) => ref.file === norm("java/q/JavaType.java"))).toBe(false);
      }
      if (javaMemberRefs.status === "ok") {
        expect(
          javaMemberRefs.references.some(
            (ref) => ref.file === norm("kotlin/client/Use.kt") && ref.range.start.line === 2,
          ),
        ).toBe(true);
        expect(javaMemberRefs.references.some((ref) => ref.file === norm("java/q/JavaType.java"))).toBe(false);
      }
      if (kotlinTypeRefs.status === "ok") {
        expect(
          kotlinTypeRefs.references
            .filter((ref) => ref.file === norm("java/client/Use.java"))
            .map((ref) => ref.range.start.line),
        ).toEqual([3, 4, 8]);
        expect(kotlinTypeRefs.references.some((ref) => ref.file === norm("kotlin/q/KotlinType.kt"))).toBe(false);
      }
      if (kotlinMemberRefs.status === "ok") {
        expect(
          kotlinMemberRefs.references.some(
            (ref) => ref.file === norm("java/client/Use.java") && ref.range.start.line === 4,
          ),
        ).toBe(true);
        expect(kotlinMemberRefs.references.some((ref) => ref.file === norm("kotlin/q/KotlinType.kt"))).toBe(false);
      }
      if (topLevelRefs.status === "ok") {
        expect(topLevelRefs.references.some((ref) => ref.file === norm("java/client/Use.java"))).toBe(false);
      }
      if (hiddenTypeRefs.status === "ok") {
        expect(hiddenTypeRefs.references.some((ref) => ref.file === norm("java/p/Peer.java"))).toBe(true);
        expect(hiddenTypeRefs.references.some((ref) => ref.file === norm("kotlin/p/Peer.kt"))).toBe(true);
        expect(
          hiddenTypeRefs.references.some(
            (ref) => ref.file === norm("java/client/Use.java") || ref.file === norm("kotlin/client/Use.kt"),
          ),
        ).toBe(false);
      }
      if (privateTypeRefs.status === "ok") {
        expect(
          privateTypeRefs.references.some(
            (ref) => ref.file === norm("java/client/Use.java") || ref.file === norm("kotlin/client/Use.kt"),
          ),
        ).toBe(false);
      }
      if (hiddenMemberRefs.status === "ok") {
        expect(
          hiddenMemberRefs.references.some(
            (ref) => ref.file === norm("java/client/Use.java") || ref.file === norm("kotlin/client/Use.kt"),
          ),
        ).toBe(false);
      }
      const graph = await buildSymbolGraphDetailed(index);
      const nodes = [...graph.nodes.values()];
      const findNode = (file: keyof typeof sources, name: string) =>
        nodes.find((node) => node.file === norm(file) && node.name === name);
      const edge = (
        fromFile: keyof typeof sources,
        from: string,
        toFile: keyof typeof sources,
        to: string,
        kind: string,
      ) =>
        graph.edges.some(
          (candidate) =>
            candidate.from === findNode(fromFile, from)?.id &&
            candidate.to === findNode(toFile, to)?.id &&
            candidate.label === kind,
        );
      expect(findNode("java/p/JavaType.java", "util")).toBeDefined();
      expect(findNode("kotlin/p/KotlinType.kt", "run")).toBeDefined();
      expect(findNode("java/q/JavaType.java", "util")).toBeDefined();
      expect(findNode("kotlin/q/KotlinType.kt", "run")).toBeDefined();
      expect(edge("kotlin/client/Use.kt", "useJava", "java/p/JavaType.java", "util", "calls")).toBe(true);
      expect(edge("kotlin/client/Use.kt", "useJava", "java/q/JavaType.java", "util", "calls")).toBe(false);
      expect(edge("java/client/Use.java", "call", "kotlin/p/KotlinType.kt", "run", "calls")).toBe(true);
      expect(edge("java/client/Use.java", "call", "kotlin/p/KotlinType.kt", "KotlinType", "instantiates")).toBe(true);
      expect(edge("java/client/Use.java", "call", "kotlin/q/KotlinType.kt", "run", "calls")).toBe(false);
      expect(edge("java/client/Use.java", "absent", "kotlin/p/KotlinType.kt", "topLevelKotlinFun", "calls")).toBe(
        false,
      );
      expect(edge("kotlin/p/Peer.kt", "peer", "java/p/Hidden.java", "util", "calls")).toBe(true);
      expect(edge("kotlin/client/Use.kt", "blockedJava", "java/p/Hidden.java", "util", "calls")).toBe(false);
      expect(edge("kotlin/client/Use.kt", "blocked", "kotlin/p/KotlinType.kt", "hidden", "calls")).toBe(false);
      expect(edge("java/client/Use.java", "hidden", "kotlin/p/KotlinType.kt", "hidden", "calls")).toBe(false);
      expect(findNode("kotlin/p/Secret.kt", "run")).toBeDefined();
      expect(edge("kotlin/client/Use.kt", "blockedPrivate", "kotlin/p/Secret.kt", "run", "calls")).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("keeps Java package-private and Kotlin file-private types out of other packages' wildcards", async () => {
    const root = await mkTmpDir("cg-jvm-star-visibility-");
    const sources = {
      "java/p/Hidden.java": "package p; class Hidden {}",
      "java/p/Open.java": "package p; public class Open {}",
      "java/p/HiddenEnum.java": "package p; enum HiddenEnum { ALPHA }",
      "java/p/OpenEnum.java": "package p; public enum OpenEnum { ALPHA }",
      "java/q/Use.java":
        "package q; import p.*; class Use { Hidden hidden; Open open; HiddenEnum hiddenEnum; OpenEnum openEnum; }",
      "java/p/Peer.java":
        "package p; import p.*; class Peer { Hidden hidden; Open open; HiddenEnum hiddenEnum; OpenEnum openEnum; }",
      "kotlin/p/Secret.kt": "package p\nprivate class Secret\n",
      "kotlin/p/Visible.kt": "package p\nclass Visible\n",
      "kotlin/q/Use.kt": "package q\nimport p.*\nclass Use(val secret: Secret, val visible: Visible)\n",
      "kotlin/p/Peer.kt": "package p\nimport p.*\nclass Peer(val secret: Secret, val visible: Visible)\n",
    };
    try {
      for (const [name, source] of Object.entries(sources)) {
        const file = path.join(root, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, source);
      }
      const index = await buildProjectIndex(root, { cache: "disk", native: "on" });
      const graph = await buildSymbolGraphDetailed(index);
      const nodes = [...graph.nodes.values()];
      const node = (file: keyof typeof sources, name: string, kind?: string) =>
        nodes.find(
          (entry) =>
            entry.file === normalizePath(path.join(root, file)) &&
            entry.name === name &&
            (!kind || entry.kind === kind),
        );
      const edge = (from?: string, to?: string) => graph.edges.some((entry) => entry.from === from && entry.to === to);
      const goto = async (file: keyof typeof sources, line: number, token: string, projectIndex = index) => {
        const sourceLine = sources[file].split("\n")[line - 1]!;
        return await goToDefinition(projectIndex, {
          file: path.join(root, file),
          line,
          column: sourceLine.indexOf(token) + 1,
        });
      };
      const hidden = node("java/p/Hidden.java", "Hidden");
      const open = node("java/p/Open.java", "Open");
      const secret = node("kotlin/p/Secret.kt", "Secret");
      const visible = node("kotlin/p/Visible.kt", "Visible");
      expect(hidden).toBeDefined();
      expect(open).toBeDefined();
      expect(secret).toBeDefined();
      expect(visible).toBeDefined();
      expect((await goto("java/q/Use.java", 1, "Hidden")).status).toBe("not_found");
      const outsideOpen = await goto("java/q/Use.java", 1, "Open");
      expect(outsideOpen.status).toBe("ok");
      if (outsideOpen.status === "ok") expect(outsideOpen.definition.file).toBe(open?.file);
      const insideHidden = await goto("java/p/Peer.java", 1, "Hidden");
      expect(insideHidden.status).toBe("ok");
      if (insideHidden.status === "ok") expect(insideHidden.definition.file).toBe(hidden?.file);
      expect((await goto("java/q/Use.java", 1, "HiddenEnum")).status).toBe("not_found");
      const outsideOpenEnum = await goto("java/q/Use.java", 1, "OpenEnum");
      expect(outsideOpenEnum.status).toBe("ok");
      if (outsideOpenEnum.status === "ok")
        expect(outsideOpenEnum.definition.file).toBe(node("java/p/OpenEnum.java", "OpenEnum")?.file);
      expect((await goto("java/p/Peer.java", 1, "HiddenEnum")).status).toBe("ok");
      expect((await goto("kotlin/q/Use.kt", 3, "Secret")).status).toBe("not_found");
      expect((await goto("kotlin/p/Peer.kt", 3, "Secret")).status).toBe("not_found");
      const publicKotlin = await goto("kotlin/q/Use.kt", 3, "Visible");
      expect(publicKotlin.status).toBe("ok");
      if (publicKotlin.status === "ok") expect(publicKotlin.definition.file).toBe(visible?.file);
      expect(node("java/q/Use.java", "Hidden", "import")).toBeUndefined();
      expect(node("java/q/Use.java", "HiddenEnum", "import")).toBeUndefined();
      expect(node("kotlin/q/Use.kt", "Secret", "import")).toBeUndefined();
      expect(node("kotlin/p/Peer.kt", "Secret", "import")).toBeUndefined();
      expect(edge(node("java/q/Use.java", "Open", "import")?.id, open?.id)).toBe(true);
      expect(edge(node("java/p/Peer.java", "Hidden", "import")?.id, hidden?.id)).toBe(true);
      expect(
        edge(node("java/q/Use.java", "OpenEnum", "import")?.id, node("java/p/OpenEnum.java", "OpenEnum")?.id),
      ).toBe(true);
      expect(edge(node("kotlin/q/Use.kt", "Visible", "import")?.id, visible?.id)).toBe(true);
      const hiddenRefs = await findReferences(index, {
        file: path.join(root, "java/p/Hidden.java"),
        line: 1,
        column: sources["java/p/Hidden.java"].indexOf("Hidden") + 1,
      });
      expect(hiddenRefs.status).toBe("ok");
      if (hiddenRefs.status === "ok") {
        const sites = hiddenRefs.references.map((reference) => reference.file);
        expect(sites).toContain(normalizePath(path.join(root, "java/p/Peer.java")));
        expect(sites).not.toContain(normalizePath(path.join(root, "java/q/Use.java")));
      }
      const secretRefs = await findReferences(index, {
        file: path.join(root, "kotlin/p/Secret.kt"),
        line: 2,
        column: 15,
      });
      expect(secretRefs.status).toBe("ok");
      if (secretRefs.status === "ok") {
        expect(secretRefs.references.map((reference) => reference.file)).not.toContain(
          normalizePath(path.join(root, "kotlin/q/Use.kt")),
        );
      }
      const warm = await buildProjectIndex(root, { cache: "disk", native: "on" });
      expect((await goto("java/q/Use.java", 1, "Hidden", warm)).status).toBe("not_found");
      expect((await goto("java/q/Use.java", 1, "Open", warm)).status).toBe("ok");
      expect((await goto("java/p/Peer.java", 1, "Hidden", warm)).status).toBe("ok");
      expect((await goto("kotlin/q/Use.kt", 3, "Secret", warm)).status).toBe("not_found");
      expect((await goto("java/q/Use.java", 1, "HiddenEnum", warm)).status).toBe("not_found");
      expect((await goto("java/q/Use.java", 1, "OpenEnum", warm)).status).toBe("ok");
      const warmGraph = await buildSymbolGraphDetailed(warm);
      const warmNodes = [...warmGraph.nodes.values()];
      expect(
        warmNodes.some(
          (entry) =>
            entry.name === "Hidden" &&
            entry.kind === "import" &&
            entry.file === normalizePath(path.join(root, "java/q/Use.java")),
        ),
      ).toBe(false);
      expect(
        warmNodes.some(
          (entry) =>
            entry.name === "Hidden" &&
            entry.kind === "import" &&
            entry.file === normalizePath(path.join(root, "java/p/Peer.java")),
        ),
      ).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  for (const cache of ["memory", "disk"] as const) {
    it(`drops deleted non-representative Kotlin package files from warm ${cache} imports`, async () => {
      const root = await mkTmpDir("cg-jvm-wildcard-deletion-");
      try {
        const a = path.join(root, "calc/A.kt");
        const b = path.join(root, "calc/B.kt");
        const consumer = path.join(root, "app/Use.kt");
        const lines = ["package app", "import calc.*", "class Use(val keep: A, val gone: B)"];
        await fs.mkdir(path.dirname(a), { recursive: true });
        await fs.mkdir(path.dirname(consumer), { recursive: true });
        await fs.writeFile(a, "package calc\nclass A\n");
        await fs.writeFile(b, "package calc\nclass B\n");
        await fs.writeFile(consumer, lines.join("\n"));
        const lookup = (name: string) => ({ file: consumer, line: 3, column: lines[2]!.indexOf(name) + 1 });
        const bindingFiles = (index: ProjectIndex) => {
          const binding = index.byFile
            .get(fileIdentityKey(consumer))
            ?.imports.find((candidate) => candidate.kind === "star" && candidate.from === "calc");
          return binding?.kind === "star"
            ? binding.jvmPackageFiles?.map((file) => normalizePath(file)).sort()
            : undefined;
        };
        const initial = await buildProjectIndexFromFiles(root, [a, b, consumer], { cache });
        expect(bindingFiles(initial)).toEqual([normalizePath(a), normalizePath(b)]);
        expect((await goToDefinition(initial, lookup("B"))).status).toBe("ok");

        await fs.rm(b);
        const warm = await buildProjectIndexFromFiles(root, [a, consumer], { cache });
        const cold = await buildProjectIndexFromFiles(root, [a, consumer], { cache: "off" });
        expect(bindingFiles(warm)).toEqual(bindingFiles(cold));
        expect(bindingFiles(warm)).toEqual([normalizePath(a)]);
        const warmA = await goToDefinition(warm, lookup("A"));
        const coldA = await goToDefinition(cold, lookup("A"));
        const warmB = await goToDefinition(warm, lookup("B"));
        const coldB = await goToDefinition(cold, lookup("B"));
        expect(warmA.status).toBe(coldA.status);
        expect(warmB.status).toBe(coldB.status);
        expect(warmA.status).toBe("ok");
        if (warmA.status === "ok") expect(warmA.definition.file).toBe(normalizePath(a));
        expect(warmB.status).toBe("not_found");

        const importEdges = async (index: ProjectIndex) => {
          const graph = await buildSymbolGraphDetailed(index);
          return graph.edges
            .flatMap((edge) => {
              const from = graph.nodes.get(edge.from);
              const to = graph.nodes.get(edge.to);
              return from?.file === normalizePath(consumer) && from.kind === "import" && to
                ? [`${from.name}->${to.file}:${to.name}`]
                : [];
            })
            .sort();
        };
        const warmEdges = await importEdges(warm);
        expect(warmEdges).toEqual(await importEdges(cold));
        expect(warmEdges).toContain(`A->${normalizePath(a)}:A`);
        expect(warmEdges).not.toContain(`B->${normalizePath(b)}:B`);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
});
