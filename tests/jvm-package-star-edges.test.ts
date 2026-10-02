import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed } from "../src/graphs/symbol-graph-detailed.js";
import { buildProjectIndex, goToDefinition } from "../src/index.js";
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
});
