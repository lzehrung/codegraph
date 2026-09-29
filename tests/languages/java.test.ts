import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildProjectIndex, findReferences, goToDefinition } from "../../src/index.js";
import { buildSymbolGraphDetailed } from "../../src/graphs/symbol-graph-detailed.js";
import { normalizePath } from "../../src/util/paths.js";
import { columnOf, writeFixtureFiles } from "./callable-consumer-fixtures.js";
import type { SyntaxNodeLike } from "../../src/languages/types.js";

function findFirstNodeByType(root: SyntaxNodeLike, type: string): SyntaxNodeLike | null {
  if (root.type === type) return root;
  for (const child of root.namedChildren) {
    const found = findFirstNodeByType(child, type);
    if (found) return found;
  }
  return null;
}
import { appendImplicitImportBinding } from "../../src/indexer/imports/language-specific.js";
import type { ImportBinding } from "../../src/indexer/types.js";
import { collectLocalsAndExportsFromSource, parseFile } from "../../src/indexer.js";
import { exportedNameOf } from "../helpers/narrow.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { expectUnicodeSymbolRangeIdentity } from "./unicode-symbol-range.js";

const definition: LanguageTestDefinition = {
  id: "java",
  samples: [
    {
      name: "chunks Java structures",
      sourceFile: "java.sample.java",
      exactChunks: [
        { type: "misc", startLine: 1, endLine: 4 },
        { type: "class", name: "MyClass", startLine: 5, endLine: 15 },
        { type: "method", name: "MyClass", startLine: 8, endLine: 10 },
        { type: "method", name: "myMethod", startLine: 12, endLine: 14 },
        { type: "misc", startLine: 15, endLine: 16 },
        { type: "interface", name: "MyInterface", startLine: 17, endLine: 19 },
        { type: "method", name: "interfaceMethod", startLine: 18, endLine: 18 },
        { type: "misc", startLine: 19, endLine: 20 },
        { type: "enum", name: "MyEnum", startLine: 21, endLine: 25 },
      ],
    },
  ],
  parity: {
    sampleDir: "java",
    exact: {
      dependencyGraph: [
        {
          from: "AnnotationConsumer.java",
          to: { type: "file", path: "AnnotationTypes.java" },
        },
        {
          from: "static-imports.java",
          to: { type: "file", path: "utils/Utils.java" },
        },
        {
          from: "static-imports.java",
          to: { type: "file", path: "helpers/Helpers.java" },
        },
        {
          from: "WildcardImports.java",
          to: { type: "file", path: "pkg/Mode.java" },
        },
        {
          from: "WildcardImports.java",
          to: { type: "file", path: "pkg/PackageService.java" },
        },
        {
          from: "WildcardImports.java",
          to: { type: "file", path: "pkg/PackageTypes.java" },
        },
        {
          from: "WildcardImports.java",
          to: { type: "file", path: "pkg/ScopedEnums.java" },
        },
        {
          from: "StaticWildcardImports.java",
          to: { type: "file", path: "utils/Utils.java" },
        },
        {
          from: "EnumMemberAccess.java",
          to: { type: "file", path: "pkg/ScopedEnums.java" },
        },
        {
          from: ".regressions/unicode_consumer.java",
          to: { type: "file", path: ".regressions/unicode_def.java" },
        },
        {
          from: "ResolutionImports.java",
          to: { type: "file", path: "demo/Point.java" },
        },
        {
          from: "ResolutionImports.java",
          to: { type: "external", name: "demo.Missing" },
        },
      ],
      symbols: [
        {
          file: "NestedTypes.java",
          symbols: [
            { name: "NestedTypes", kind: "class" },
            { name: "InnerHelper", kind: "class" },
            { name: "run", kind: "function" },
            { name: "Contract", kind: "interface" },
            { name: "execute", kind: "function" },
          ],
        },
        {
          file: "utils/Utils.java",
          symbols: [
            { name: "Utils", kind: "class" },
            { name: "helperFunction", kind: "function" },
            { name: "UtilityClass", kind: "class" },
          ],
        },
        {
          file: "pkg/PackageTypes.java",
          symbols: [
            { name: "PackageTypes", kind: "class" },
            { name: "NestedValue", kind: "class" },
            { name: "ServiceContract", kind: "interface" },
            { name: "serve", kind: "function" },
          ],
        },
        {
          file: "pkg/Mode.java",
          symbols: [
            { name: "Mode", kind: "type" },
            { name: "FAST", kind: "variable" },
            { name: "SLOW", kind: "variable" },
          ],
        },
        {
          file: "pkg/PackageService.java",
          symbols: [
            { name: "PackageService", kind: "interface" },
            { name: "serve", kind: "function" },
          ],
        },
        {
          file: "pkg/ScopedEnums.java",
          symbols: [
            { name: "ScopedEnums", kind: "class" },
            { name: "PrimaryMode", kind: "type" },
            { name: "Ready", kind: "variable" },
            { name: "shadow", kind: "function" },
            { name: "SecondaryMode", kind: "variable" },
            { name: "Missing", kind: "variable" },
            { name: "nested", kind: "variable" },
            { name: "Missing", kind: "variable" },
            { name: "SecondaryMode", kind: "type" },
            { name: "Ready", kind: "variable" },
          ],
        },
        {
          file: "RecordTypes.java",
          symbols: [
            { name: "Sized", kind: "interface" },
            { name: "size", kind: "function" },
            { name: "Point", kind: "class" },
            { name: "x", kind: "variable" },
            { name: "y", kind: "variable" },
            { name: "sum", kind: "function" },
            { name: "NamedShape", kind: "class" },
            { name: "size", kind: "variable" },
            { name: "size", kind: "function" },
          ],
        },
        {
          file: "AnnotationTypes.java",
          symbols: [{ name: "AnnotatedMarker", kind: "interface" }],
        },
      ],
      references: [
        {
          name: "find references for imported annotation types",
          file: "AnnotationTypes.java",
          line: 3,
          column: 19,
          references: [
            { file: "AnnotationTypes.java", line: 3 },
            { file: "AnnotationConsumer.java", line: 3 },
            { file: "AnnotationConsumer.java", line: 5 },
          ],
        },
        {
          name: "find references for wildcard-imported interface",
          file: "pkg/PackageTypes.java",
          line: 7,
          column: 11,
          references: [
            { file: "pkg/PackageTypes.java", line: 7 },
            { file: "WildcardImports.java", line: 7 },
          ],
        },
        {
          name: "find references for wildcard-imported package interfaces across files",
          file: "pkg/PackageService.java",
          line: 3,
          column: 18,
          references: [
            { file: "pkg/PackageService.java", line: 3 },
            { file: "WildcardImports.java", line: 8 },
          ],
        },
        {
          name: "find references for static wildcard-imported methods",
          file: "utils/Utils.java",
          line: 4,
          column: 22,
          references: [
            { file: "utils/Utils.java", line: 4 },
            { file: "static-imports.java", line: 3 },
            { file: "static-imports.java", line: 8 },
            { file: "StaticWildcardImports.java", line: 7 },
          ],
        },
        {
          name: "finds Java record references without binding missing imports",
          file: "demo/Point.java",
          line: 3,
          column: 15,
          references: [
            { file: "demo/Point.java", line: 3 },
            { file: "ResolutionImports.java", line: 2 },
            { file: "ResolutionImports.java", line: 5 },
          ],
        },
      ],
    },
    absentDependencyGraph: [
      {
        from: "ResolutionImports.java",
        to: { type: "file", path: "demo/A.java" },
      },
    ],
    goToDefinition: [
      {
        name: "go to definition resolves imported annotation types",
        file: "AnnotationConsumer.java",
        line: 5,
        column: 2,
        expectedDefinition: { file: "AnnotationTypes.java", line: 3 },
      },
      {
        name: "go to definition resolves wildcard-imported nested type",
        file: "WildcardImports.java",
        line: 6,
        column: 16,
        expectedDefinition: { file: "pkg/PackageTypes.java", line: 4 },
      },
      {
        name: "go to definition resolves wildcard-imported package interfaces across files",
        file: "WildcardImports.java",
        line: 8,
        column: 3,
        expectedDefinition: { file: "pkg/PackageService.java", line: 3 },
      },
      {
        name: "go to definition resolves wildcard-imported enum type",
        file: "WildcardImports.java",
        line: 9,
        column: 3,
        expectedDefinition: { file: "pkg/Mode.java", line: 3 },
      },
      {
        name: "go to definition resolves wildcard-imported enum constants",
        file: "WildcardImports.java",
        line: 9,
        column: 20,
        expectedDefinition: { file: "pkg/Mode.java", line: 4 },
      },
      {
        name: "go to definition resolves enum constants by owner",
        file: "EnumMemberAccess.java",
        line: 6,
        column: 62,
        expectedDefinition: { file: "pkg/ScopedEnums.java", line: 18 },
      },
      {
        name: "go to definition ignores nested locals for missing Java owner members",
        file: "EnumMemberAccess.java",
        line: 7,
        column: 32,
        expectedStatus: "not_found",
      },
      {
        name: "go to definition resolves static wildcard imports",
        file: "StaticWildcardImports.java",
        line: 7,
        column: 5,
        expectedDefinition: { file: "utils/Utils.java", line: 4 },
      },
      {
        name: "go to definition resolves imported Java records exactly",
        file: "ResolutionImports.java",
        line: 5,
        column: 3,
        expectedDefinition: { file: "demo/Point.java", line: 3 },
      },
    ],
  },
};

runLanguageTests(definition);

describe("Java formal parameters", () => {
  it("indexes method, constructor, spread, and record parameters as locals", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-java-formals-"));
    const file = path.join(root, "Params.java");
    const source = `class Params {
  void method(int a, String... rest) {}
  Params(int seed) {}
}

record Point(int x, int y) {}
`;
    try {
      await writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const mod = [...index.byFile.values()][0]!;
      const locals = mod.locals.map((local) => `${local.kind}:${local.localName}`);
      expect(locals).toEqual(
        expect.arrayContaining([
          "class:Params",
          "function:method",
          "variable:a",
          "variable:rest",
          "variable:seed",
          "class:Point",
          "variable:x",
          "variable:y",
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Java export scope blockers", () => {
  it("does not export members of method, constructor, or lambda-local classes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-java-local-class-"));
    const file = path.join(root, "Scope.java");
    const source = `class Keep {
  void keep() {}
  Keep() {
    class CtorLocal { void ctorHidden() {} }
  }
  void outer() {
    class Local { void hidden() {} }
    Runnable r = () -> { class LambdaLocal { void hidden2() {} } };
  }
  class Inner { void deep() {} }
}
`;
    try {
      await writeFile(file, source, "utf8");
      const parsed = await parseFile(file);
      const mod = collectLocalsAndExportsFromSource(file, parsed.source, parsed.sup, [], {
        ...(parsed.nativeQueries === undefined ? {} : { nativeQueries: parsed.nativeQueries }),
      });
      const localNames = mod.locals.map((entry) => entry.localName);
      const exportedNames = mod.exports.map(exportedNameOf);
      expect(localNames).toEqual(
        expect.arrayContaining([
          "Keep",
          "keep",
          "CtorLocal",
          "ctorHidden",
          "Local",
          "hidden",
          "LambdaLocal",
          "hidden2",
          "Inner",
          "deep",
        ]),
      );
      expect(exportedNames).toEqual(expect.arrayContaining(["Keep", "keep", "outer", "Inner", "deep"]));
      expect(exportedNames).not.toContain("CtorLocal");
      expect(exportedNames).not.toContain("ctorHidden");
      expect(exportedNames).not.toContain("Local");
      expect(exportedNames).not.toContain("hidden");
      expect(exportedNames).not.toContain("LambdaLocal");
      expect(exportedNames).not.toContain("hidden2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Java Unicode symbol ranges (C11)", () => {
  it("publishes a UTF-16 string index for a method name preceded by multibyte text", async () => {
    await expectUnicodeSymbolRangeIdentity({
      fileName: "Widget.java",
      source: "// café ☕ prüfung\n/* über */ public class Widget {\n\tpublic int créer() {\n\t\treturn 1;\n\t}\n}\n",
      symbolName: "créer",
    });
  });
});

describe("Java lowercase class import bindings", () => {
  it("creates a named implicit binding for a lowercase class segment and keeps star imports", () => {
    const bindings: ImportBinding[] = [];
    const context = {
      file: "Consumer.java",
      projectRoot: process.cwd(),
      source: "import com.example.myClass;",
      languageId: "java",
      resolveFrom: async (from: string) => ({ external: from }),
      pushBinding: (binding: ImportBinding) => {
        bindings.push(binding);
      },
      getBindings: () => bindings,
      replaceBindings: (next: ImportBinding[]) => {
        bindings.splice(0, bindings.length, ...next);
      },
    };

    appendImplicitImportBinding(context, {
      from: "com.example.myClass",
      resolved: { external: "com.example.myClass" },
      typeOnly: false,
      stmtText: "import com.example.myClass;",
    });
    appendImplicitImportBinding(context, {
      from: "com.example.*",
      resolved: { external: "com.example.*" },
      typeOnly: false,
      stmtText: "import com.example.*;",
    });

    expect(bindings).toEqual([
      {
        kind: "named",
        local: "myClass",
        imported: "myClass",
        from: "com.example.myClass",
        resolved: { external: "com.example.myClass" },
        typeOnly: false,
      },
      {
        kind: "star",
        from: "com.example.*",
        resolved: { external: "com.example.*" },
        typeOnly: false,
      },
    ]);
  });
});

describe("Java same-package sibling classes", () => {
  // #378: same-package classes have implicit visibility in Java, so a sibling class used as a
  // return type and constructed with `new` must resolve and be referenced without any import,
  // while a same-named class in another package must stay out of both results.
  const targetLines = ["package p;", "", "public class Target {}"];
  const useLines = [
    "/*",
    "package q;",
    "*/",
    "package p;",
    "",
    "class Use {",
    "  Target make() {",
    "    return new Target();",
    "  }",
    "}",
  ];
  const decoyTargetLines = ["package q;", "", "public class Target {}"];
  const decoyUseLines = [
    "package q;",
    "",
    "class UseDecoy {",
    "  Target make() {",
    "    return new Target();",
    "  }",
    "}",
  ];

  it("resolves sibling return types and constructors and excludes the other package", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-java-package-peer-"));
    try {
      const paths = await writeFixtureFiles(root, {
        "p/Target.java": `${targetLines.join("\n")}\n`,
        "p/Use.java": `${useLines.join("\n")}\n`,
        "q/Target.java": `${decoyTargetLines.join("\n")}\n`,
        "q/UseDecoy.java": `${decoyUseLines.join("\n")}\n`,
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const targetPath = paths["p/Target.java"]!;
      const usePath = paths["p/Use.java"]!;
      const decoyPath = paths["q/Target.java"]!;

      for (const [line, token] of [
        [7, "Target"],
        [8, "Target"],
      ] as const) {
        const goto = await goToDefinition(index, {
          file: usePath,
          line,
          column: columnOf(useLines, line, token),
        });
        expect(goto.status, `Use.java:${line} must resolve`).toBe("ok");
        if (goto.status !== "ok") throw new Error("Expected the same-package class declaration");
        expect(normalizePath(goto.definition.file)).toBe(targetPath);
        expect(goto.definition.range.start.line).toBe(3);
      }

      const references = await findReferences(index, {
        file: targetPath,
        line: 3,
        column: columnOf(targetLines, 3, "Target"),
      });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected same-package class references");
      const sites = references.references.map(
        (reference) => `${normalizePath(reference.file)}:${reference.range.start.line}`,
      );
      expect(sites).toContain(`${usePath}:7`);
      expect(sites).toContain(`${usePath}:8`);
      expect(references.references.some((reference) => normalizePath(reference.file) === decoyPath)).toBe(false);

      const decoyReferences = await findReferences(index, {
        file: decoyPath,
        line: 3,
        column: columnOf(decoyTargetLines, 3, "Target"),
      });
      expect(decoyReferences.status).toBe("ok");
      if (decoyReferences.status !== "ok") throw new Error("Expected decoy package references");
      expect(decoyReferences.references.some((reference) => normalizePath(reference.file) === usePath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Java constructor and spread-parameter declaration names", () => {
  it("does not count a constructor declaration name as a reference to the class", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-java-constructor-name-"));
    const file = path.join(root, "Probe.java");
    const source = ["class A {", "  A(int x) {}", "  void call() { new A(1); }", "}", ""].join("\n");
    try {
      await writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root);
      const refs = await findReferences(index, { file, line: 1, column: 7 });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        const lines = refs.references.map((reference) => reference.range.start.line);
        // The constructor declaration name on line 2 is a declaration, not a use of `A`.
        expect(lines).not.toContain(2);
        expect(lines).toContain(3);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recognizes a spread parameter's declared name as a declaration name", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-java-spread-param-"));
    const file = path.join(root, "Spread.java");
    try {
      await writeFile(file, "class Spread { void m(int... rest) { } }\n", "utf8");
      const parsed = await parseFile(file);
      const spread = findFirstNodeByType(parsed.tree.rootNode, "spread_parameter");
      if (!spread) throw new Error("spread_parameter node not found");
      const declarator = spread.namedChildren.find((child) => child.type === "variable_declarator");
      expect(declarator).toBeDefined();
      // The `variable_declarator` under `spread_parameter` (`int... rest`) is a declared
      // name, so impact classification treats edits to it as a definition change.
      expect(parsed.sup.isDeclarationName(declarator!)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Java implicit-receiver precedence", () => {
  it("lets inherited, non-private methods shadow a static import across goto, references, and calls", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-java-inherited-member-"));
    try {
      const lines = [
        "package j;",
        "",
        "import static j.Util.hit;",
        "import static j.Util.hidden;",
        "",
        "class Derived extends Base {",
        "  int viaBase() { return hit(); }",
        "  static int fromStatic() { return hit(); }",
        "  int privateBase() { return hidden(); }",
        "}",
        "",
        "class Plain {",
        "  int imported() { return hit(); }",
        "}",
        "",
      ];
      const use = normalizePath(path.join(root, "Use.java"));
      const base = normalizePath(path.join(root, "Base.java"));
      const util = normalizePath(path.join(root, "Util.java"));
      await writeFile(use, lines.join("\n"));
      await writeFile(
        base,
        "package j;\n\nclass Base {\n  int hit() { return 4; }\n  private int hidden() { return 5; }\n}\n",
      );
      await writeFile(
        util,
        "package j;\n\nclass Util {\n  static int hit() { return 1; }\n  static int hidden() { return 2; }\n}\n",
      );
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      const gotoLine = async (line: number, name: string) => {
        const result = await goToDefinition(index, { file: use, line, column: lines[line - 1]!.lastIndexOf(name) + 1 });
        return result.status === "ok"
          ? `${path.basename(result.definition.file)}:${result.definition.range.start.line}`
          : null;
      };
      // The inherited method shadows the static import inside the subclass, even in a static
      // method, where the call is then invalid. A private base method is not inherited.
      expect(await gotoLine(7, "hit")).toBe("Base.java:4");
      expect(await gotoLine(8, "hit")).toBeNull();
      expect(await gotoLine(9, "hidden")).toBe("Util.java:5");
      expect(await gotoLine(13, "hit")).toBe("Util.java:4");
      const lineOf = async (file: string, line: number, column: number) => {
        const result = await findReferences(index, { file, line, column });
        if (result.status !== "ok") throw new Error("Expected references");
        return result.references
          .filter((reference) => normalizePath(reference.file) === use)
          .map((reference) => reference.range.start.line)
          .sort((a, b) => a - b);
      };
      expect(await lineOf(base, 4, "  int hit".length - 2)).toEqual([7]);
      expect(await lineOf(util, 4, "  static int hit".length - 2)).toEqual([3, 13]);
      const graph = await buildSymbolGraphDetailed(index);
      const calls = graph.edges
        .filter((edge) => edge.label === "calls")
        .map((edge) => `${graph.nodes.get(edge.from)?.name}->${path.basename(graph.nodes.get(edge.to)?.file ?? "")}`)
        .sort();
      expect(calls).toEqual(["imported->Util.java", "privateBase->Util.java", "viaBase->Base.java"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies static scope and overload arity to receiverless calls of the class's own methods", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-java-own-member-"));
    try {
      const lines = [
        "package j;",
        "",
        "class C {",
        "  void hit() {}",
        "  int pick(int a) { return a; }",
        "  int pick(int a, int b) { return a + b; }",
        "  static void run() { hit(); }",
        "  int two() { return pick(1, 2); }",
        "}",
        "",
      ];
      const file = normalizePath(path.join(root, "C.java"));
      await writeFile(file, lines.join("\n"));
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      const gotoLine = async (line: number, name: string) => {
        const result = await goToDefinition(index, { file, line, column: lines[line - 1]!.lastIndexOf(name) + 1 });
        return result.status === "ok" ? result.definition.range.start.line : null;
      };
      // An instance method is not callable without `this` from a static method; overloads are
      // chosen by argument count.
      expect(await gotoLine(7, "hit")).toBeNull();
      expect(await gotoLine(8, "pick")).toBe(6);
      const graph = await buildSymbolGraphDetailed(index);
      const calls = graph.edges
        .filter((edge) => edge.label === "calls")
        .map(
          (edge) =>
            `${graph.nodes.get(edge.from)?.name}->${graph.nodes.get(edge.to)?.name}:${edge.site?.range.start.line}`,
        );
      expect(calls).toEqual(["two->pick:8"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("finds an arity-compatible overload in a deeper ancestor before a static import", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-java-deep-overload-"));
    try {
      await writeFile(
        path.join(root, "GrandBase.java"),
        "package j;\nclass GrandBase { int hit(int a) { return a; } }\n",
      );
      await writeFile(
        path.join(root, "Base.java"),
        "package j;\nclass Base extends GrandBase { int hit() { return 0; } }\n",
      );
      await writeFile(
        path.join(root, "Util.java"),
        "package j;\nclass Util { static int hit(int a) { return -a; } }\n",
      );
      const lines = [
        "package j;",
        "",
        "import static j.Util.hit;",
        "",
        "class Derived extends Base {",
        "  int one() { return hit(1); }",
        "}",
        "",
      ];
      const use = normalizePath(path.join(root, "Use.java"));
      await writeFile(use, lines.join("\n"));
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      // Base.hit() cannot take one argument; overloads span the hierarchy, so GrandBase.hit(int) wins.
      const goto = await goToDefinition(index, { file: use, line: 6, column: lines[5]!.indexOf("hit") + 1 });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") expect(path.basename(goto.definition.file)).toBe("GrandBase.java");
      const graph = await buildSymbolGraphDetailed(index);
      const targets = graph.edges
        .filter((edge) => edge.label === "calls")
        .map((edge) => path.basename(graph.nodes.get(edge.to)?.file ?? ""));
      expect(targets).toEqual(["GrandBase.java"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats same-arity inherited overloads as ambiguous and skips a private middle declaration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-java-overload-ambiguity-"));
    try {
      await mkdir(path.join(root, "a"), { recursive: true });
      await mkdir(path.join(root, "b"), { recursive: true });
      const files: Record<string, string> = {
        "a/GrandBase.java": "package a;\nclass GrandBase { int hit(int a) { return a; } }\n",
        "a/Base.java": "package a;\nclass Base extends GrandBase { int hit(String s) { return 0; } }\n",
        "a/Util.java": "package a;\nclass Util { static int hit(int a) { return -a; } }\n",
        "a/Use.java":
          "package a;\n\nimport static a.Util.hit;\n\nclass Derived extends Base {\n  int one() { return hit(1); }\n}\n",
        "b/GrandBase.java": "package b;\nclass GrandBase { int go() { return 1; } }\n",
        "b/Base.java": "package b;\nclass Base extends GrandBase { private int go() { return 2; } }\n",
        "b/Util.java": "package b;\nclass Util { static int go() { return 3; } }\n",
        "b/Use.java":
          "package b;\n\nimport static b.Util.go;\n\nclass Derived extends Base {\n  int use() { return go(); }\n}\n",
      };
      for (const [relative, text] of Object.entries(files)) await writeFile(path.join(root, relative), text);
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      const gotoAt = async (relative: string, name: string) => {
        const file = normalizePath(path.join(root, relative));
        const line = files[relative]!.split("\n")[5]!;
        const result = await goToDefinition(index, { file, line: 6, column: line.lastIndexOf(name) + 1 });
        return result.status === "ok" ? relative.split("/")[0] + "/" + path.basename(result.definition.file) : null;
      };
      // hit(String) and hit(int) both take one argument: no type ranking, so no target and no
      // fallback to the static import. A private Base.go() is not inherited, so GrandBase.go() wins.
      expect(await gotoAt("a/Use.java", "hit")).toBeNull();
      expect(await gotoAt("b/Use.java", "go")).toBe("b/GrandBase.java");
      const graph = await buildSymbolGraphDetailed(index);
      const calls = graph.edges
        .filter((edge) => edge.label === "calls")
        .map((edge) => `${graph.nodes.get(edge.from)?.name}->${path.basename(graph.nodes.get(edge.to)?.file ?? "")}`);
      expect(calls).toEqual(["use->GrandBase.java"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps same-signature defaults from unrelated interfaces ambiguous but collapses a proven override", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-java-interface-ambiguity-"));
    try {
      const files: Record<string, string> = {
        "Left.java": "package j;\ninterface Left { default int hit(int a) { return 1; } }\n",
        "Right.java": "package j;\ninterface Right { default int hit(int a) { return 2; } }\n",
        "Base.java": "package j;\nclass Base { int go(int a) { return 1; } }\n",
        "Mid.java": "package j;\nclass Mid extends Base { int go(int a) { return 2; } }\n",
        "Use.java":
          "package j;\nclass Both implements Left, Right {\n  int use() { return hit(1); }\n}\nclass Leaf extends Mid {\n  int use() { return go(1); }\n}\n",
      };
      for (const [relative, text] of Object.entries(files)) await writeFile(path.join(root, relative), text);
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      const use = normalizePath(path.join(root, "Use.java"));
      const useLines = files["Use.java"]!.split("\n");
      const gotoAt = async (line: number, name: string) => {
        const result = await goToDefinition(index, {
          file: use,
          line,
          column: useLines[line - 1]!.lastIndexOf(name) + 1,
        });
        return result.status === "ok" ? path.basename(result.definition.file) : null;
      };
      // Left.hit and Right.hit are unrelated; Mid.go overrides Base.go on the walked path.
      expect(await gotoAt(3, "hit")).toBeNull();
      expect(await gotoAt(6, "go")).toBe("Mid.java");
      const graph = await buildSymbolGraphDetailed(index);
      const calls = graph.edges
        .filter((edge) => edge.label === "calls")
        .map((edge) => path.basename(graph.nodes.get(edge.to)?.file ?? ""));
      expect(calls).toEqual(["Mid.java"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a static import hidden in a static method when inherited instance overloads are ambiguous or inapplicable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-java-static-hidden-"));
    try {
      const files: Record<string, string> = {
        "Base.java":
          "package j;\nclass Base { int hit(int a) { return a; } int hit(String s) { return 0; } int go(int a, int b) { return a; } }\n",
        "Util.java":
          "package j;\nclass Util { static int hit(int a) { return -a; } static int go(int a) { return a; } }\n",
        "Use.java":
          "package j;\n\nimport static j.Util.hit;\nimport static j.Util.go;\n\nclass Derived extends Base {\n  static int s1() { return hit(1); }\n  static int s2() { return go(1); }\n}\n",
      };
      for (const [relative, text] of Object.entries(files)) await writeFile(path.join(root, relative), text);
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      const use = normalizePath(path.join(root, "Use.java"));
      const useLines = files["Use.java"]!.split("\n");
      for (const [line, name] of [
        [7, "hit"],
        [8, "go"],
      ] as const) {
        const result = await goToDefinition(index, {
          file: use,
          line,
          column: useLines[line - 1]!.lastIndexOf(name) + 1,
        });
        expect(result.status).toBe("not_found");
      }
      const graph = await buildSymbolGraphDetailed(index);
      expect(graph.edges.filter((edge) => edge.label === "calls")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat same-spelled parameter types from different imports as an override", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-java-override-identity-"));
    try {
      await mkdir(path.join(root, "a"), { recursive: true });
      await mkdir(path.join(root, "b"), { recursive: true });
      await writeFile(path.join(root, "a", "Foo.java"), "package j.a;\npublic class Foo {}\n");
      await writeFile(path.join(root, "b", "Foo.java"), "package j.b;\npublic class Foo {}\n");
      await writeFile(
        path.join(root, "Base.java"),
        "package j;\nimport j.a.Foo;\nclass Base { int hit(Foo f) { return 1; } }\n",
      );
      const lines = [
        "package j;",
        "import j.b.Foo;",
        "class Derived extends Base {",
        "  int hit(Foo f) { return 2; }",
        "  int use(Foo f) { return hit(f); }",
        "}",
        "",
      ];
      const derived = normalizePath(path.join(root, "Derived.java"));
      await writeFile(derived, lines.join("\n"));
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      // Base.hit(j.a.Foo) and Derived.hit(j.b.Foo) are distinct overloads of one arity.
      const goto = await goToDefinition(index, { file: derived, line: 5, column: lines[4]!.lastIndexOf("hit") + 1 });
      expect(goto.status).toBe("not_found");
      const graph = await buildSymbolGraphDetailed(index);
      expect(graph.edges.filter((edge) => edge.label === "calls")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a fixed-arity and a varargs inherited overload of one count ambiguous", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-java-varargs-ambiguity-"));
    try {
      await writeFile(
        path.join(root, "GrandBase.java"),
        "package j;\nclass GrandBase { int hit(int... xs) { return 1; } }\n",
      );
      await writeFile(
        path.join(root, "Base.java"),
        "package j;\nclass Base extends GrandBase { int hit(String s) { return 2; } }\n",
      );
      const lines = ["package j;", "class Derived extends Base {", "  int one() { return hit(1); }", "}", ""];
      const use = normalizePath(path.join(root, "Derived.java"));
      await writeFile(use, lines.join("\n"));
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      // hit(1) calls hit(int...) in Java, but only argument types prove it: no confident target.
      const goto = await goToDefinition(index, { file: use, line: 3, column: lines[2]!.indexOf("hit") + 1 });
      expect(goto.status).toBe("not_found");
      const graph = await buildSymbolGraphDetailed(index);
      expect(graph.edges.filter((edge) => edge.label === "calls")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("calls a method past a same-named local variable, and keeps generic parameters from proving an override", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-java-namespaces-generics-"));
    try {
      const cLines = [
        "package j;",
        "class C {",
        "  int hit() { return 1; }",
        "  int use() { int hit = 0; return hit() + hit; }",
        "}",
        "",
      ];
      const c = normalizePath(path.join(root, "C.java"));
      await writeFile(c, cLines.join("\n"));
      await writeFile(path.join(root, "Base.java"), "package j;\nclass Base<T> { int go(T t) { return 1; } }\n");
      const dLines = [
        "package j;",
        "class Derived<T> extends Base<String> {",
        "  int go(T t) { return 2; }",
        "  int use(T t) { return go(t); }",
        "}",
        "",
      ];
      const derived = normalizePath(path.join(root, "Derived.java"));
      await writeFile(derived, dLines.join("\n"));
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      // Java methods and variables are separate namespaces.
      const call = await goToDefinition(index, { file: c, line: 4, column: cLines[3]!.indexOf("hit()") + 1 });
      expect(call.status === "ok" ? call.definition.range.start.line : null).toBe(3);
      const variable = await goToDefinition(index, { file: c, line: 4, column: cLines[3]!.lastIndexOf("hit") + 1 });
      expect(variable.status === "ok" ? variable.definition.range.start.line : null).toBe(4);
      // Derived.go(T) and Base<String>.go(T) are distinct after substitution: no confident target.
      const generic = await goToDefinition(index, { file: derived, line: 4, column: dLines[3]!.indexOf("go(") + 1 });
      expect(generic.status).toBe("not_found");
      const graph = await buildSymbolGraphDetailed(index);
      const calls = graph.edges
        .filter((edge) => edge.label === "calls")
        .map((edge) => `${path.basename(graph.nodes.get(edge.from)?.file ?? "")}:${graph.nodes.get(edge.to)?.name}`);
      expect(calls).toEqual(["C.java:hit"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Java type-qualified overloads", () => {
  it("resolves Type.method(args) and each overload's own declaration to that overload", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-java-qualified-overload-"));
    try {
      const utilLines = [
        "package p;",
        "public class Util {",
        "  public static int two(int a) { return a; }",
        "  public static int two(int a, int b) { return a + b; }",
        "}",
        "",
      ];
      const useLines = [
        "package q;",
        "import p.Util;",
        "class Use {",
        "  int b() { return Util.two(1); }",
        "  int c() { return Util.two(1, 2); }",
        "}",
        "",
      ];
      await mkdir(path.join(root, "p"), { recursive: true });
      await mkdir(path.join(root, "q"), { recursive: true });
      const util = normalizePath(path.join(root, "p", "Util.java"));
      const use = normalizePath(path.join(root, "q", "Use.java"));
      await writeFile(util, utilLines.join("\n"));
      await writeFile(use, useLines.join("\n"));
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      const gotoLine = async (file: string, lines: string[], line: number) => {
        const column = lines[line - 1]!.indexOf("two") + 1;
        const result = await goToDefinition(index, { file, line, column });
        return result.status === "ok" ? result.definition.range.start.line : null;
      };
      expect(await gotoLine(use, useLines, 4)).toBe(3);
      expect(await gotoLine(use, useLines, 5)).toBe(4);
      expect(await gotoLine(util, utilLines, 3)).toBe(3);
      expect(await gotoLine(util, utilLines, 4)).toBe(4);

      const referenceLines = async (line: number) => {
        const result = await findReferences(index, {
          file: util,
          line,
          column: utilLines[line - 1]!.indexOf("two") + 1,
        });
        if (result.status !== "ok") throw new Error("Expected references");
        return result.references.map((reference) => `${path.basename(reference.file)}:${reference.range.start.line}`);
      };
      expect((await referenceLines(3)).sort()).toEqual(["Use.java:4", "Util.java:3"]);
      expect((await referenceLines(4)).sort()).toEqual(["Use.java:5", "Util.java:4"]);

      const graph = await buildSymbolGraphDetailed(index);
      const utilSource = utilLines.join("\n");
      const targets = graph.edges
        .filter((edge) => edge.label === "calls" && edge.from.startsWith(use))
        .map((edge) => `${graph.nodes.get(edge.from)?.name}->${Number(edge.to.slice(edge.to.lastIndexOf("::") + 2))}`)
        .sort();
      expect(targets).toEqual([
        `b->${utilSource.indexOf("two(int a)")}`,
        `c->${utilSource.indexOf("two(int a, int b)")}`,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
