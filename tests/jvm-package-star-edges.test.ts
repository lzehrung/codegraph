import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed } from "../src/graphs/symbol-graph-detailed.js";
import { buildProjectIndex, findReferences, goToDefinition } from "../src/index.js";
import { normalizePath } from "../src/util/paths.js";
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
});
