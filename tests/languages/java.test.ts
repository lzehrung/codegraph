import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildProjectIndex, findReferences } from "../../src/index.js";
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
