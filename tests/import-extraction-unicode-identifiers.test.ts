import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseCsharpUsingDirective,
  parseJavaImportStatement,
  parseKotlinImportStatement,
  parsePhpImportStatement,
  parseRustImportStatement,
} from "../src/languages/importStatementParsers.js";
import { extractJsTsSpecifiers, extractPythonSpecifiers } from "../src/util.js";
import { collectModuleSpecifiersFromSource } from "../src/graphs.js";
import { supportById } from "../src/languages.js";
import { buildProjectIndex } from "../src/index.js";
import { collectJsTextImports } from "../src/indexer/imports/jsTextImports.js";
import { collectNativeCaptureImportBindings } from "../src/indexer/imports/nativeCaptures.js";
import { finalizeLanguageSpecificImports } from "../src/indexer/imports/languageSpecific.js";
import { collectPythonImportsFromSource } from "../src/indexer/imports/python.js";
import type { ImportBinding } from "../src/indexer/types.js";
import type { NativeMatch } from "../src/native/treeSitterNative.js";

// C11-adjacent finding: several import/alias extractors used an ASCII-only [A-Za-z_][\w]*
// character class, which silently drops the binding (or the whole statement) for any
// non-ASCII identifier even though the source language's real grammar permits Unicode
// identifiers (Rust XID_Start/XID_Continue, PHP high-byte identifiers, JVM/C# Unicode
// letters, Go's Unicode "letter" production, JS/TS ID_Start/ID_Continue, PEP 3131 Python).
describe("Import/alias extraction accepts Unicode identifiers", () => {
  it("Rust: extern crate alias, use alias, and module name", () => {
    expect(parseRustImportStatement("mod \u2118\u0301;")).toEqual({
      kind: "module",
      from: "\u2118\u0301",
      local: "\u2118\u0301",
      isExternCrate: false,
    });
    expect(parseRustImportStatement("extern crate \u2118 as alias\u0301;")).toEqual({
      kind: "module",
      from: "\u2118",
      local: "alias\u0301",
      isExternCrate: true,
    });
    expect(parseRustImportStatement("use std::foo as alias\u0301;")).toEqual({
      kind: "member",
      from: "std",
      imported: "foo",
      local: "alias\u0301",
    });
  });

  it("PHP: use-clause alias", () => {
    expect(parsePhpImportStatement("use App\\Foo as créer;")).toEqual([
      {
        kind: "named",
        from: "App\\Foo",
        imported: "Foo",
        local: "créer",
        importType: "class",
      },
    ]);
    // PHP permits any byte >= 0x80 in an identifier, not just Unicode letters/digits
    // (\p{L}/\p{N}); an emoji alias is valid PHP even though it is outside \p{L}.
    expect(parsePhpImportStatement("use App\\Foo as \u{1f600};")).toEqual([
      expect.objectContaining({ local: "\u{1f600}" }),
    ]);
    expect(parsePhpImportStatement("use App\\{Foo as \u{1f600}, Bar};")).toEqual([
      expect.objectContaining({ imported: "Foo", local: "\u{1f600}" }),
      expect.objectContaining({ imported: "Bar", local: "Bar" }),
    ]);
  });

  it("Kotlin: import alias", () => {
    expect(parseKotlinImportStatement("import com.example.Foo as créer")).toEqual({
      kind: "named",
      from: "com.example.Foo",
      imported: "Foo",
      local: "créer",
    });
    // A dotted segment must itself start with a valid identifier character; a digit
    // immediately after "." is not part of Kotlin's grammar.
    expect(parseKotlinImportStatement("import pkg.2mod")).toBeNull();
    // Kotlin's UnicodeDigit continuation is Nd only; a non-decimal number category (No,
    // e.g. the "½" fraction) is not a valid identifier continuation.
    expect(parseKotlinImportStatement("import com.example.Widget\u00bd")).toBeNull();
  });

  it("Java: import of a Unicode-named class", () => {
    expect(parseJavaImportStatement("import com.example.Créer;")).toEqual({
      kind: "named",
      from: "com.example.Créer",
      imported: "Créer",
      isStatic: false,
    });
    // JLS JavaLetter includes `$` and connecting-punctuation characters at every position,
    // not just Unicode letters/digits.
    expect(parseJavaImportStatement("import com.example.$Widget;")).toEqual({
      kind: "named",
      from: "com.example.$Widget",
      imported: "$Widget",
      isStatic: false,
    });
    // Character.isJavaIdentifierStart accepts a letter-number (Nl) such as a Roman numeral,
    // and isJavaIdentifierPart accepts an identifier-ignorable formatting character (Cf,
    // e.g. ZWNJ) in continuation.
    expect(parseJavaImportStatement("import com.example.\u2160Widget\u200c;")).toEqual({
      kind: "named",
      from: "com.example.\u2160Widget\u200c",
      imported: "\u2160Widget\u200c",
      isStatic: false,
    });
    // A non-decimal number character (No, e.g. the "½" fraction) is not accepted by
    // isJavaIdentifierPart and must not be folded into the imported name.
    expect(parseJavaImportStatement("import com.example.Widget\u00bd;")).toBeNull();
    // isJavaIdentifierPart accepts combining marks (Mn/Mc); a decomposed identifier such as
    // "café" written as "cafe" + combining acute accent (U+0301) is a single valid import.
    expect(parseJavaImportStatement("import com.example.cafe\u0301;")).toEqual({
      kind: "named",
      from: "com.example.cafe\u0301",
      imported: "cafe\u0301",
      isStatic: false,
    });
  });

  it("C#: using alias to a Unicode-named alias", () => {
    expect(parseCsharpUsingDirective("using créer = Some.Namespace;")).toEqual({
      from: "Some.Namespace",
      alias: "créer",
      isStatic: false,
    });
    // A verbatim identifier (`@` prefix) escapes a reserved keyword; `@class` is a legal
    // C# identifier distinct from the `class` keyword.
    expect(parseCsharpUsingDirective("using @class = Some.@class;")).toEqual({
      from: "Some.@class",
      alias: "@class",
      isStatic: false,
    });
    // ECMA-334 identifier-start-character accepts a letter-number (Nl, e.g. a Roman numeral)
    // and identifier-part-character accepts a combining mark (Mn) in continuation.
    expect(parseCsharpUsingDirective("using \u2160Alias = Some.cafe\u0301;")).toEqual({
      from: "Some.cafe\u0301",
      alias: "\u2160Alias",
      isStatic: false,
    });
    // A connecting-punctuation character other than `_` (e.g. U+203F UNDERTIE) is a valid
    // identifier-part-character but not a valid identifier-start-character.
    expect(parseCsharpUsingDirective("using \u203fname = Some.Namespace;")).toBeNull();
  });
  it("Python fallback module-specifier extraction: import/from with Unicode module names", () => {
    expect(extractPythonSpecifiers("import créer\n")).toEqual(["créer"]);
    expect(extractPythonSpecifiers("from créer import x\n")).toContain("créer");
    // PEP 3131 XID_Continue includes combining marks; a per-code-point \p{L}/\p{N} class
    // stops before the trailing combining acute accent, silently dropping it from the
    // captured module name.
    expect(extractPythonSpecifiers("import café\u0301\n")).toEqual(["café\u0301"]);
    // A dotted segment must itself start with an identifier character: matching the whole
    // continuation class (letters/digits/dots) across the separator let a digit immediately
    // follow a `.`, which Python's grammar never allows.
    expect(extractPythonSpecifiers("import pkg.2mod\n")).toEqual(["pkg"]);
  });

  it("Python import bindings accept combining-mark continuations", async () => {
    const bindings: ImportBinding[] = [];
    await collectPythonImportsFromSource({
      projectRoot: process.cwd(),
      file: path.join(process.cwd(), "consumer.py"),
      source: "from package import café as alias\nimport package.café as moduleAlias\n",
      pushBinding: (binding) => bindings.push(binding),
    });

    expect(bindings).toEqual([
      expect.objectContaining({ kind: "named", from: "package", imported: "café", local: "alias" }),
      expect.objectContaining({ kind: "namespace", from: "package.café", localNS: "moduleAlias" }),
    ]);
  });

  it("JS CommonJS destructuring require(): Unicode property name binding", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cjs-unicode-destructure-"));
    try {
      await fsp.writeFile(path.join(root, "dep.js"), "module.exports = { créer() { return 1; } };\n", "utf8");
      await fsp.writeFile(path.join(root, "main.js"), "const { créer } = require('./dep');\ncréer();\n", "utf8");

      const index = await buildProjectIndex(root, { cache: "off" });
      const mainFile = [...index.byFile.keys()].find((file) => file.endsWith("/main.js"))!;
      const mainModule = index.byFile.get(mainFile)!;
      // `const { créer } = require('./dep')` is parsed via an object-pattern text regex
      // (native captures only expose the whole pattern's text, not per-property names).
      // Before the fix the ASCII-only character class matched nothing in "créer" and the
      // whole binding was silently dropped -- imports was empty even though the require()
      // call and file-level graph edge were both still detected by a separate mechanism.
      expect(mainModule.imports).toEqual([
        expect.objectContaining({ kind: "named", local: "créer", imported: "créer", from: "./dep" }),
      ]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("JS text fallback preserves every Unicode identifier import form", async () => {
    const bindings: ImportBinding[] = [];
    await collectJsTextImports({
      source: [
        'import { \u2118 as namedAlias\u200c, type typeName\u200d as typeAlias } from \"es\";',
        'import * as namespaceAlias\u200d from \"namespace\";',
        'const defaultAlias\u200c = require(\"default\");',
        'const { \u2118: objectAlias\u200d, propertyName\u200c } = require(\"properties\");',
        'import equalsAlias\u200d = require(\"equals\");',
      ].join("\n"),
      languageId: "ts",
      resolveFrom: async (from) => ({ external: from }),
      pushBinding: (binding) => bindings.push(binding),
    });

    expect(bindings).toEqual([
      {
        kind: "named",
        local: "namedAlias\u200c",
        imported: "\u2118",
        from: "es",
        resolved: { external: "es" },
        typeOnly: false,
      },
      {
        kind: "named",
        local: "typeAlias",
        imported: "typeName\u200d",
        from: "es",
        resolved: { external: "es" },
        typeOnly: true,
      },
      {
        kind: "namespace",
        localNS: "namespaceAlias\u200d",
        from: "namespace",
        resolved: { external: "namespace" },
        typeOnly: false,
      },
      {
        kind: "default",
        local: "defaultAlias\u200c",
        from: "default",
        resolved: { external: "default" },
        mechanism: "cjs",
      },
      {
        kind: "named",
        local: "objectAlias\u200d",
        imported: "\u2118",
        from: "properties",
        resolved: { external: "properties" },
        mechanism: "cjs",
      },
      {
        kind: "named",
        local: "propertyName\u200c",
        imported: "propertyName\u200c",
        from: "properties",
        resolved: { external: "properties" },
        mechanism: "cjs",
      },
      {
        kind: "default",
        local: "equalsAlias\u200d",
        from: "equals",
        resolved: { external: "equals" },
        mechanism: "cjs",
      },
    ]);
  });
});

describe("Unicode import parser seams", () => {
  it("parses native object-pattern captures with ECMAScript-only identifier characters", async () => {
    const bindings: ImportBinding[] = [];
    const source = "const { \u2118: localAlias\u200d } = require('properties');";
    const point = { row: 0, column: 0, index: 0 };
    const match: NativeMatch = {
      patternIndex: 0,
      captures: [
        { name: "from", text: "'properties'", nodeType: "string", start: point, end: point },
        { name: "pattern", text: "{ \u2118: localAlias\u200d }", nodeType: "object_pattern", start: point, end: point },
      ],
    };
    const resolveFrom = async (from: string) => ({ external: from });
    const pushBinding = (binding: ImportBinding) => bindings.push(binding);
    const getBindings = () => bindings;
    const replaceBindings = (next: ImportBinding[]) => bindings.splice(0, bindings.length, ...next);

    await collectNativeCaptureImportBindings(
      {
        source,
        languageId: "ts",
        isTypeOnly: () => false,
        resolveFrom,
        pushBinding,
        languageContext: {
          file: "consumer.ts",
          projectRoot: process.cwd(),
          source,
          languageId: "ts",
          resolveFrom,
          pushBinding,
          getBindings,
          replaceBindings,
        },
        applyStatementOverride: async () => false,
      },
      [match],
    );

    expect(bindings).toEqual([
      {
        kind: "named",
        local: "localAlias\u200d",
        imported: "\u2118",
        from: "properties",
        resolved: { external: "properties" },
        typeOnly: false,
      },
    ]);
  });

  it("normalizes a Unicode Go import alias from text", async () => {
    const bindings: ImportBinding[] = [
      { kind: "namespace", localNS: "fallback", from: "example.test/dep", resolved: { external: "example.test/dep" } },
    ];
    const resolveFrom = async (from: string) => ({ external: from });
    const pushBinding = (binding: ImportBinding) => bindings.push(binding);
    const getBindings = () => bindings;
    const replaceBindings = (next: ImportBinding[]) => bindings.splice(0, bindings.length, ...next);

    await finalizeLanguageSpecificImports({
      file: "consumer.go",
      projectRoot: process.cwd(),
      source: 'import \u4e2d "example.test/dep"',
      languageId: "go",
      resolveFrom,
      pushBinding,
      getBindings,
      replaceBindings,
    });

    expect(bindings).toEqual([
      { kind: "namespace", localNS: "\u4e2d", from: "example.test/dep", resolved: { external: "example.test/dep" } },
    ]);
  });

  it("extracts Unicode import-equals bindings in the specifier fallback", () => {
    expect(extractJsTsSpecifiers("import alias\u200d = require('package');\n")).toEqual([
      { spec: "package", exportCondition: "require" },
    ]);
  });

  it("parses Unicode Python module names from native-query statement captures", () => {
    const support = supportById("python")!;
    // Mirrors the shape collectModuleSpecifiersFromSource reads from a native compact
    // imports execution: one match per statement, with the full statement text under a
    // "stmt" capture.
    const specs = collectModuleSpecifiersFromSource(support, undefined, "import café\u0301\nfrom pkg import x\n", {
      compactNativeImports: {
        imports: [
          { patternIndex: 0, captures: [{ name: "stmt", text: "import café\u0301" }] },
          { patternIndex: 0, captures: [{ name: "stmt", text: "from pkg import x" }] },
        ],
      },
    });

    expect(specs).toEqual([{ spec: "café\u0301" }, { spec: "pkg" }]);
  });
});
