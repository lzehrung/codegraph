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
import { extractPythonSpecifiers } from "../src/util.js";
import { buildProjectIndex } from "../src/index.js";

// C11-adjacent finding: several import/alias extractors used an ASCII-only [A-Za-z_][\w]*
// character class, which silently drops the binding (or the whole statement) for any
// non-ASCII identifier even though the source language's real grammar permits Unicode
// identifiers (Rust XID_Start/XID_Continue, PHP high-byte identifiers, JVM/C# Unicode
// letters, Go's Unicode "letter" production, JS/TS ID_Start/ID_Continue, PEP 3131 Python).
describe("Import/alias extraction accepts Unicode identifiers", () => {
  it("Rust: extern crate alias, use alias, and module name", () => {
    expect(parseRustImportStatement("mod créer;")).toEqual({
      kind: "module",
      from: "créer",
      local: "créer",
      isExternCrate: false,
    });
    expect(parseRustImportStatement("extern crate créer as créé;")).toEqual({
      kind: "module",
      from: "créer",
      local: "créé",
      isExternCrate: true,
    });
    expect(parseRustImportStatement("use std::foo as créer;")).toEqual({
      kind: "member",
      from: "std",
      imported: "foo",
      local: "créer",
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
  });

  it("Kotlin: import alias", () => {
    expect(parseKotlinImportStatement("import com.example.Foo as créer")).toEqual({
      kind: "named",
      from: "com.example.Foo",
      imported: "Foo",
      local: "créer",
    });
  });

  it("Java: import of a Unicode-named class", () => {
    expect(parseJavaImportStatement("import com.example.Créer;")).toEqual({
      kind: "named",
      from: "com.example.Créer",
      imported: "Créer",
      isStatic: false,
    });
  });

  it("C#: using alias to a Unicode-named alias", () => {
    expect(parseCsharpUsingDirective("using créer = Some.Namespace;")).toEqual({
      from: "Some.Namespace",
      alias: "créer",
      isStatic: false,
    });
  });
  it("Python fallback module-specifier extraction: import/from with Unicode module names", () => {
    expect(extractPythonSpecifiers("import créer\n")).toEqual(["créer"]);
    expect(extractPythonSpecifiers("from créer import x\n")).toContain("créer");
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
});

// Two additional sibling fixes were made for the same defect class but could not be proven
// to change observable behavior against this codebase's actual extraction pipeline, so they
// are documented here rather than asserted as regression tests:
//
// - src/util/specifiers.ts's combined JS/TS regex (import X = require(...) alternative): the
//   module specifier is still recovered via the separate bare `require(...)` alternative in
//   the same combined pattern even when the "import X =" alias fails to match, and
//   extractJsTsSpecifiers's return type never exposes the alias/local name at all. The fix
//   (Unicode-aware alias class) is still correct and removes a latent dependency on that
//   alternative-pattern fallback, but there is no independently observable before/after
//   difference through this function's public contract.
// - src/indexer/imports/languageSpecific.ts's normalizeGoImports alias regex: Go's native
//   query captures already expose the import alias identifier as raw capture text (unaffected
//   by any JS regex), so a named Unicode alias is already correct via the primary native path
//   before this fix. The only alias values normalizeGoImports's regex result changes behavior
//   for are the single-character "." (dot-import) and "_" (blank-import) sentinels, both of
//   which were already covered by the old ASCII character class. The fix is still correct
//   (defense in depth against a change to the native query), but not independently provable
//   as a behavior change in this codebase today.
