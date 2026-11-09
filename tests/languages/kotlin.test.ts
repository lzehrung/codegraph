import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getUnresolvedImports } from "../../src/graphs/unresolved.js";
import { defNodeId, type SymbolGraph } from "../../src/graphs/symbol-graph.js";
import { buildProjectIndex, findReferences, goToDefinition } from "../../src/index.js";
import { buildSymbolGraphDetailed } from "../../src/graphs/symbol-graph-detailed.js";
import { findImplementations } from "../../src/indexer/type-hierarchy.js";
import type { ImportBinding, ProjectIndex } from "../../src/indexer/types.js";
import { collectImportsForFile, collectLocalsAndExportsFromSource, parseFile } from "../../src/indexer.js";
import { fileIdentityKey, normalizePath } from "../../src/util/paths.js";
import { DEFAULT_NATIVE_SOURCE_MAX_BYTES } from "../../src/native/source-limits.js";
import { columnOf as columnInLines, writeFixtureFiles } from "./callable-consumer-fixtures.js";
import { exportedNameOf } from "../helpers/narrow.js";
import { KOTLIN_UNICODE_NAMES } from "../helpers/kotlin-unicode-fixture.js";
import {
  expectKotlinSecondaryConstructorHierarchyInProject,
  expectKotlinSecondaryConstructorSuperCalls,
  expectKotlinSecondaryConstructorSuperReferences,
} from "../helpers/kotlin-secondary-constructor-fixture.js";
import {
  KOTLIN_QUOTED_BOUNDARY_FILES,
  KOTLIN_QUOTED_BOUNDARY_SOURCES,
  KOTLIN_QUOTED_FILES,
  KOTLIN_QUOTED_SOURCES,
  KOTLIN_QUOTED_SCOPE_SOURCES,
} from "../helpers/kotlin-quoted-fixture.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { expectUnicodeSymbolRangeIdentity } from "./unicode-symbol-range.js";
import { JVM_PACKAGE_IMPORT_CASES, JVM_PACKAGE_IMPORT_SOURCES } from "../helpers/jvm-package-import-fixture.js";
import { KOTLIN_DEFAULT_PACKAGE_SOURCES } from "../helpers/kotlin-default-package-fixture.js";
import { KOTLIN_EXTENSION_RECEIVER_SOURCES } from "../helpers/kotlin-extension-receiver-fixture.js";
import {
  expectKotlinReceiverReview,
  KOTLIN_RECEIVER_REVIEW_SOURCES,
} from "../helpers/kotlin-receiver-review-fixture.js";
import { describeTypeParameterReceiverRows } from "../helpers/type-parameter-receiver-fixture.js";
import {
  JVM_QUALIFIED_REVIEW_CASES,
  JVM_VALUE_SHADOW_CASES,
  KOTLIN_QUALIFIED_TYPE_SOURCES,
} from "../helpers/qualified-type-import-fixture.js";
import {
  KOTLIN_TYPE_VALUE_FILES,
  KOTLIN_TYPE_VALUE_LINES,
  KOTLIN_TYPE_PARAMETER_FILES,
  KOTLIN_TYPE_VALUE_TYPE_LINES,
  kotlinTypeParameterSites,
} from "../helpers/scope-binding-read-fixtures.js";
import {
  jvmIncompleteWildcardSources,
  JVM_INCOMPLETE_WILDCARD_CALLS,
  JVM_INCOMPLETE_WILDCARD_CALLABLE_REFERENCES,
  JVM_INCOMPLETE_WILDCARD_TYPES,
} from "../helpers/jvm-incomplete-wildcard-fixture.js";
import {
  RESTORED_DECLARATION_FIXTURES,
  declarationImportTargets,
  withRestoredDeclarationImport,
} from "../helpers/restored-declaration-import-fixture.js";
import {
  DUPLICATE_DECLARATION_CASES,
  expectDuplicateRemovalMatchesColdBuilds,
  withDuplicateDeclarations,
} from "../helpers/duplicate-declaration-import-fixture.js";

type TokenRange = {
  start: { line: number; column: number; index: number };
  end: { line: number; column: number; index: number };
};

function positionForIndex(source: string, index: number): TokenRange["start"] {
  const prefix = source.slice(0, index);
  const lineStart = prefix.lastIndexOf("\n") + 1;
  return { line: prefix.split("\n").length, column: index - lineStart + 1, index };
}

function rangeForToken(source: string, token: string): TokenRange {
  const index = source.indexOf(token);
  if (index < 0) throw new Error(`token not found: ${token}`);
  return { start: positionForIndex(source, index), end: positionForIndex(source, index + token.length) };
}

const definition: LanguageTestDefinition = {
  id: "kotlin",
  samples: [
    {
      name: "chunks Kotlin structures",
      sourceFile: "kotlin.sample.kt",
      exactChunks: [
        { type: "misc", startLine: 1, endLine: 5 },
        { type: "class", name: "MyClass", startLine: 6, endLine: 10 },
        { type: "function", name: "method", startLine: 7, endLine: 9 },
        { type: "misc", startLine: 10, endLine: 11 },
        { type: "object", name: "MyObject", startLine: 12, endLine: 14 },
        { type: "function", name: "run", startLine: 13, endLine: 13 },
        { type: "misc", startLine: 14, endLine: 15 },
        { type: "class", name: "MyInterface", startLine: 16, endLine: 18 },
        { type: "function", name: "act", startLine: 17, endLine: 17 },
        { type: "misc", startLine: 18, endLine: 19 },
        { type: "function", name: "topLevel", startLine: 20, endLine: 21 },
        { type: "property", name: "topValue", startLine: 22, endLine: 23 },
        { type: "type", name: "Alias", startLine: 24, endLine: 24 },
      ],
    },
  ],
  parity: {
    sampleDir: "kotlin",
    exact: {
      dependencyGraph: [
        { from: "main.kt", to: { type: "file", path: "utils/helperFunction.kt" } },
        {
          from: "main.kt",
          to: { type: "file", path: "helpers/helperFromHelpers.kt" },
        },
        {
          from: "Aliases.kt",
          to: { type: "file", path: "utils/helperFunction.kt" },
        },
        {
          from: "TypeConsumers.kt",
          to: { type: "file", path: "utils/helperFunction.kt" },
        },
        {
          from: "TypeConsumers.kt",
          to: { type: "file", path: "utils/MoreTypes.kt" },
        },
        {
          from: ".regressions/unicode_consumer.kt",
          to: { type: "file", path: ".regressions/unicode_def.kt" },
        },
      ],
      symbols: [
        {
          file: "Models.kt",
          symbols: [
            { name: "Mode", kind: "class" },
            { name: "Fast", kind: "variable" },
            { name: "Slow", kind: "variable" },
            { name: "UserId", kind: "type" },
            { name: "topLevelValue", kind: "variable" },
            { name: "Service", kind: "class" },
            { name: "T", kind: "type" },
            { name: "value", kind: "variable" },
          ],
        },
        {
          file: "utils/MoreTypes.kt",
          symbols: [
            { name: "UtilityAlias", kind: "type" },
            { name: "UtilityFactory", kind: "class" },
            { name: "create", kind: "function" },
            { name: "value", kind: "variable" },
            { name: "CompanionCarrier", kind: "class" },
            { name: "build", kind: "function" },
            { name: "value", kind: "variable" },
          ],
        },
        {
          file: "Objects.kt",
          symbols: [
            { name: "AppConfig", kind: "class" },
            { name: "name", kind: "variable" },
            { name: "Builder", kind: "class" },
            { name: "create", kind: "function" },
          ],
        },
      ],
      references: [
        {
          name: "find references for wildcard-imported type alias",
          file: "utils/MoreTypes.kt",
          line: 3,
          column: 11,
          references: [
            { file: "utils/MoreTypes.kt", line: 3 },
            { file: "TypeConsumers.kt", line: 3 },
          ],
        },
        {
          name: "find references for wildcard-imported helper functions",
          file: "utils/helperFunction.kt",
          line: 3,
          column: 5,
          references: [
            { file: "utils/helperFunction.kt", line: 3 },
            { file: "main.kt", line: 1 },
            { file: "main.kt", line: 6 },
            { file: "TypeConsumers.kt", line: 12 },
          ],
        },
      ],
    },
    goToDefinition: [
      {
        name: "go to definition resolves aliased UtilityClass import",
        file: "Aliases.kt",
        line: 3,
        column: 24,
        expectedDefinition: { file: "utils/helperFunction.kt", line: 7 },
      },
      {
        name: "go to definition resolves wildcard-imported type alias",
        file: "TypeConsumers.kt",
        line: 3,
        column: 21,
        expectedDefinition: { file: "utils/MoreTypes.kt", line: 3 },
      },
      {
        name: "go to definition resolves wildcard-imported helper functions",
        file: "TypeConsumers.kt",
        line: 12,
        column: 10,
        expectedDefinition: { file: "utils/helperFunction.kt", line: 3 },
      },
    ],
  },
};

runLanguageTests(definition);

describe("Kotlin accessor and receiver type identities", () => {
  it("agrees across navigation, references, and detailed calls without property or factory decoys", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-receiver-review-"));
    try {
      const files = await writeFixtureFiles(root, KOTLIN_RECEIVER_REVIEW_SOURCES);
      const index = await buildProjectIndex(root, { cache: "off" });
      for (const mod of index.byFile.values()) expect(mod.parseErrorRanges).toEqual([]);
      await expectKotlinReceiverReview(index, files);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kotlin Unicode symbol ranges (C11)", () => {
  it("publishes a UTF-16 string index for a function name preceded by multibyte text", async () => {
    await expectUnicodeSymbolRangeIdentity({
      fileName: "widget.kt",
      source: "// café ☕ prüfung\n/* über */ fun créer(): Int {\n\treturn 1\n}\n",
      symbolName: "créer",
    });
  });
});

describe("Kotlin native identifier declarations", () => {
  it("resolves top-level identifier reads without exporting function locals", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-identifiers-"));
    const file = path.join(root, "Scope.kt");
    await fsp.writeFile(
      file,
      [
        "fun outer() {",
        "  val innerVar = 1",
        "  fun nested() = innerVar",
        "}",
        'val topName = "module"',
        "fun use() = topName",
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      const index = await buildProjectIndex(root, { cache: "off" });
      const module = index.byFile.get(fileIdentityKey(file));
      const references = await findReferences(index, { file, line: 5, column: 5 });

      expect(module?.exports.map(exportedNameOf)).not.toContain("innerVar");
      expect(module?.exports.map(exportedNameOf)).not.toContain("nested");
      expect(references.status).toBe("ok");
      if (references.status === "ok") expect(references.references).toHaveLength(2);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not export members of a function-local class", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-local-class-"));
    const file = path.join(root, "Scope.kt");
    await fsp.writeFile(
      file,
      ["fun outer() {", "    class Local {", "        fun hidden() {}", "    }", "}", "fun keep() {}", ""].join("\n"),
      "utf8",
    );
    try {
      const parsed = await parseFile(file);
      const mod = collectLocalsAndExportsFromSource(file, parsed.source, parsed.sup, [], {
        ...(parsed.nativeQueries === undefined ? {} : { nativeQueries: parsed.nativeQueries }),
      });
      const localNames = mod.locals.map((entry) => entry.localName);
      const exportedNames = mod.exports.map(exportedNameOf);
      expect(localNames).toEqual(expect.arrayContaining(["outer", "Local", "hidden", "keep"]));
      expect(exportedNames).toEqual(expect.arrayContaining(["outer", "keep"]));
      expect(exportedNames).not.toContain("hidden");
      expect(exportedNames).not.toContain("Local");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not export members of a lambda-local class", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-lambda-class-"));
    const file = path.join(root, "Scope.kt");
    await fsp.writeFile(
      file,
      [
        "class Outer {",
        "    class Inner {",
        "        fun deep() {}",
        "    }",
        "}",
        "val handler = {",
        "    class Local {",
        "        fun hidden() {}",
        "    }",
        "}",
        "fun keep() {}",
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      const parsed = await parseFile(file);
      const mod = collectLocalsAndExportsFromSource(file, parsed.source, parsed.sup, [], {
        ...(parsed.nativeQueries === undefined ? {} : { nativeQueries: parsed.nativeQueries }),
      });
      const localNames = mod.locals.map((entry) => entry.localName);
      const exportedNames = mod.exports.map(exportedNameOf);
      expect(localNames).toEqual(expect.arrayContaining(["handler", "Local", "hidden", "keep", "deep"]));
      expect(exportedNames).toEqual(expect.arrayContaining(["handler", "keep", "Outer", "Inner", "deep"]));
      expect(exportedNames).not.toContain("hidden");
      expect(exportedNames).not.toContain("Local");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kotlin multi-dollar strings", () => {
  type Position = { line: number; column: number };
  const keyOf = (position: Position): string => `${position.line}:${position.column}`;
  // The position of a name in a line: `needle` is the first (or last) text on the line that holds it, and the name
  // starts `offset` characters into it, after the dollars.
  const nameIn = (lines: string[], line: number, needle: string, offset: number, last = false): Position => {
    const text = lines[line - 1];
    if (text === undefined) throw new Error(`missing line ${line}`);
    const index = last ? text.lastIndexOf(needle) : text.indexOf(needle);
    if (index < 0) throw new Error(`text not found on line ${line}: ${needle}`);
    return { line, column: index + offset + 1 };
  };
  // The references of the name declared at `declaration` are the declaration and every template, and the coverage is
  // complete. Go-to-definition resolves each template to the declaration and finds nothing at a literal.
  const expectTemplates = async (
    index: ProjectIndex,
    file: string,
    declaration: Position,
    templates: Position[],
    literals: Position[],
  ): Promise<void> => {
    const references = await findReferences(index, { file, ...declaration });
    expect(references.status).toBe("ok");
    if (references.status !== "ok") return;
    expect(references.referenceCoverage?.state).toBe("complete");
    const found = references.references.map((reference) => keyOf(reference.range.start));
    expect(found.sort()).toEqual([declaration, ...templates].map(keyOf).sort());
    for (const template of templates) {
      const definition = await goToDefinition(index, { file, ...template });
      expect(definition.status).toBe("ok");
      if (definition.status === "ok") expect(definition.definition.range.start.line).toBe(declaration.line);
    }
    for (const literal of literals) {
      const definition = await goToDefinition(index, { file, ...literal });
      expect(definition.status).toBe("not_found");
    }
  };

  it("reads a template as a reference and a run of fewer dollars as text", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-multi-dollar-"));
    const file = path.join(root, "Schema.kt").replace(/\\/g, "/");
    const run = "$".repeat(40);
    const lines = [
      'val target = "x"',
      'val brace = $$"id: $${target} text: $target"',
      'val name = $$"id: $$target"',
      'val extra = $$"cost: $$$target"',
      'val triple = $$$"text: $$target template: $$$target"',
      'val raw = $$"""',
      '  {"id": "$${target}", "text": "$target"}',
      '  """',
      `val long = $$"cost: ${run}target"`,
      "",
    ];
    await fsp.writeFile(file, lines.join("\n"), "utf8");
    // With a prefix of two dollars `$${target}` and `$$target` are templates, and so is `$$target` after the dollar
    // of `$$$target`. With a prefix of three, only `$$$target` is. Of a run of forty dollars only the last two start a
    // template.
    const templates = [
      nameIn(lines, 2, "$${target}", 3),
      nameIn(lines, 3, "$$target", 2),
      nameIn(lines, 4, "$$$target", 3),
      nameIn(lines, 5, "$$$target", 3, true),
      nameIn(lines, 7, "$${target}", 3),
      nameIn(lines, 9, "$$target", 2),
    ];
    // Fewer dollars than the prefix are text.
    const literals = [
      nameIn(lines, 2, '$target"', 1),
      nameIn(lines, 5, "$$target ", 2),
      nameIn(lines, 7, '$target"', 1),
    ];
    try {
      const index = await buildProjectIndex(root, { cache: "off" });
      await expectTemplates(index, file, { line: 1, column: 5 }, templates, literals);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("starts a template at a letter above ASCII, an underscore or a closed backtick name", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-multi-dollar-names-"));
    const file = path.join(root, "Names.kt").replace(/\\/g, "/");
    // \u00f1 is a letter with a tilde. The scanner decides from the first character of the name, so a letter above
    // ASCII has to start a template on every platform, as `_` and a backtick name do.
    const lines = [
      'val \u00f1ame = "n"',
      "val _under = 1",
      'val `my name` = "q"',
      'val short = $$"a $$\u00f1ame b $$_under c $$`my name` d"',
      'val raw = $$"""a $$\u00f1ame b $$_under c $$`my name` d"""',
      'val text = $$"a $\u00f1ame b $_under c $`my name` d"',
      'val open = $$"a $$`my name b"',
      'val single = """a $\u00f1ame b $_under c $`my name` d"""',
      "",
    ];
    await fsp.writeFile(file, lines.join("\n"), "utf8");
    // Templates: two dollars in the multi-dollar strings, one dollar in the raw string with one. Literals: one dollar
    // in a string with two, and a backtick name that does not close on its line.
    const names = [
      {
        declaration: { line: 1, column: 5 },
        templates: [
          nameIn(lines, 4, "$$\u00f1ame", 2),
          nameIn(lines, 5, "$$\u00f1ame", 2),
          nameIn(lines, 8, "$\u00f1ame", 1),
        ],
        literals: [nameIn(lines, 6, "$\u00f1ame", 1)],
      },
      {
        declaration: { line: 2, column: 5 },
        templates: [nameIn(lines, 4, "$$_under", 2), nameIn(lines, 5, "$$_under", 2), nameIn(lines, 8, "$_under", 1)],
        literals: [nameIn(lines, 6, "$_under", 1)],
      },
      {
        declaration: { line: 3, column: 5 },
        templates: [
          nameIn(lines, 4, "$$`my name`", 2),
          nameIn(lines, 5, "$$`my name`", 2),
          nameIn(lines, 8, "$`my name`", 1),
        ],
        literals: [nameIn(lines, 6, "$`my name`", 1), nameIn(lines, 7, "$$`my name", 2)],
      },
    ];
    try {
      const index = await buildProjectIndex(root, { cache: "off" });
      for (const name of names) {
        await expectTemplates(index, file, name.declaration, name.templates, name.literals);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

async function kotlinImports(source: string): Promise<ImportBinding[]> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-imports-"));
  try {
    return await collectImportsForFile(path.join(root, "Consumer.kt"), root, { source });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

describe("Kotlin names written with CJK, Hangul, and supplementary-plane letters", () => {
  // The names of the shared fixture (tests/helpers/kotlin-unicode-fixture.ts): two CJK ideographs, two Hangul
  // syllables, and a name that starts with U+20BB7, a CJK ideograph above the basic plane that takes two UTF-16 code
  // units. The grammar generated by an older tree-sitter-cli read none of them as a name, so the file ended in an
  // ERROR and its references stayed partial.
  const { cls, fn, astral: rare } = KOTLIN_UNICODE_NAMES;

  it("resolves a class, a function, and a property across files and keeps a same-named decoy out", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-unicode-names-"));
    try {
      const defLines = [
        "package app",
        "",
        `class ${cls}(val x: Int)`,
        "",
        `fun ${fn}(v: Int): Int = v + 1`,
        "",
        `val ${rare} = ${fn}(1)`,
        `val again = ${rare}`,
        // A raw string with one dollar: `$` and the name start a template.
        'val raw = """x $' + rare + ' y"""',
        "",
      ];
      const useLines = [
        "package client",
        "",
        `import app.${cls}`,
        `import app.${fn}`,
        "",
        "fun use(): Int {",
        `    val made = ${cls}(1)`,
        `    return ${fn}(made.x)`,
        "}",
        "",
      ];
      const decoyLines = ["package other", "", `class ${cls}(val y: Int)`, "", `fun ${fn}(v: Int): Int = v`, ""];
      const paths = await writeFixtureFiles(root, {
        "app/Defs.kt": defLines.join("\n"),
        "client/Use.kt": useLines.join("\n"),
        "other/Decoy.kt": decoyLines.join("\n"),
      });
      const defs = paths["app/Defs.kt"]!;
      const use = paths["client/Use.kt"]!;
      const decoy = paths["other/Decoy.kt"]!;
      const index = await buildProjectIndex(root, { cache: "off" });
      const sitesOf = async (file: string, line: number, column: number): Promise<string[]> => {
        const references = await findReferences(index, { file, line, column });
        if (references.status !== "ok") throw new Error(`Expected references at ${line}:${column}`);
        expect(references.referenceCoverage?.state).toBe("complete");
        return references.references
          .map((reference) => `${path.basename(reference.file)}:${reference.range.start.line}`)
          .sort();
      };

      // Every site that names the class and the function in both files, and none of the decoy's. The property is
      // used in its own file, in an expression and in a raw string template. Columns are 1-based UTF-16 code units,
      // which is what `columnInLines` returns and what the index publishes for the supplementary-plane name.
      expect(await sitesOf(defs, 3, columnInLines(defLines, 3, cls))).toEqual(["Defs.kt:3", "Use.kt:3", "Use.kt:7"]);
      expect(await sitesOf(defs, 5, columnInLines(defLines, 5, fn))).toEqual([
        "Defs.kt:5",
        "Defs.kt:7",
        "Use.kt:4",
        "Use.kt:8",
      ]);
      expect(await sitesOf(defs, 7, columnInLines(defLines, 7, rare))).toEqual(["Defs.kt:7", "Defs.kt:8", "Defs.kt:9"]);

      const targets: Array<[string, number, number, string, number]> = [
        [use, 7, columnInLines(useLines, 7, cls), defs, 3],
        [use, 8, columnInLines(useLines, 8, fn), defs, 5],
        [defs, 8, columnInLines(defLines, 8, rare), defs, 7],
        [defs, 9, columnInLines(defLines, 9, rare), defs, 7],
      ];
      for (const [file, line, column, expectedFile, expectedLine] of targets) {
        const definition = await goToDefinition(index, { file, line, column });
        expect(definition.status).toBe("ok");
        if (definition.status !== "ok") continue;
        expect(normalizePath(definition.definition.file)).toBe(normalizePath(expectedFile));
        expect(definition.definition.range.start.line).toBe(expectedLine);
      }
      // The decoy is a different symbol: its own references are its declaration only.
      expect(await sitesOf(decoy, 3, columnInLines(decoyLines, 3, cls))).toEqual(["Decoy.kt:3"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kotlin import bindings from syntax nodes", () => {
  it("binds semicolon-terminated imports and aliases with node ranges", async () => {
    const source = "import a.b.C;\nimport a.b.D as Alias;\n";
    const bindings = await kotlinImports(source);

    const importedC = rangeForToken(source, "C");
    const importedD = rangeForToken(source, "D");
    const localAlias = rangeForToken(source, "Alias");
    expect(bindings).toEqual([
      {
        kind: "named",
        local: "C",
        imported: "C",
        from: "a.b.C",
        importedRange: importedC,
        localRange: importedC,
        resolved: { external: "a.b.C" },
        typeOnly: false,
      },
      {
        kind: "named",
        local: "Alias",
        imported: "D",
        from: "a.b.D",
        explicitAlias: true,
        importedRange: importedD,
        localRange: localAlias,
        resolved: { external: "a.b.D" },
        typeOnly: false,
      },
    ]);
    expect(source.slice(importedC.start.index, importedC.end.index)).toBe("C");
    expect(source.slice(importedD.start.index, importedD.end.index)).toBe("D");
    expect(source.slice(localAlias.start.index, localAlias.end.index)).toBe("Alias");
    expect(localAlias.start.column).not.toBe(importedD.start.column);
  });

  it("binds imports with nested comments around qualified-name separators", async () => {
    const source = "import pkg./* outer /* inner */ comment */Target as LocalTarget;\n";
    expect(await kotlinImports(source)).toEqual([
      expect.objectContaining({
        kind: "named",
        imported: "Target",
        local: "LocalTarget",
        from: "pkg.Target",
        importedRange: rangeForToken(source, "Target"),
        localRange: rangeForToken(source, "LocalTarget"),
        resolved: { external: "pkg.Target" },
      }),
    ]);
  });

  it("ignores import text in raw multiline strings before real imports", async () => {
    const source = [
      '@file:Suppress("""',
      '"',
      "import fake.Decoy",
      '""")',
      "import real.Target as RealTarget",
      "",
    ].join("\n");
    expect(await kotlinImports(source)).toEqual([
      expect.objectContaining({
        kind: "named",
        imported: "Target",
        local: "RealTarget",
        from: "real.Target",
        importedRange: rangeForToken(source, "Target"),
        localRange: rangeForToken(source, "RealTarget"),
        resolved: { external: "real.Target" },
      }),
    ]);
  });
});

describe("Kotlin .ktm script files", () => {
  it("classifies a kotlin.* import as resolved stdlib, not unresolved", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-ktm-stdlib-"));
    const file = path.join(root, "script.ktm");
    try {
      await fsp.writeFile(file, "import kotlin.io.*\nfun main() {}\n", "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const unresolved = getUnresolvedImports(index.graph, { projectRoot: root });
      expect(unresolved.map((entry) => entry.name)).not.toContain("kotlin.io");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("still reports a genuinely unknown package import in a .ktm file as unresolved", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-ktm-unresolved-"));
    const file = path.join(root, "script.ktm");
    try {
      await fsp.writeFile(file, "import com.example.unknown.Widget\nfun main() {}\n", "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const unresolved = getUnresolvedImports(index.graph, { projectRoot: root });
      expect(unresolved.map((entry) => entry.name)).toContain("com.example.unknown.Widget");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves an import of a package declared in a .ktm file", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-ktm-package-"));
    const declaring = path.join(root, "models.ktm");
    const importing = path.join(root, "main.kt");
    try {
      await fsp.writeFile(declaring, "package app.models\nclass Widget\n", "utf8");
      await fsp.writeFile(importing, "import app.models.Widget\nfun use(): Widget = Widget()\n", "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const fromMain = index.graph.edges.filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(importing));
      expect(fromMain.map((edge) => edge.to)).toEqual([{ type: "file", path: declaring.replace(/\\/g, "/") }]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kotlin imports with a same-named package", () => {
  it("binds an imported class to its declaration and a star import to the package", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-package-class-import-"));
    try {
      const useLines = ["package client", "import p.C", "fun make(): C = C()"];
      const paths = await writeFixtureFiles(root, {
        "p/C.kt": "package p\nclass C\n",
        "p/C/Decoy.kt": "package p.C\nclass Decoy\n",
        "Use.kt": useLines.join("\n") + "\n",
        "UseStar.kt": "package client\nimport p.C.*\nfun make(): Decoy = Decoy()\n",
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const use = paths["Use.kt"]!;
      const declaration = paths["p/C.kt"]!;
      const decoy = paths["p/C/Decoy.kt"]!;
      const binding = index.byFile.get(fileIdentityKey(use))?.imports.find((entry) => entry.from === "p.C");
      expect(binding?.resolved).toBe(declaration);
      expect(binding?.resolved).not.toBe(decoy);

      const importsFrom = (file: string) =>
        index.graph.edges
          .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(file) && edge.to.type === "file")
          .map((edge) => (edge.to.type === "file" ? normalizePath(edge.to.path) : ""));
      expect(importsFrom(use)).toEqual([declaration]);
      expect(importsFrom(use)).not.toContain(decoy);
      expect(importsFrom(paths["UseStar.kt"]!)).toEqual([decoy]);
      const starBinding = index.byFile
        .get(fileIdentityKey(paths["UseStar.kt"]!))
        ?.imports.find((entry) => entry.from === "p.C");
      expect(starBinding?.resolved).toBe(decoy);

      const goto = await goToDefinition(index, { file: use, line: 3, column: columnInLines(useLines, 3, "C()") });
      expect(goto.status).toBe("ok");
      if (goto.status !== "ok") throw new Error("Expected imported class C");
      expect(normalizePath(goto.definition.file)).toBe(declaration);
      expect(normalizePath(goto.definition.file)).not.toBe(decoy);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kotlin declarations in one-line class bodies", () => {
  // The published grammar ended the tree in an ERROR node after two one-line class bodies in a row; the pinned fork reads
  // them, so every declaration after `Early` is a top-level name an import can reach.
  const handlers = [
    "package com.acme.handlers",
    "",
    "class Early",
    "",
    "fun interface Handler { fun handle(x: Int): Int }",
    "",
    "class DefaultHandler : Handler { override fun handle(x: Int) = x }",
    "object Registry { fun all(): List<Handler> = listOf() }",
    "fun createHandler(): Handler = Handler { it }",
    "typealias HandlerAlias = Handler",
    "",
  ].join("\n");
  const importedNames = ["Early", "DefaultHandler", "Registry", "createHandler", "Handler", "HandlerAlias"];

  it("resolves named imports of those declarations from Kotlin and Java, and leaves a member unresolved", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-error-declarations-"));
    try {
      const paths = await writeFixtureFiles(root, {
        "handlers/Handlers.kt": handlers,
        "handlers/Plain.kt": "package com.acme.handlers\n\nclass PlainHandler\nfun plainHandler() = PlainHandler()\n",
        "app/Consumer.kt": [
          "package com.acme.app",
          "",
          ...[...importedNames, "PlainHandler", "plainHandler", "handle", "all"].map(
            (name) => `import com.acme.handlers.${name}`,
          ),
          "",
        ].join("\n"),
        "app/UseFromJava.java": [
          "package com.acme.app;",
          "",
          "import com.acme.handlers.DefaultHandler;",
          "import com.acme.handlers.Registry;",
          "import com.acme.handlers.PlainHandler;",
          "",
          "class UseFromJava {",
          "  DefaultHandler d;",
          "  Registry r;",
          "  PlainHandler p;",
          "}",
          "",
        ].join("\n"),
      });
      const handlersFile = paths["handlers/Handlers.kt"]!;
      const plainFile = paths["handlers/Plain.kt"]!;
      const javaFile = paths["app/UseFromJava.java"]!;

      const index = await buildProjectIndex(root, { cache: "off" });

      const resolvedImports = (file: string): Record<string, string> =>
        Object.fromEntries(
          (index.byFile.get(fileIdentityKey(file))?.imports ?? []).map((binding) => [
            binding.from.split(".").pop()!,
            typeof binding.resolved === "string" ? normalizePath(binding.resolved) : "external",
          ]),
        );
      expect(resolvedImports(paths["app/Consumer.kt"]!)).toEqual({
        ...Object.fromEntries(importedNames.map((name) => [name, handlersFile])),
        PlainHandler: plainFile,
        plainHandler: plainFile,
        // Members of the one-line bodies are not top-level declarations.
        handle: "external",
        all: "external",
      });
      expect(resolvedImports(javaFile)).toEqual({
        DefaultHandler: handlersFile,
        Registry: handlersFile,
        PlainHandler: plainFile,
      });
      const javaEdges = index.graph.edges
        .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(javaFile) && edge.to.type === "file")
        .map((edge) => (edge.to.type === "file" ? normalizePath(edge.to.path) : ""))
        .sort();
      expect(javaEdges).toEqual([handlersFile, plainFile].sort());
      const unresolved = getUnresolvedImports(index.graph, { projectRoot: root }).map((entry) => entry.name);
      expect(unresolved.sort()).toEqual(["com.acme.handlers.all", "com.acme.handlers.handle"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kotlin backtick-quoted top-level names", () => {
  it("uses quoted/plain value bindings instead of a same-named companion receiver", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-quoted-receiver-"));
    try {
      await writeFixtureFiles(root, KOTLIN_QUOTED_SCOPE_SOURCES);
      const index = await buildProjectIndex(root, { cache: "off", threads: 1 });
      const graph = await buildSymbolGraphDetailed(index);
      const callsToWork = graph.edges.flatMap((edge) => {
        if (edge.label !== "calls") return [];
        const target = graph.nodes.get(edge.to);
        if (target?.name !== "work") return [];
        return [`${graph.nodes.get(edge.from)?.name}->${path.basename(target.file)}`];
      });
      expect(callsToWork.sort()).toEqual([
        "companionControl->Gadget.kt",
        "plainControl->Value.kt",
        "plainLocal->Value.kt",
        "plainParameter->Value.kt",
        "quotedControl->Value.kt",
        "quotedLocal->Value.kt",
        "quotedParameter->Value.kt",
      ]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps type aliases beside value bindings and settles inherited members before alias uses", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-positioned-alias-"));
    try {
      await writeFixtureFiles(root, KOTLIN_QUOTED_SCOPE_SOURCES);
      const index = await buildProjectIndex(root, { cache: "off", threads: 1 });
      const graph = await buildSymbolGraphDetailed(index);
      const uses = graph.edges.flatMap((edge) => {
        if (edge.label !== "uses") return [];
        const target = graph.nodes.get(edge.to);
        return target ? [`${graph.nodes.get(edge.from)?.name}->${path.basename(target.file)}::${target.name}`] : [];
      });
      expect(uses.sort()).toEqual([
        "imported->Api.kt::go",
        "localType->Api.kt::Widget",
        "parameterType->Api.kt::Widget",
      ]);
      const aliasCalls = graph.edges.flatMap((edge) => {
        if (edge.label !== "calls") return [];
        const caller = graph.nodes.get(edge.from)?.name;
        if (caller !== "inherited" && caller !== "imported") return [];
        const target = graph.nodes.get(edge.to);
        return target ? [`${caller}->${path.basename(target.file)}::${target.name}`] : [];
      });
      expect(aliasCalls.sort()).toEqual(["imported->Api.kt::go", "inherited->Use.kt::mark"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  // A declaration is read from the syntax tree with its backticks, as an import spells it.
  it("resolves named imports of backtick-quoted declarations and leaves a missing name external", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-backtick-imports-"));
    try {
      const library = ["package com.acme.lib", "", "class `Quoted Type`", "fun `quoted function`() {}", ""];
      const paths = await writeFixtureFiles(root, {
        "lib/Quoted.kt": library.join("\n"),
        "other/Decoy.kt": ["package com.acme.other", "", "class `Quoted Type`", ""].join("\n"),
        "app/Consumer.kt": [
          "package com.acme.app",
          "",
          "import com.acme.lib.`Quoted Type`",
          "import com.acme.lib.`quoted function`",
          "import com.acme.lib.`Missing Type`",
          "",
        ].join("\n"),
      });
      const index = await buildProjectIndex(root, { cache: "off" });

      const resolved = Object.fromEntries(
        (index.byFile.get(fileIdentityKey(paths["app/Consumer.kt"]!))?.imports ?? []).map((binding) => [
          binding.from,
          typeof binding.resolved === "string" ? normalizePath(binding.resolved) : "external",
        ]),
      );
      // The same-named declaration of the other package is not a target.
      expect(resolved).toEqual({
        "com.acme.lib.`Quoted Type`": paths["lib/Quoted.kt"],
        "com.acme.lib.`quoted function`": paths["lib/Quoted.kt"],
        "com.acme.lib.`Missing Type`": "external",
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves imported user types independently of same-named values", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-type-namespace-"));
    try {
      const files = await writeFixtureFiles(root, KOTLIN_TYPE_VALUE_FILES);
      const index = await buildProjectIndex(root, { cache: "off" });
      for (const line of KOTLIN_TYPE_VALUE_TYPE_LINES) {
        const result = await goToDefinition(index, {
          file: files["Use.kt"]!,
          line,
          column: KOTLIN_TYPE_VALUE_LINES[line - 1]!.lastIndexOf("Widget") + 1,
        });
        expect(result.status).toBe("ok");
        if (result.status === "ok") expect(result.definition.file).toBe(files["Api.kt"]);
      }
      for (const [line, declaration] of [
        [6, 3],
        [11, 9],
        [16, 15],
      ] as const) {
        const result = await goToDefinition(index, {
          file: files["Use.kt"]!,
          line,
          column: columnInLines(KOTLIN_TYPE_VALUE_LINES, line, "Widget"),
        });
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(result.definition.file).toBe(files["Use.kt"]);
          expect(result.definition.range.start.line).toBe(declaration);
        }
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves class and function type parameters to their declaration, with and without a same-named import alias", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-type-parameters-"));
    try {
      const files = await writeFixtureFiles(root, KOTLIN_TYPE_PARAMETER_FILES);
      const index = await buildProjectIndex(root, { cache: "off" });
      for (const site of kotlinTypeParameterSites()) {
        const result = await goToDefinition(index, { file: files[site.file]!, line: site.line, column: site.column });
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(result.definition.file).toBe(files[site.file]);
          expect(result.definition.range.start.line).toBe(site.declaration.line);
          expect(result.definition.range.start.column).toBe(site.declaration.column);
        }
      }
      for (const column of [14, 18]) {
        const alias = await goToDefinition(index, { file: files["Alias.kt"]!, line: 3, column });
        expect(alias.status).toBe("ok");
        if (alias.status === "ok") expect(alias.definition.file).toBe(files["Api.kt"]);
      }
      const references = await findReferences(index, { file: files["Api.kt"]!, line: 2, column: 7 });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        expect(references.referenceCoverage.state).toBe("complete");
        const linesIn = (file: string): number[] =>
          references.references.filter((site) => site.file === files[file]).map((site) => site.range.start.line);
        // The import line holds the `Widget` name and the `T` alias name.
        expect(linesIn("Alias.kt")).toEqual([2, 2, 3, 3]);
        expect(linesIn("Use.kt")).toEqual([2, 2]);
        expect(linesIn("Plain.kt")).toEqual([]);
        expect(linesIn("Decoy.kt")).toEqual([]);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("scopes class type parameters to their own declaration so same-named types elsewhere in the file keep resolving", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-type-parameter-leak-"));
    try {
      const lines = [
        "package app",
        "import lib.Widget as W",
        "class A { fun hello() = 1 }",
        "class Box<A>(val a: A)",
        "class Other { fun take(a: A): Int = a.hello() }",
        "class Widgets<W>(val w: W)",
        "fun use(x: W): W = x",
        "class Outer {",
        "    class Inner<A>(val a: A)",
        "    fun inside(a: A): Int = a.hello()",
        "}",
        "typealias Pair2<A> = Pair<A, A>",
        "fun after(a: A): Int = a.hello()",
        "",
      ];
      const files = await writeFixtureFiles(root, {
        "Main.kt": lines.join("\n"),
        "Lib.kt": "package lib\nclass Widget\n",
      });
      const main = files["Main.kt"]!;
      const index = await buildProjectIndex(root, { cache: "off", threads: 1 });
      const gotoLine = async (line: number, token: string, occurrence = 0): Promise<[string, number] | null> => {
        let column = columnInLines(lines, line, token);
        for (let skipped = 0; skipped < occurrence; skipped += 1) {
          column = lines[line - 1]!.indexOf(token, column) + 1;
        }
        const result = await goToDefinition(index, { file: main, line, column });
        if (result.status !== "ok") return null;
        return [path.basename(result.definition.file), result.definition.range.start.line];
      };

      // Type uses outside a class's own declaration reach the peer class and the imported alias.
      expect(await gotoLine(5, "A")).toEqual(["Main.kt", 3]);
      expect(await gotoLine(5, "hello")).toEqual(["Main.kt", 3]);
      expect(await gotoLine(7, "W")).toEqual(["Lib.kt", 2]);
      expect(await gotoLine(7, "W", 1)).toEqual(["Lib.kt", 2]);
      expect(await gotoLine(10, "A")).toEqual(["Main.kt", 3]);
      expect(await gotoLine(10, "hello")).toEqual(["Main.kt", 3]);
      expect(await gotoLine(13, "A")).toEqual(["Main.kt", 3]);
      // Inside the declaring class the type parameter still wins.
      expect(await gotoLine(4, "A", 1)).toEqual(["Main.kt", 4]);
      expect(await gotoLine(6, "W", 2)).toEqual(["Main.kt", 6]);
      expect(await gotoLine(9, "A", 1)).toEqual(["Main.kt", 9]);
      expect(await gotoLine(12, "A", 1)).toEqual(["Main.kt", 12]);

      const classA = await findReferences(index, { file: main, line: 3, column: columnInLines(lines, 3, "A") });
      expect(classA.status).toBe("ok");
      if (classA.status === "ok") {
        const refLines = classA.references.map((site) => site.range.start.line);
        expect(refLines).toEqual([3, 5, 10, 13]);
      }
      const hello = await findReferences(index, { file: main, line: 3, column: columnInLines(lines, 3, "hello") });
      expect(hello.status).toBe("ok");
      if (hello.status === "ok") {
        expect(hello.references.map((site) => site.range.start.line)).toEqual([3, 5, 10, 13]);
      }

      const graph = await buildSymbolGraphDetailed(index);
      const calls = graph.edges.flatMap((edge) => {
        if (edge.label !== "calls") return [];
        return [`${graph.nodes.get(edge.from)?.name}->${graph.nodes.get(edge.to)?.name}`];
      });
      expect(calls.sort()).toEqual(["after->hello", "inside->hello", "take->hello"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("binds quoted and plain spellings of one declaration from Kotlin and Java and leaves a missing name external", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-quoted-bindings-"));
    try {
      const paths = await writeFixtureFiles(root, KOTLIN_QUOTED_SOURCES);
      const index = await buildProjectIndex(root, { cache: "off" });
      const defs = paths[KOTLIN_QUOTED_FILES.defs]!;
      const boxed = paths[KOTLIN_QUOTED_FILES.boxed]!;
      const named = (relative: string): Array<Extract<ImportBinding, { kind: "named" }>> =>
        (index.byFile.get(fileIdentityKey(paths[relative]!))?.imports ?? []).filter(
          (binding): binding is Extract<ImportBinding, { kind: "named" }> => binding.kind === "named",
        );
      const targetOf = (binding: Extract<ImportBinding, { kind: "named" }>): string =>
        typeof binding.resolved === "string" ? normalizePath(binding.resolved) : "external";
      const spelledBy = (
        source: string,
        range: Extract<ImportBinding, { kind: "named" }>["importedRange"],
      ): string | undefined => {
        if (range?.start.index === undefined || range.end.index === undefined) return undefined;
        return source.slice(range.start.index, range.end.index);
      };
      const fileDeps = (relative: string): string[] => {
        const from = fileIdentityKey(paths[relative]!);
        const targets = index.graph.edges.flatMap((edge) =>
          edge.to.type === "file" && fileIdentityKey(edge.from) === from ? [normalizePath(edge.to.path)] : [],
        );
        return [...new Set(targets)].sort();
      };

      const useSource = KOTLIN_QUOTED_SOURCES[KOTLIN_QUOTED_FILES.use]!;
      const useBindings = named(KOTLIN_QUOTED_FILES.use);
      const rows = useBindings.map((binding) => ({
        from: binding.from,
        target: targetOf(binding),
        spelling: spelledBy(useSource, binding.importedRange),
      }));
      expect(rows).toHaveLength(6);
      expect(rows).toEqual(
        expect.arrayContaining([
          { from: "kquoted.app.Widget", target: defs, spelling: "Widget" },
          { from: "kquoted.app.`quoted name`", target: defs, spelling: "`quoted name`" },
          { from: "kquoted.app.`plainName`", target: defs, spelling: "`plainName`" },
          { from: "kquoted.app.`Missing Name`", target: "external", spelling: "`Missing Name`" },
          { from: "kqpkg.lib.Boxed", target: boxed, spelling: "Boxed" },
        ]),
      );

      const alias = useBindings.find((binding) => binding.explicitAlias);
      expect(alias?.local).toBe("Alias");
      expect(spelledBy(useSource, alias?.localRange)).toBe("Alias");
      expect(spelledBy(useSource, alias?.importedRange)).toBe("`quoted name`");
      expect(alias && targetOf(alias)).toBe(defs);

      expect(
        named(KOTLIN_QUOTED_FILES.java).map((binding) => ({ from: binding.from, target: targetOf(binding) })),
      ).toEqual([{ from: "kquoted.app.Widget", target: defs }]);
      expect(
        named(KOTLIN_QUOTED_FILES.quotedPackageUse).map((binding) => ({
          from: binding.from,
          target: targetOf(binding),
        })),
      ).toEqual([{ from: "`kqpkg`.lib.Boxed", target: boxed }]);

      expect(fileDeps(KOTLIN_QUOTED_FILES.use)).toEqual([defs, boxed].sort());
      expect(fileDeps(KOTLIN_QUOTED_FILES.java)).toEqual([defs]);
      expect(fileDeps(KOTLIN_QUOTED_FILES.quotedPackageUse)).toEqual([boxed]);
      expect(fileDeps(KOTLIN_QUOTED_FILES.decoy)).toEqual([]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps quoted Kotlin import boundaries distinct in named, wildcard, and Java lookups", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-quoted-boundaries-"));
    try {
      const paths = await writeFixtureFiles(root, KOTLIN_QUOTED_BOUNDARY_SOURCES);
      const index = await buildProjectIndex(root, { cache: "off" });
      const { defs, javaDef, use, collisions, star, nestedStar, nestedReverse, javaUse, javaStar, decoy } =
        KOTLIN_QUOTED_BOUNDARY_FILES;
      const moduleOf = (file: string) => index.byFile.get(fileIdentityKey(paths[file]!));
      const bindingsOf = (file: string) =>
        (moduleOf(file)?.imports ?? []).filter((binding) => binding.kind === "named");
      const targetOf = (file: string, from: string) =>
        bindingsOf(file).find((binding) => binding.from === from)?.resolved;

      for (const specifier of [
        "kboundary.lib.Gadget",
        "`kboundary`.lib.`Regular`",
        "kboundary.lib.`-JsonWriter`",
        "kboundary.lib.JsonWriter",
        "kboundary.lib.`123Widget`",
        "kboundary.lib.`fun`",
        "kboundary.lib.`is`",
        "kboundary.lib.`in`",
        "kboundary.lib.`with space`",
        "kboundary.lib.`task`",
        "kboundary.lib.task",
        "kboundary.lib.AliasType",
        "kboundary.lib.Holder",
        "kboundary.lib.extTask",
      ]) {
        expect(targetOf(use, specifier), specifier).toBe(paths[defs]);
      }
      for (const specifier of [
        "kboundary.lib.`Space Name`",
        "kboundary.lib.SpaceName",
        "kboundary.lib.lowercase",
        "kboundary.lib.`Lowercase`",
      ]) {
        expect(targetOf(collisions, specifier), specifier).toBe(paths[defs]);
      }
      expect(targetOf(use, "kboundary.lib.`JavaThing`")).toBe(paths[javaDef]);
      expect(targetOf(javaUse, "kboundary.lib.Gadget")).toBe(paths[defs]);

      const targets = (file: string) =>
        index.graph.edges
          .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(paths[file]!) && edge.to.type === "file")
          .map((edge) => (edge.to.type === "file" ? normalizePath(edge.to.path) : ""));
      for (const file of [use, collisions, star, nestedStar, nestedReverse, javaUse, javaStar]) {
        expect(targets(file), file).not.toContain(paths[decoy]);
      }
      expect(targets(star)).toContain(paths[defs]);
      expect(targets(nestedStar)).toContain(paths[defs]);
      expect(targets(nestedReverse)).toContain(paths[defs]);
      expect(targets(javaStar)).toContain(paths[defs]);
      expect(targets(javaStar)).toContain(paths[javaDef]);

      expect(moduleOf(defs)?.jvmFacts?.packageName).toBe("`kboundary`.lib");
      expect(moduleOf(defs)?.jvmFacts?.symbols).toEqual(
        expect.arrayContaining(["`Gadget`", "`-JsonWriter`", "JsonWriter", "`123Widget`", "`fun`", "`task`"]),
      );
      expect(moduleOf(defs)?.jvmFacts?.javaTypes).toEqual(
        expect.arrayContaining(["`Gadget`", "`-JsonWriter`", "JsonWriter", "`123Widget`"]),
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not confuse malformed dotted or unterminated quoted imports with a real segmented name", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-malformed-quoted-imports-"));
    try {
      // Kotlin/JVM rejects dots inside a quoted identifier and empty quoted names.
      const paths = await writeFixtureFiles(root, {
        "decoy/Decoy.kt": "package pkg.a\nclass b\n",
        "bad/Dot.kt": "package app\nimport pkg.`a.b`\nfun bad(x: `a.b`) = x\n",
        "bad/Package.kt": "package app\nimport `pkg.a`.b\nfun badPackage(x: b) = x\n",
        "bad/Empty.kt": "package app\nimport pkg.``\nfun badEmpty() = 1\n",
        "bad/Unmatched.kt": "package app\nimport pkg.`a\nfun badUnmatched() = 1\n",
        "bad/Lone.kt": "package app\nimport pkg.`\nfun badLone() = 1\n",
        "good/Good.kt": "package app\nimport pkg.a.b\nfun good(x: b) = x\n",
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const imports = (file: string) => index.byFile.get(fileIdentityKey(paths[file]!))?.imports ?? [];
      for (const file of ["bad/Dot.kt", "bad/Package.kt", "bad/Empty.kt", "bad/Unmatched.kt", "bad/Lone.kt"]) {
        expect(
          imports(file).some((binding) => binding.resolved === paths["decoy/Decoy.kt"]),
          file,
        ).toBe(false);
      }
      expect(imports("good/Good.kt")[0]?.resolved).toBe(paths["decoy/Decoy.kt"]);
      const goto = await goToDefinition(index, {
        file: paths["bad/Dot.kt"]!,
        line: 3,
        column: "fun bad(x: ".length + 1,
      });
      expect(goto.status).toBe("not_found");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kotlin extension and generic top-level functions", () => {
  // The package index names a function by its own name: an extension function is never declared under its receiver
  // type, and a generic function is declared like any other.
  it("resolves an import of each function and leaves a receiver type's name unresolved", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-function-imports-"));
    try {
      const consumer = [
        "package com.acme.app",
        "",
        "import com.acme.lib.shout",
        "import com.acme.lib.gen",
        "import com.acme.lib.ext",
        "import com.acme.lib.firstName",
        "import com.acme.lib.plain",
        "import com.acme.lib.String",
        "import com.acme.lib.List",
        "import com.acme.other.String as OtherString",
        "",
      ];
      const paths = await writeFixtureFiles(root, {
        "lib/Funs.kt": [
          "package com.acme.lib",
          "",
          "fun String.shout() {}",
          "fun <T> gen(x: T) {}",
          "fun <T> List<T>.ext() {}",
          "fun List<String>.firstName() = firstOrNull()",
          "fun plain() {}",
          "class Real",
          "",
        ].join("\n"),
        // A real declaration of a receiver's name in another package stays reachable.
        "other/Decoy.kt": ["package com.acme.other", "", "class String", ""].join("\n"),
        "app/Consumer.kt": consumer.join("\n"),
        // Java cannot import a Kotlin top-level function, but it can import a class.
        "app/UseFromJava.java": [
          "package com.acme.app;",
          "",
          "import com.acme.lib.shout;",
          "import com.acme.lib.Real;",
          "",
          "class UseFromJava {}",
          "",
        ].join("\n"),
      });

      const index = await buildProjectIndex(root, { cache: "off" });

      const resolvedImports = (relative: string): Record<string, string> =>
        Object.fromEntries(
          (index.byFile.get(fileIdentityKey(paths[relative]!))?.imports ?? []).map((binding) => [
            binding.from,
            typeof binding.resolved === "string" ? normalizePath(binding.resolved) : "external",
          ]),
        );
      const functions = paths["lib/Funs.kt"];
      expect(resolvedImports("app/Consumer.kt")).toEqual({
        "com.acme.lib.shout": functions,
        "com.acme.lib.gen": functions,
        "com.acme.lib.ext": functions,
        "com.acme.lib.firstName": functions,
        "com.acme.lib.plain": functions,
        "com.acme.lib.String": "external",
        "com.acme.lib.List": "external",
        "com.acme.other.String": paths["other/Decoy.kt"],
      });
      expect(resolvedImports("app/UseFromJava.java")).toEqual({
        "com.acme.lib.shout": "external",
        "com.acme.lib.Real": functions,
      });

      // Navigation agrees: the imported function opens its declaration, and the receiver type opens nothing.
      const consumerFile = paths["app/Consumer.kt"]!;
      const shout = await goToDefinition(index, {
        file: consumerFile,
        line: 3,
        column: columnInLines(consumer, 3, "shout"),
      });
      expect(shout.status).toBe("ok");
      if (shout.status === "ok") expect(shout.definition.localName).toBe("shout");
      const receiver = await goToDefinition(index, {
        file: consumerFile,
        line: 8,
        column: columnInLines(consumer, 8, "String"),
      });
      expect(receiver.status).toBe("not_found");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kotlin authoritative package imports", () => {
  it("keeps undeclared package names external while importing declared functions and types", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-authoritative-package-"));
    try {
      const paths = await writeFixtureFiles(root, JVM_PACKAGE_IMPORT_SOURCES);
      const index = await buildProjectIndex(root, { cache: "off" });
      for (const row of JVM_PACKAGE_IMPORT_CASES.filter((entry) => entry.file.endsWith(".kt"))) {
        const file = paths[row.file]!;
        const module = index.byFile.get(fileIdentityKey(file));
        expect(module?.imports, row.file).toHaveLength(1);
        const resolved = module?.imports[0]?.resolved;
        if (row.target) {
          expect(resolved, row.file).toBe(paths[row.target.file]);
        } else {
          expect(resolved, row.file).toEqual({ external: row.specifier });
        }
        expect(module?.parserDegraded, row.file).toBeUndefined();
        expect(module?.importLookupIncomplete, row.file).toBeUndefined();
        const fileEdges = index.graph.edges
          .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(file))
          .flatMap((edge) => (edge.to.type === "file" ? [normalizePath(edge.to.path)] : []));
        expect(fileEdges, row.file).toEqual(row.target ? [paths[row.target.file]] : []);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kotlin package files without a usable syntax tree", () => {
  // A file over the native source limit is never parsed whole, so it keeps its package but its declarations are
  // unknown, not empty. A Kotlin import names every declaration of its name: a class, a function, a typealias.
  it("leaves every name an incomplete package file may declare unresolved and marks the importer", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-no-tree-package-"));
    try {
      const padding = "// padding\n".repeat(Math.ceil(DEFAULT_NATIVE_SOURCE_MAX_BYTES / 11) + 1);
      const useSelect = ["package com.acme.app", "", "import com.acme.p.select", "", "fun use() = select(1)", ""];
      const paths = await writeFixtureFiles(root, {
        "p/Small.kt": ["package com.acme.p", "", "class Known", "fun select(x: Int) = x", ""].join("\n"),
        "p/Iface.kt": ["package com.acme.p", "", "interface Service", ""].join("\n"),
        // Big.kt may overload `select`, and may declare a factory function named like the interface `Service`.
        "p/Big.kt": `package com.acme.p\n\nfun select(x: String) = x\n${padding}`,
        "q/Other.kt": ["package com.acme.q", "", "class Quiet", "fun helper() = 1", ""].join("\n"),
        "app/UseSelect.kt": useSelect.join("\n"),
        "app/UseMissing.kt": ["package com.acme.app", "", "import com.acme.p.Missing", ""].join("\n"),
        "app/UseClasses.kt": [
          "package com.acme.app",
          "",
          "import com.acme.p.Known",
          "import com.acme.p.Service",
          "",
        ].join("\n"),
        "app/Clean.kt": ["package com.acme.app", "", "import com.acme.q.Quiet", "import com.acme.q.helper", ""].join(
          "\n",
        ),
      });

      const index = await buildProjectIndex(root, { cache: "off" });

      const moduleOf = (relative: string) => index.byFile.get(fileIdentityKey(paths[relative]!));
      const resolvedImports = (relative: string): Record<string, string> =>
        Object.fromEntries(
          (moduleOf(relative)?.imports ?? []).map((binding) => [
            binding.from,
            typeof binding.resolved === "string" ? normalizePath(binding.resolved) : "external",
          ]),
        );
      // `select` may be overloaded in Big.kt, and Big.kt may declare `Missing`; neither is proven for the importer.
      expect(resolvedImports("app/UseSelect.kt")).toEqual({ "com.acme.p.select": "external" });
      expect(resolvedImports("app/UseMissing.kt")).toEqual({ "com.acme.p.Missing": "external" });
      // A class and a function can share a name, so a class that another file proves rules out nothing: Big.kt may
      // declare `fun Known()` or the factory `fun Service()`, and an import names both.
      expect(resolvedImports("app/UseClasses.kt")).toEqual({
        "com.acme.p.Known": "external",
        "com.acme.p.Service": "external",
      });
      for (const importer of ["app/UseSelect.kt", "app/UseMissing.kt", "app/UseClasses.kt"]) {
        expect(moduleOf(importer), importer).toMatchObject({ parserDegraded: true, importLookupIncomplete: true });
      }
      // Another package has no incomplete file.
      expect(resolvedImports("app/Clean.kt")).toEqual({
        "com.acme.q.Quiet": paths["q/Other.kt"],
        "com.acme.q.helper": paths["q/Other.kt"],
      });
      expect(moduleOf("app/Clean.kt")?.parserDegraded).toBeUndefined();
      expect(moduleOf("app/Clean.kt")?.importLookupIncomplete).toBeUndefined();

      // The consumers agree: no file edge, and the call does not go to the one overload that could be read.
      const fileEdgesOf = (relative: string) =>
        index.graph.edges.filter(
          (edge) => fileIdentityKey(edge.from) === fileIdentityKey(paths[relative]!) && edge.to.type === "file",
        );
      expect(fileEdgesOf("app/UseSelect.kt")).toEqual([]);
      expect(fileEdgesOf("app/UseClasses.kt")).toEqual([]);
      const call = await goToDefinition(index, {
        file: paths["app/UseSelect.kt"]!,
        line: 5,
        column: columnInLines(useSelect, 5, "select"),
      });
      expect(call.status).toBe("not_found");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  // Kotlin sees a package-private Java class of its own package, and an import of `Service` names it as well as a factory
  // `fun Service()`. An incomplete Java file may declare it whatever its name; another package sees only public types.
  it("keeps an incomplete Java file as a possible declarer for an importer in its package", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-java-peer-"));
    try {
      const padding = "// padding\n".repeat(Math.ceil(DEFAULT_NATIVE_SOURCE_MAX_BYTES / 11) + 1);
      const paths = await writeFixtureFiles(root, {
        "p/Factory.kt": ["package com.acme.p", "", "fun Service() = 1", ""].join("\n"),
        // Definitions.java is over the limit past `Other`, so it may declare a package-private `Service` after it.
        "p/Definitions.java": `package com.acme.p;\n\nclass Other {}\n${padding}`,
        "p/SamePackage.kt": ["package com.acme.p", "", "import com.acme.p.Service", ""].join("\n"),
        "app/OtherPackage.kt": ["package com.acme.app", "", "import com.acme.p.Service", ""].join("\n"),
      });

      const index = await buildProjectIndex(root, { cache: "off" });

      const moduleOf = (relative: string) => index.byFile.get(fileIdentityKey(paths[relative]!));
      const resolved = (relative: string): unknown => moduleOf(relative)?.imports[0]?.resolved;
      // Factory.kt declares `Service`, but Definitions.java may too, so the importer in package p cannot rely on one file.
      expect(resolved("p/SamePackage.kt")).toEqual({ external: "com.acme.p.Service" });
      expect(moduleOf("p/SamePackage.kt")).toMatchObject({ parserDegraded: true, importLookupIncomplete: true });
      // A package-private class is invisible from package app, so Factory.kt is the one declaration there.
      expect(normalizePath(String(resolved("app/OtherPackage.kt")))).toBe(paths["p/Factory.kt"]);
      expect(moduleOf("app/OtherPackage.kt")?.parserDegraded).toBeUndefined();
      expect(moduleOf("app/OtherPackage.kt")?.importLookupIncomplete).toBeUndefined();

      const fileEdgesOf = (relative: string): string[] =>
        index.graph.edges
          .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(paths[relative]!) && edge.to.type === "file")
          .map((edge) => (edge.to.type === "file" ? normalizePath(edge.to.path) : ""));
      expect(fileEdgesOf("p/SamePackage.kt")).toEqual([]);
      expect(fileEdgesOf("app/OtherPackage.kt")).toEqual([paths["p/Factory.kt"]]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  // `import p.*` names every declaration of package `p`, so a file of `p` that was not read in full may declare names the
  // wildcard binds. The wildcard still lists the file; its importer is marked, as a named import is.
  it("marks the importer of a package wildcard while a package file was not read in full, and still lists the file", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-wildcard-incomplete-"));
    try {
      const padding = "// padding\n".repeat(Math.ceil(DEFAULT_NATIVE_SOURCE_MAX_BYTES / 11) + 1);
      const paths = await writeFixtureFiles(root, {
        // Big.kt is over the native limit past `Unread`, and Gap.kt has a syntax error at the top after `Before`.
        "big/Small.kt": ["package com.acme.big", "", "class Known", ""].join("\n"),
        "big/Big.kt": `package com.acme.big\n\nclass Unread\n${padding}`,
        "gap/Peer.kt": ["package com.acme.gap", "", "class Peer", ""].join("\n"),
        "gap/Gap.kt": ["package com.acme.gap", "", "class Before", ")", "fun after() = 1", ""].join("\n"),
        "q/Other.kt": ["package com.acme.q", "", "class Quiet", ""].join("\n"),
        "app/UseBig.kt": ["package com.acme.app", "", "import com.acme.big.*", ""].join("\n"),
        "app/UseGap.kt": ["package com.acme.app", "", "import com.acme.gap.*", ""].join("\n"),
        "app/UseQuiet.kt": ["package com.acme.app", "", "import com.acme.q.*", ""].join("\n"),
      });

      const index = await buildProjectIndex(root, { cache: "off" });

      const moduleOf = (relative: string) => index.byFile.get(fileIdentityKey(paths[relative]!));
      expect(
        moduleOf("gap/Gap.kt")?.parseErrorRanges?.length,
        "the pinned grammar no longer fails on Gap.kt",
      ).toBeTruthy();
      const starFiles = (relative: string): string[] | undefined =>
        moduleOf(relative)
          ?.imports.find((binding) => binding.kind === "star")
          ?.jvmPackageFiles?.map((file) => path.basename(file));
      // The file stays in its package either way: the wildcard lists it, and the importer is marked.
      expect(starFiles("app/UseBig.kt")).toEqual(["Big.kt", "Small.kt"]);
      expect(starFiles("app/UseGap.kt")).toEqual(["Gap.kt", "Peer.kt"]);
      for (const importer of ["app/UseBig.kt", "app/UseGap.kt"]) {
        expect(moduleOf(importer), importer).toMatchObject({ parserDegraded: true, importLookupIncomplete: true });
      }
      // A package whose files all read has nothing to mark.
      expect(starFiles("app/UseQuiet.kt")).toEqual(["Other.kt"]);
      expect(moduleOf("app/UseQuiet.kt")?.parserDegraded).toBeUndefined();
      expect(moduleOf("app/UseQuiet.kt")?.importLookupIncomplete).toBeUndefined();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not prove wildcard calls past unread overloads or factories, while retaining class type navigation", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-unread-wildcard-calls-"));
    try {
      const sources = jvmIncompleteWildcardSources();
      const paths = await writeFixtureFiles(root, sources);
      const index = await buildProjectIndex(root, { cache: "off" });
      expect(index.byFile.get(fileIdentityKey(paths["gap/Gap.kt"]!))?.parseErrorRanges?.length).toBeTruthy();
      for (const row of [...JVM_INCOMPLETE_WILDCARD_CALLS, ...JVM_INCOMPLETE_WILDCARD_CALLABLE_REFERENCES]) {
        const text = sources[row.file]!.split("\n")[row.line - 1]!;
        const result = await goToDefinition(index, {
          file: paths[row.file]!,
          line: row.line,
          column: text.lastIndexOf(row.name) + 1,
        });
        expect(result.status, row.caller).toBe(row.target ? "ok" : "not_found");
        if (row.target && result.status === "ok") {
          expect(result.definition.file, row.caller).toBe(paths[row.target.file]);
          expect(result.definition.range.start.line, row.caller).toBe(row.target.line);
        }
      }
      for (const row of JVM_INCOMPLETE_WILDCARD_TYPES) {
        const result = await goToDefinition(index, {
          file: paths[row.file]!,
          line: row.line,
          column: columnInLines(sources[row.file]!.split("\n"), row.line, row.name),
        });
        expect(result.status, row.file).toBe("ok");
        if (result.status === "ok") expect(result.definition.file, row.file).toBe(paths[row.target.file]);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kotlin package files with a syntax error", () => {
  // The error leaves `select(String)` unread, so Gap.kt may overload what Peer.kt declares. `Before` was read first.
  it("keeps the names read before the error and leaves a name it may declare unresolved", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-error-file-package-"));
    try {
      const paths = await writeFixtureFiles(root, {
        "p/Gap.kt": ["package com.acme.p", "", "class Before", ")", "fun select(x: String) = x", ""].join("\n"),
        "p/Peer.kt": ["package com.acme.p", "", "fun select(x: Int) = x", ""].join("\n"),
        "app/UseSelect.kt": ["package com.acme.app", "", "import com.acme.p.select", ""].join("\n"),
        "app/UseBefore.kt": ["package com.acme.app", "", "import com.acme.p.Before", ""].join("\n"),
      });

      const index = await buildProjectIndex(root, { cache: "off" });

      const moduleOf = (relative: string) => index.byFile.get(fileIdentityKey(paths[relative]!));
      expect(
        moduleOf("p/Gap.kt")?.parseErrorRanges?.length,
        "the pinned grammar no longer fails on Gap.kt",
      ).toBeTruthy();
      const resolved = (relative: string): unknown => moduleOf(relative)?.imports[0]?.resolved;
      // `select` is declared in Peer.kt and may be in Gap.kt too, so no file is proven.
      expect(resolved("app/UseSelect.kt")).toEqual({ external: "com.acme.p.select" });
      expect(moduleOf("app/UseSelect.kt")).toMatchObject({ parserDegraded: true, importLookupIncomplete: true });
      // `Before` was read, so Gap.kt declares it whatever follows the error.
      expect(normalizePath(String(resolved("app/UseBefore.kt")))).toBe(paths["p/Gap.kt"]);
      expect(moduleOf("app/UseBefore.kt")?.importLookupIncomplete).toBeUndefined();

      const fileEdgesOf = (relative: string): string[] =>
        index.graph.edges
          .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(paths[relative]!) && edge.to.type === "file")
          .map((edge) => (edge.to.type === "file" ? normalizePath(edge.to.path) : ""));
      expect(fileEdgesOf("app/UseSelect.kt")).toEqual([]);
      expect(fileEdgesOf("app/UseBefore.kt")).toEqual([paths["p/Gap.kt"]]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kotlin receiver member navigation", () => {
  it("resolves property and method navigation to the proven receiver, not a local or decoy member", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-receiver-nav-"));
    const file = path.join(root, "box.kt").replace(/\\/g, "/");
    const source = [
      "class Box {",
      "  val payload = 1",
      "  fun ping(): Int = payload",
      "}",
      "class Decoy {",
      "  val payload = 2",
      "  fun ping(): Int = payload",
      "}",
      "fun use(box: Box) {",
      "  val payload = 99",
      "  val ping = 99",
      "  val x = box.payload",
      "  box.ping()",
      "}",
      "fun other(decoy: Decoy) {",
      "  decoy.payload",
      "  decoy.ping()",
      "}",
      "",
    ].join("\n");
    await fsp.writeFile(file, source, "utf8");
    const columnOf = (line: number, token: string): number => {
      const text = source.split("\n")[line - 1];
      if (!text) throw new Error(`missing line ${line}`);
      const index = text.indexOf(token);
      if (index < 0) throw new Error(`token not found on line ${line}: ${token}`);
      return index + 1;
    };
    try {
      const index = await buildProjectIndex(root, { cache: "off" });

      const boxPayload = await goToDefinition(index, { file, line: 12, column: columnOf(12, "payload") });
      expect(boxPayload.status).toBe("ok");
      if (boxPayload.status === "ok") expect(boxPayload.definition.range.start.line).toBe(2);

      const boxPing = await goToDefinition(index, { file, line: 13, column: columnOf(13, "ping") });
      expect(boxPing.status).toBe("ok");
      if (boxPing.status === "ok") expect(boxPing.definition.range.start.line).toBe(3);

      const decoyPayload = await goToDefinition(index, { file, line: 16, column: columnOf(16, "payload") });
      expect(decoyPayload.status).toBe("ok");
      if (decoyPayload.status === "ok") expect(decoyPayload.definition.range.start.line).toBe(6);

      const localPayload = await goToDefinition(index, { file, line: 10, column: columnOf(10, "payload") });
      expect(localPayload.status).toBe("ok");
      if (localPayload.status === "ok") expect(localPayload.definition.range.start.line).toBe(10);

      const payloadRefs = await findReferences(index, { file, line: 2, column: columnOf(2, "payload") });
      expect(payloadRefs.status).toBe("ok");
      if (payloadRefs.status === "ok") {
        const payloadLines = payloadRefs.references.map((reference) => reference.range.start.line);
        expect(payloadLines).toEqual(expect.arrayContaining([2, 3, 12]));
        expect(payloadLines).not.toContain(6);
        expect(payloadLines).not.toContain(10);
        expect(payloadLines).not.toContain(16);
      }

      const pingRefs = await findReferences(index, { file, line: 3, column: columnOf(3, "ping") });
      expect(pingRefs.status).toBe("ok");
      if (pingRefs.status === "ok") {
        const pingLines = pingRefs.references.map((reference) => reference.range.start.line);
        expect(pingLines).toEqual(expect.arrayContaining([3, 13]));
        expect(pingLines).not.toContain(7);
        expect(pingLines).not.toContain(11);
        expect(pingLines).not.toContain(17);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kotlin same-package sibling classes", () => {
  // #378: same-package Kotlin classes have implicit visibility, so a sibling class used as a
  // return type and constructed with a capitalized call must resolve and be referenced without
  // any import, while a same-named class in another package must stay out of both results.
  const targetLines = ["package p", "", "class Target"];
  const useLines = ["/*", "package q", "*/", "package p", "", "class Use {", "  fun make(): Target = Target()", "}"];
  const decoyTargetLines = ["package q", "", "class Target"];
  const decoyUseLines = ["package q", "", "class UseDecoy {", "  fun make(): Target = Target()", "}"];

  it("resolves sibling return types and constructor calls and excludes the other package", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-package-peer-"));
    try {
      const paths = await writeFixtureFiles(root, {
        "p/Target.kt": `${targetLines.join("\n")}\n`,
        "p/Use.kt": `${useLines.join("\n")}\n`,
        "q/Target.kt": `${decoyTargetLines.join("\n")}\n`,
        "q/UseDecoy.kt": `${decoyUseLines.join("\n")}\n`,
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const targetPath = paths["p/Target.kt"]!;
      const usePath = paths["p/Use.kt"]!;
      const decoyPath = paths["q/Target.kt"]!;

      for (const [line, token] of [
        [7, "Target"],
        [7, "Target()"],
      ] as const) {
        const goto = await goToDefinition(index, {
          file: usePath,
          line,
          column: columnInLines(useLines, line, token),
        });
        expect(goto.status, `Use.kt:${line} must resolve`).toBe("ok");
        if (goto.status !== "ok") throw new Error("Expected the same-package class declaration");
        expect(normalizePath(goto.definition.file)).toBe(targetPath);
        expect(goto.definition.range.start.line).toBe(3);
      }

      const references = await findReferences(index, {
        file: targetPath,
        line: 3,
        column: columnInLines(targetLines, 3, "Target"),
      });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected same-package class references");
      const sites = references.references.map(
        (reference) => `${normalizePath(reference.file)}:${reference.range.start.line}`,
      );
      expect(sites).toContain(`${usePath}:7`);
      expect(references.references.some((reference) => normalizePath(reference.file) === decoyPath)).toBe(false);

      const decoyReferences = await findReferences(index, {
        file: decoyPath,
        line: 3,
        column: columnInLines(decoyTargetLines, 3, "Target"),
      });
      expect(decoyReferences.status).toBe("ok");
      if (decoyReferences.status !== "ok") throw new Error("Expected decoy package references");
      expect(decoyReferences.references.some((reference) => normalizePath(reference.file) === usePath)).toBe(false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kotlin implicit-receiver precedence", () => {
  it("attributes extension-body calls to receiver members and in-scope peer extensions", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-extension-body-"));
    try {
      const files = await writeFixtureFiles(root, KOTLIN_EXTENSION_RECEIVER_SOURCES);
      const index = await buildProjectIndex(root, { cache: "off" });
      for (const mod of index.byFile.values()) expect(mod.parseErrorRanges).toEqual([]);
      const graph = await buildSymbolGraphDetailed(index);
      for (const [caller, target] of [
        ["render", "model/Box.kt"],
        ["display", "model/Box.kt"],
        ["crossFile", "app/Extensions.kt"],
      ] as const) {
        const calls = graph.edges.filter(
          (edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === caller,
        );
        expect(calls.map((edge) => graph.nodes.get(edge.to)?.file)).toEqual([files[target]]);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("lets inherited, non-private members beat same-package and wildcard-imported functions", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-inherited-member-"));
    try {
      await fsp.mkdir(path.join(root, "p"), { recursive: true });
      await fsp.mkdir(path.join(root, "q"), { recursive: true });
      const peer = normalizePath(path.join(root, "p", "Peer.kt"));
      await fsp.writeFile(peer, "package p\n\nfun hit(): Int = 1\n\nfun hidden(): Int = 3\n");
      await fsp.writeFile(path.join(root, "q", "Other.kt"), "package q\n\nfun hit(): Int = 2\n");
      await fsp.writeFile(
        path.join(root, "p", "Base.kt"),
        "package p\n\nopen class Base {\n    fun hit(): Int = 4\n    private fun hidden(): Int = 5\n}\n",
      );
      const lines = [
        "package p",
        "",
        "import q.*",
        "",
        "class Derived : Base() {",
        "    fun viaBase(): Int = hit()",
        "    fun privateBase(): Int = hidden()",
        "}",
        "",
        "fun run(): Int = hit()",
        "",
      ];
      const use = normalizePath(path.join(root, "p", "Use.kt"));
      await fsp.writeFile(use, lines.join("\n"));
      const index = await buildProjectIndex(root, { cache: "off" });
      const gotoLine = async (line: number, name: string) => {
        const result = await goToDefinition(index, { file: use, line, column: lines[line - 1]!.lastIndexOf(name) + 1 });
        return result.status === "ok"
          ? `${path.basename(result.definition.file)}:${result.definition.range.start.line}`
          : null;
      };
      // Inside Derived the inherited member wins; a private base member is not inherited; at top
      // level the package function beats `q.*`.
      expect(await gotoLine(6, "hit")).toBe("Base.kt:4");
      expect(await gotoLine(7, "hidden")).toBe("Peer.kt:5");
      expect(await gotoLine(10, "hit")).toBe("Peer.kt:3");
      const peerRefs = await findReferences(index, { file: peer, line: 3, column: 5 });
      if (peerRefs.status !== "ok") throw new Error("Expected package-function references");
      expect(
        peerRefs.references
          .filter((reference) => normalizePath(reference.file) === use)
          .map((reference) => reference.range.start.line),
      ).toEqual([10]);
      const graph = await buildSymbolGraphDetailed(index);
      const calls = graph.edges
        .filter((edge) => edge.label === "calls")
        .map((edge) => `${graph.nodes.get(edge.from)?.name}->${path.basename(graph.nodes.get(edge.to)?.file ?? "")}`)
        .sort();
      expect(calls).toEqual(["privateBase->Peer.kt", "run->Peer.kt", "viaBase->Base.kt"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("prefers an inherited member over a same-file top-level function, but not over a method-local one", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-same-file-top-level-"));
    try {
      const lines = [
        "package k",
        "",
        "open class Base {",
        "    fun hit(): Int = 4",
        "}",
        "",
        "fun hit(): Int = 1",
        "",
        "class Derived : Base() {",
        "    fun use(): Int = hit()",
        "    fun local(): Int {",
        "        fun hit(): Int = 9",
        "        return hit()",
        "    }",
        "}",
        "",
      ];
      const file = normalizePath(path.join(root, "Use.kt"));
      await fsp.writeFile(file, lines.join("\n"));
      const index = await buildProjectIndex(root, { cache: "off" });
      const gotoLine = async (line: number) => {
        const result = await goToDefinition(index, { file, line, column: lines[line - 1]!.lastIndexOf("hit") + 1 });
        return result.status === "ok" ? result.definition.range.start.line : null;
      };
      expect(await gotoLine(10)).toBe(4);
      expect(await gotoLine(13)).toBe(12);
      const graph = await buildSymbolGraphDetailed(index);
      const calls = graph.edges
        .filter((edge) => edge.label === "calls")
        .map(
          (edge) =>
            `${graph.nodes.get(edge.from)?.name}->${graph.nodes.get(edge.to)?.name}@${edge.to.slice(edge.to.lastIndexOf("::") + 2)}`,
        )
        .sort();
      const baseHit = lines.slice(0, 3).join("\n").length + 1 + lines[3]!.indexOf("hit");
      const localHit = lines.slice(0, 11).join("\n").length + 1 + lines[11]!.indexOf("hit");
      expect(calls).toEqual([`local->hit@${localHit}`, `use->hit@${baseHit}`]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps spread and same-count calls ambiguous across a fixed-arity and a vararg inherited overload", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-spread-overloads-"));
    try {
      const lines = [
        "package k",
        "",
        "open class GrandBase {",
        "    fun hit(vararg xs: Int): Int = 1",
        "}",
        "",
        "open class Base : GrandBase() {",
        "    fun hit(a: Int, b: Int): Int = 2",
        "}",
        "",
        "class Derived : Base() {",
        "    fun spread(values: IntArray): Int = hit(*values)",
        "    fun two(): Int = hit(1, 2)",
        "}",
        "",
      ];
      const file = normalizePath(path.join(root, "Use.kt"));
      await fsp.writeFile(file, lines.join("\n"));
      const index = await buildProjectIndex(root, { cache: "off" });
      const gotoLine = async (line: number) => {
        const result = await goToDefinition(index, { file, line, column: lines[line - 1]!.lastIndexOf("hit") + 1 });
        return result.status === "ok" ? result.definition.range.start.line : null;
      };
      // A spread's length is unknown, and two arguments fit both hit(Int, Int) and hit(vararg Int):
      // without argument types neither overload is proven, so neither call has a target.
      expect(await gotoLine(12)).toBeNull();
      expect(await gotoLine(13)).toBeNull();
      const graph = await buildSymbolGraphDetailed(index);
      const calls = graph.edges
        .filter((edge) => edge.label === "calls")
        .map((edge) => `${graph.nodes.get(edge.from)?.name}:${edge.site?.range.start.line}`);
      expect(calls).toEqual([]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves an imported overload by argument count and leaves a shared count unresolved", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-import-overload-"));
    const calc = [
      "package calc2",
      "",
      "fun add(a: Int, b: Int): Int = a + b",
      "fun add(a: Int, b: Int, c: Int): Int = a + b + c",
      "",
    ].join("\n");
    const overlap = [
      "package overlap",
      "",
      "fun add(a: Int, b: Int): Int = a + b",
      "fun add(a: Int, b: Int, c: Int = 0): Int = a + b + c",
      "",
    ].join("\n");
    const decoy = ["package decoy", "", "fun add(a: Int, b: Int, c: Int): Int = -1", ""].join("\n");
    const use = [
      "package use",
      "",
      "import calc2.add",
      "",
      "fun two(): Int = add(1, 2)",
      "fun three(): Int = add(1, 2, 3)",
      "",
    ].join("\n");
    const overlapUse = [
      "package use2",
      "",
      "import overlap.add",
      "",
      "fun both(): Int = add(1, 2)",
      "fun onlyThree(): Int = add(1, 2, 3)",
      "",
    ].join("\n");
    const calcFile = path.join(root, "calc2.kt");
    const overlapFile = path.join(root, "overlap.kt");
    const decoyFile = path.join(root, "decoy.kt");
    const useFile = path.join(root, "use.kt");
    const overlapUseFile = path.join(root, "overlap-use.kt");
    const columnOf = (source: string, line: number, token = "add"): number => {
      const index = source.split("\n")[line - 1]?.lastIndexOf(token) ?? -1;
      if (index < 0) throw new Error(`missing ${token} on line ${line}`);
      return index + 1;
    };
    try {
      await fsp.writeFile(calcFile, calc);
      await fsp.writeFile(overlapFile, overlap);
      await fsp.writeFile(decoyFile, decoy);
      await fsp.writeFile(useFile, use);
      await fsp.writeFile(overlapUseFile, overlapUse);
      const index = await buildProjectIndex(root, { cache: "off" });
      const at = async (file: string, source: string, line: number) =>
        goToDefinition(index, { file, line, column: columnOf(source, line) });
      const two = await at(useFile, use, 5);
      const three = await at(useFile, use, 6);
      const both = await at(overlapUseFile, overlapUse, 5);
      const onlyThree = await at(overlapUseFile, overlapUse, 6);
      const decoyDef = await at(decoyFile, decoy, 3);
      expect(two.status).toBe("ok");
      expect(three.status).toBe("ok");
      expect(onlyThree.status).toBe("ok");
      expect(both.status).toBe("not_found");
      expect(decoyDef.status).toBe("ok");
      if (two.status !== "ok" || three.status !== "ok" || onlyThree.status !== "ok" || decoyDef.status !== "ok") {
        throw new Error("expected the overload declarations");
      }
      expect(two.definition.range.start.line).toBe(3);
      expect(normalizePath(two.definition.file)).toBe(normalizePath(calcFile));
      expect(three.definition.range.start.line).toBe(4);
      expect(normalizePath(three.definition.file)).toBe(normalizePath(calcFile));
      expect(onlyThree.definition.range.start.line).toBe(4);
      expect(normalizePath(onlyThree.definition.file)).toBe(normalizePath(overlapFile));
      expect(normalizePath(two.definition.file)).not.toBe(normalizePath(decoyFile));
      expect(normalizePath(three.definition.file)).not.toBe(normalizePath(decoyFile));

      const useLines = async (file: string, source: string, line: number) => {
        const refs = await findReferences(index, { file, line, column: columnOf(source, line) });
        expect(refs.status).toBe("ok");
        if (refs.status !== "ok") throw new Error("expected references");
        return refs.references
          .filter(
            (ref) =>
              fileIdentityKey(ref.file) === fileIdentityKey(useFile) ||
              fileIdentityKey(ref.file) === fileIdentityKey(overlapUseFile),
          )
          .map((ref) => `${fileIdentityKey(ref.file)}:${ref.range.start.line}`);
      };
      const twoRefs = await useLines(two.definition.file, calc, 3);
      const threeRefs = await useLines(three.definition.file, calc, 4);
      const decoyRefs = await useLines(decoyFile, decoy, 3);
      const useKey = fileIdentityKey(useFile);
      const overlapKey = fileIdentityKey(overlapUseFile);
      expect(twoRefs).toContain(`${useKey}:5`);
      expect(twoRefs).not.toContain(`${useKey}:6`);
      expect(threeRefs).toContain(`${useKey}:6`);
      expect(threeRefs).not.toContain(`${useKey}:5`);
      expect(decoyRefs).not.toContain(`${useKey}:5`);
      expect(decoyRefs).not.toContain(`${useKey}:6`);
      expect(decoyRefs).not.toContain(`${overlapKey}:5`);
      expect(decoyRefs).not.toContain(`${overlapKey}:6`);

      const graph = await buildSymbolGraphDetailed(index);
      const callsFrom = (name: string) =>
        graph.edges
          .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === name)
          .map((edge) => edge.to);
      expect(callsFrom("two")).toEqual([defNodeId(two.definition)]);
      expect(callsFrom("three")).toEqual([defNodeId(three.definition)]);
      expect(callsFrom("onlyThree")).toEqual([defNodeId(onlyThree.definition)]);
      expect(callsFrom("both")).toEqual([]);
      expect(callsFrom("two")).not.toContain(defNodeId(decoyDef.definition));
      expect(callsFrom("three")).not.toContain(defNodeId(decoyDef.definition));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kotlin package-qualified top-level calls", () => {
  it("follows a package path without an import while excluding another package", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-qualified-call-"));
    try {
      const useLines = ["package client", "fun call(): Int = org.math.sum(1, 2)"];
      const paths = await writeFixtureFiles(root, {
        "org/math/Calc.kt": "package org.math\nfun sum(a: Int, b: Int): Int = a + b",
        "org/other/Calc.kt": "package org.other\nfun sum(a: Int, b: Int): Int = -1",
        "client/Use.kt": useLines.join("\n"),
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const result = await goToDefinition(index, {
        file: paths["client/Use.kt"]!,
        line: 2,
        column: columnInLines(useLines, 2, "sum"),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("Expected package-qualified function");
      expect(normalizePath(result.definition.file)).toBe(paths["org/math/Calc.kt"]);
      const references = await findReferences(index, {
        file: result.definition.file,
        line: result.definition.range.start.line,
        column: result.definition.range.start.column,
      });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected function references");
      expect(new Set(references.references.map((ref) => normalizePath(ref.file)))).toEqual(
        new Set([paths["org/math/Calc.kt"], paths["client/Use.kt"]]),
      );
      const graph = await buildSymbolGraphDetailed(index);
      const targets = graph.edges
        .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === "call")
        .map((edge) => normalizePath(graph.nodes.get(edge.to)!.file));
      expect(targets).toEqual([paths["org/math/Calc.kt"]]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kotlin inherited member lookup", () => {
  it("reaches a grandparent through empty classes but not an unrelated owner", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-grandparent-"));
    try {
      const lines = ["package p", "fun call(): Int = Derived().run()"];
      const paths = await writeFixtureFiles(root, {
        "Grand.kt": "package p\nopen class Grand { fun run(): Int = 1 }",
        "Base.kt": "package p\nopen class Base : Grand()",
        "Derived.kt": "package p\nclass Derived : Base()",
        "Decoy.kt": "package p\nclass Decoy { fun run(): Int = -1 }",
        "Use.kt": lines.join("\n"),
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const result = await goToDefinition(index, {
        file: paths["Use.kt"]!,
        line: 2,
        column: columnInLines(lines, 2, "run"),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("Expected inherited Kotlin function");
      expect(normalizePath(result.definition.file)).toBe(paths["Grand.kt"]);
      const graph = await buildSymbolGraphDetailed(index);
      const targets = graph.edges
        .filter(
          (edge) =>
            edge.label === "calls" &&
            graph.nodes.get(edge.from)?.name === "call" &&
            graph.nodes.get(edge.to)?.name === "run",
        )
        .map((edge) => normalizePath(graph.nodes.get(edge.to)!.file));
      expect(targets).toEqual([paths["Grand.kt"]]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kotlin removed duplicate declarations", () => {
  it.each(DUPLICATE_DECLARATION_CASES.filter((candidate) => candidate.languageId === "kotlin"))(
    "binds the survivor after the $declarer duplicate is removed by $mutation, then returns to ambiguous",
    async ({ fixture, mutation, declarer }) => {
      await withDuplicateDeclarations(fixture, { cache: "disk", mutation, declarer }, async (project) => {
        expectDuplicateRemovalMatchesColdBuilds(fixture, project);
      });
    },
  );
});

describe("Kotlin restored declaration imports", () => {
  it.each(RESTORED_DECLARATION_FIXTURES.filter((fixture) => fixture.languageId === "kotlin"))(
    "restores an import when a differently named file declares its type again",
    async (fixture) => {
      await withRestoredDeclarationImport(fixture, "disk", async ({ restored, cold, owner, consumer, decoy }) => {
        expect(declarationImportTargets(restored, consumer)).toEqual(declarationImportTargets(cold, consumer));
        expect(declarationImportTargets(restored, consumer)).toEqual([`file:${fileIdentityKey(owner)}`]);
        expect(declarationImportTargets(restored, consumer)).not.toContain(`file:${fileIdentityKey(decoy)}`);
      });
    },
  );
});

describe("Kotlin default-package imports", () => {
  it("binds declarations, aliases and calls, not named-package decoys", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-default-import-"));
    try {
      const files = await writeFixtureFiles(root, KOTLIN_DEFAULT_PACKAGE_SOURCES);
      const index = await buildProjectIndex(root, { cache: "off" });
      const module = index.byFile.get(fileIdentityKey(files["app/Use.kt"]!));
      expect(module?.imports.map((entry) => entry.resolved)).toEqual([files["Default.kt"], files["Default.kt"]]);
      const graph = await buildSymbolGraphDetailed(index);
      const targets = graph.edges
        .filter((edge) => graph.nodes.get(edge.from)?.name === "make")
        .map((edge) => `${edge.label}:${graph.nodes.get(edge.to)?.name}:${graph.nodes.get(edge.to)?.file}`);
      expect(targets).toContain(`calls:defaultFn:${files["Default.kt"]}`);
      expect(targets).toContain(`calls:DefaultThing:${files["Default.kt"]}`);
      expect(targets.some((target) => target.includes(files["Named.kt"]!))).toBe(false);
      expect(targets.some((target) => target.includes(files["PackageDecoy.kt"]!))).toBe(false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["syntax error", "class Before\n)\nfun defaultFn(): Int = 0\n"],
    ["oversized", `//${"x".repeat(DEFAULT_NATIVE_SOURCE_MAX_BYTES)}\nclass DefaultThing\n`],
  ])("does not prove an import past an unread %s file", async (_kind, unread) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-default-unread-"));
    try {
      const files = await writeFixtureFiles(root, { ...KOTLIN_DEFAULT_PACKAGE_SOURCES, "Unread.kt": unread });
      const index = await buildProjectIndex(root, { cache: "off", threads: 1 });
      const module = index.byFile.get(fileIdentityKey(files["app/Use.kt"]!));
      expect(module).toMatchObject({ parserDegraded: true, importLookupIncomplete: true });
      expect(module?.imports.map((entry) => entry.resolved)).toEqual([
        { external: "DefaultThing" },
        { external: "defaultFn" },
      ]);
      const result = await goToDefinition(index, {
        file: files["app/Use.kt"]!,
        line: 6,
        column: columnInLines(KOTLIN_DEFAULT_PACKAGE_SOURCES["app/Use.kt"].split("\n"), 6, "chosen"),
      });
      expect(result.status).toBe("not_found");
      const graph = await buildSymbolGraphDetailed(index);
      expect(
        graph.edges.some(
          (edge) =>
            graph.nodes.get(edge.from)?.name === "make" && graph.nodes.get(edge.to)?.file === files["Default.kt"],
        ),
      ).toBe(false);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kotlin qualified type imports", () => {
  it("does not attribute a qualified parameter type to a same-named import", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-qualified-type-"));
    try {
      const files = await writeFixtureFiles(root, KOTLIN_QUALIFIED_TYPE_SOURCES);
      const index = await buildProjectIndex(root, { cache: "off" });
      const graph = await buildSymbolGraphDetailed(index);
      const targets = (caller: string) =>
        graph.edges
          .filter((edge) => graph.nodes.get(edge.from)?.name === caller)
          .map((edge) => `${edge.label}:${graph.nodes.get(edge.to)?.file}:${graph.nodes.get(edge.to)?.name}`);
      expect(targets("qualified")).toContain(`uses:${files["other/Widget.kt"]}:Widget`);
      expect(targets("qualified")).toContain(`calls:${files["other/Widget.kt"]}:act`);
      expect(targets("qualified")).not.toContain(`uses:${files["lib/Widget.kt"]}:Widget`);
      expect(targets("qualified")).not.toContain(`calls:${files["lib/Widget.kt"]}:act`);
      expect(targets("bare")).toContain(`uses:${files["lib/Widget.kt"]}:Widget`);
      expect(targets("bare")).toContain(`calls:${files["lib/Widget.kt"]}:act`);
      expect(targets("generic")).toContain(`uses:${files["lib/Widget.kt"]}:Widget`);
      expect(targets("qualifiedGeneric")).not.toContain(`uses:${files["lib/Widget.kt"]}:Widget`);
      expect(targets("qualifiedGeneric")).toContain(`uses:${files["other/Widget.kt"]}:Widget`);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kotlin qualified package and nested type identities", () => {
  it("keeps same-named imports, package types, nested types, and constructed receivers separate", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-qualified-review-"));
    try {
      const row = JVM_QUALIFIED_REVIEW_CASES[0];
      const files = await writeFixtureFiles(root, row.sources);
      const graph = await buildSymbolGraphDetailed(await buildProjectIndex(root, { cache: "off" }));
      const targets = (caller: string, label: string) =>
        graph.edges
          .filter((edge) => edge.label === label && graph.nodes.get(edge.from)?.name === caller)
          .map((edge) => `${graph.nodes.get(edge.to)?.file}::${graph.nodes.get(edge.to)?.name}`);
      for (const [caller, target, name] of [
        ["a", row.other, "Widget"],
        ["b", row.imported, "Widget"],
        ["c", row.nested, "Inner"],
        ["d", row.nested, "Inner"],
        ["e", row.other, "Widget"],
        ["bare", row.imported, "Widget"],
      ] as const)
        expect(targets(caller, "uses")).toContain(`${files[target]}::${name}`);
      expect(targets("a", "uses")).not.toContain(`${files[row.imported]}::Widget`);
      expect(targets("e", "uses")).not.toContain(`${files[row.imported]}::Widget`);
      for (const caller of ["c", "d"]) {
        expect(targets(caller, "uses")).not.toContain(`${files[row.otherNested]}::Inner`);
        expect(targets(caller, "calls")).toContain(`${files[row.nested]}::go`);
        expect(targets(caller, "calls")).not.toContain(`${files[row.otherNested]}::go`);
      }
      expect(targets("e", "calls")).toContain(`${files[row.other]}::act`);
      expect(targets("e", "calls")).not.toContain(`${files[row.imported]}::act`);
      expect(targets("shadow", "calls")).toContain(`${files[row.consumer]}::Widget`);
      expect(targets("shadow", "uses")).not.toContain(`${files[row.imported]}::Widget`);
      expect(targets("shadow", "calls")).not.toContain(`${files[row.other]}::Widget`);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

it("retains extension alias uses on value receivers beside qualified constructors", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-extension-alias-use-"));
  try {
    const files = await writeFixtureFiles(root, {
      "lib/Widget.kt": "package lib\nclass Widget\n",
      "other/Widget.kt": "package other\nclass Widget\n",
      "model/Record.kt": "package model\nclass Record\nfun Record.compact(value: String) = value\n",
      "app/Use.kt": [
        "package app",
        "import lib.Widget",
        "import model.Record",
        "import model.compact as renderCompact",
        "class Use(val field: Record) {",
        '  fun parameter(value: Record) = value.renderCompact("*")',
        '  fun local() { val value = Record(); value.renderCompact("*") }',
        '  fun property() = field.renderCompact("*")',
        '  fun result() = Record().renderCompact("*")',
        "  fun constructor() = other.Widget()",
        "}",
        'fun Record.receiver() = this.renderCompact("*")',
      ].join("\n"),
    });
    const graph = await buildSymbolGraphDetailed(await buildProjectIndex(root, { cache: "off" }));
    const targets = (caller: string) =>
      graph.edges
        .filter((edge) => edge.label === "uses" && graph.nodes.get(edge.from)?.name === caller)
        .map((edge) => `${graph.nodes.get(edge.to)?.file}::${graph.nodes.get(edge.to)?.name}`);
    for (const caller of ["parameter", "local", "property", "result", "receiver"]) {
      expect(targets(caller), caller).toContain(`${files["model/Record.kt"]}::compact`);
    }
    expect(targets("constructor")).toContain(`${files["other/Widget.kt"]}::Widget`);
    expect(targets("constructor")).not.toContain(`${files["lib/Widget.kt"]}::Widget`);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it("resolves a package-qualified Kotlin type despite a value parameter", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-value-shadow-type-"));
  try {
    const row = JVM_VALUE_SHADOW_CASES[1];
    const files = await writeFixtureFiles(root, row.sources);
    const graph = await buildSymbolGraphDetailed(await buildProjectIndex(root, { cache: "off" }));
    const targets = graph.edges
      .filter((edge) => edge.label === "uses" && graph.nodes.get(edge.from)?.name === "shadow")
      .map((edge) => `${graph.nodes.get(edge.to)?.file}::${graph.nodes.get(edge.to)?.name}`);
    expect(targets).toContain(`${files[row.target]}::Widget`);
    expect(targets).not.toContain(`${files[row.decoy]}::Widget`);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

describe("Kotlin interface inheritance", () => {
  const relationsOf = (graph: SymbolGraph): string[] =>
    graph.edges
      .filter((edge) => edge.label === "extends" || edge.label === "implements")
      .map((edge) => `${graph.nodes.get(edge.from)?.name}:${edge.label}:${graph.nodes.get(edge.to)?.name}`)
      .sort();
  const nodeNamed = (graph: SymbolGraph, name: string) => {
    const node = [...graph.nodes.values()].find((candidate) => candidate.name === name);
    if (!node) throw new Error(`Expected the ${name} node`);
    return node;
  };
  const implementationsOf = (index: ProjectIndex, graph: SymbolGraph, name: string): string[] => {
    const result = findImplementations(index, graph, nodeNamed(graph, name).id);
    if (result.status !== "ok") throw new Error(`Expected implementations of ${name}, got ${result.status}`);
    return result.implementations.map((match) => graph.nodes.get(match.symbolId)?.name ?? "").sort();
  };

  it("records sealed and fun interfaces as extends, and every interface as an interface symbol", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-interface-inheritance-"));
    try {
      await writeFixtureFiles(root, {
        "Forms.kt": [
          "interface P {",
          "    fun run()",
          "}",
          "",
          "sealed interface S : P",
          "",
          "fun interface F : P",
          "",
          "class W : S {",
          "    override fun run() {}",
          "}",
          "",
          "interface Lonely : P",
          "",
          "class K : Lonely {",
          "    override fun run() {}",
          "}",
          "",
        ].join("\n"),
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const graph = await buildSymbolGraphDetailed(index);
      expect(relationsOf(graph)).toEqual([
        "F:extends:P",
        "K:implements:Lonely",
        "Lonely:extends:P",
        "S:extends:P",
        "W:implements:S",
      ]);
      // The Kotlin grammar shares class_declaration between classes and interfaces; the interface keyword decides.
      expect(["P", "S", "F", "Lonely"].map((name) => nodeNamed(graph, name).kind)).toEqual([
        "interface",
        "interface",
        "interface",
        "interface",
      ]);
      expect(["W", "K"].map((name) => nodeNamed(graph, name).kind)).toEqual(["class", "class"]);
      // Implementers found through each child interface, and a valid empty answer for an interface nobody implements.
      expect(implementationsOf(index, graph, "P")).toEqual(["K", "W"]);
      expect(implementationsOf(index, graph, "S")).toEqual(["W"]);
      expect(implementationsOf(index, graph, "Lonely")).toEqual(["K"]);
      expect(implementationsOf(index, graph, "F")).toEqual([]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("leaves super.run() in an interface default method unresolved in go-to-definition and the graph alike", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-interface-super-"));
    try {
      const lines = [
        "interface Parent {",
        "    fun run(): Int = 1",
        "}",
        "",
        "interface Child : Parent {",
        "    override fun run(): Int {",
        "        return super.run()",
        "    }",
        "}",
        "",
      ];
      const files = await writeFixtureFiles(root, { "Super.kt": lines.join("\n") });
      const index = await buildProjectIndex(root, { cache: "off" });
      const graph = await buildSymbolGraphDetailed(index);
      // `super` follows class ancestors only; an interface that extends an interface gains no super target, so the
      // relabeled edge cannot make the graph resolve a call that navigation leaves open.
      const call = await goToDefinition(index, {
        file: files["Super.kt"]!,
        line: 7,
        column: columnInLines(lines, 7, "run"),
      });
      expect(call.status).toBe("not_found");
      expect(graph.edges.filter((edge) => edge.label === "calls")).toEqual([]);
      expect(relationsOf(graph)).toEqual(["Child:extends:Parent"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Kotlin base classes named without a constructor call", () => {
  const relationsOf = (graph: SymbolGraph): string[] =>
    graph.edges
      .filter((edge) => edge.label === "extends" || edge.label === "implements")
      .map((edge) => `${graph.nodes.get(edge.from)?.name}:${edge.label}:${graph.nodes.get(edge.to)?.name}`)
      .sort();
  const callsAt = (graph: SymbolGraph, file: string, line: number): string[] =>
    graph.edges
      .filter((edge) => edge.label === "calls" && edge.site?.file === file && edge.site.range.start.line === line)
      .map((edge) => `${graph.nodes.get(edge.to)?.name}@${graph.nodes.get(edge.to)?.file}`);

  it("records a class with only secondary constructors as extending its base, like a constructor-call subclass", async () => {
    await expectKotlinSecondaryConstructorHierarchyInProject();
  });

  it("resolves super.run() in such a class through go-to-definition and the graph, beside a same-named decoy", async () => {
    await expectKotlinSecondaryConstructorSuperCalls();
  });

  it("includes those super calls in references to the base member and excludes a same-named decoy base", async () => {
    await expectKotlinSecondaryConstructorSuperReferences();
  });

  it("reads a project Java class and interface named bare in a Kotlin base list", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-java-bare-base-"));
    try {
      const lines = [
        "package javamix",
        "",
        "class FromJava : Legacy {",
        "    constructor() : super()",
        "",
        "    fun go(): Int {",
        "        return super.run()",
        "    }",
        "}",
        "",
        "class FaceImpl : JavaFace {",
        "    override fun face(): Int = 2",
        "}",
        "",
        "class Both : Legacy, JavaFace {",
        "    constructor() : super()",
        "",
        "    override fun face(): Int = 3",
        "}",
        "",
      ];
      const files = await writeFixtureFiles(root, {
        "javamix/Legacy.java": [
          "package javamix;",
          "",
          "public class Legacy {",
          "    public Legacy() {}",
          "",
          "    public int run() {",
          "        return 1;",
          "    }",
          "}",
          "",
        ].join("\n"),
        "javamix/JavaFace.java": [
          "package javamix;",
          "",
          "public interface JavaFace {",
          "    int face();",
          "}",
          "",
        ].join("\n"),
        "javamix/Mixed.kt": lines.join("\n"),
        "decoy/Legacy.java": [
          "package decoy;",
          "",
          "public class Legacy {",
          "    public int run() {",
          "        return -1;",
          "    }",
          "}",
          "",
        ].join("\n"),
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const graph = await buildSymbolGraphDetailed(index);
      // A Java class is a class symbol and a Java interface an interface symbol, so both read their kind from the index.
      expect(relationsOf(graph)).toEqual([
        "Both:extends:Legacy",
        "Both:implements:JavaFace",
        "FaceImpl:implements:JavaFace",
        "FromJava:extends:Legacy",
      ]);
      for (const edge of graph.edges.filter((candidate) => candidate.label === "extends")) {
        expect(graph.nodes.get(edge.to)?.file).toBe(files["javamix/Legacy.java"]);
      }
      const call = await goToDefinition(index, {
        file: files["javamix/Mixed.kt"]!,
        line: 7,
        column: columnInLines(lines, 7, "run"),
      });
      expect(call.status).toBe("ok");
      if (call.status !== "ok") return;
      expect(call.definition.file).toBe(files["javamix/Legacy.java"]);
      expect(call.definition.range.start.line).toBe(6);
      expect(callsAt(graph, files["javamix/Mixed.kt"]!, 7)).toEqual([`run@${files["javamix/Legacy.java"]}`]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("records no edge, and keeps super unresolved, where a bare entry does not prove its target", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-unproven-bare-base-"));
    try {
      const lines = [
        "package forms",
        "",
        "import android.content.Context",
        "import android.view.View",
        "",
        "open class Base(val x: Int) {",
        "    open fun run(): Int = x",
        "}",
        "",
        "class Plain : Base {",
        "    constructor() : super(0)",
        "",
        "    fun go(): Int {",
        "        return super.run()",
        "    }",
        "}",
        "",
        "typealias Alias = Base",
        "",
        "class ViaAlias : Alias {",
        "    constructor() : super(5)",
        "",
        "    fun go(): Int {",
        "        return super.run()",
        "    }",
        "}",
        "",
        "open class Event(val id: Int) {",
        "    open fun tag(): Int = id",
        "}",
        "",
        "class Handler : (Event) -> Unit {",
        "    constructor()",
        "",
        "    override fun invoke(e: Event) {}",
        "}",
        "",
        "class Outer {",
        "    open class Inner(val a: Int) {",
        "        open fun run(): Int = a",
        "    }",
        "",
        "    interface Contract {",
        "        fun hello(): Int = 1",
        "    }",
        "}",
        "",
        "class Qualified : Outer.Inner {",
        "    constructor() : super(2)",
        "}",
        "",
        "class QualifiedContract : Outer.Contract {",
        "    constructor()",
        "}",
        "",
        "open class Widget(val a: Int)",
        "",
        "fun Widget(): Widget = Widget(1)",
        "",
        "class Wrapped : Widget {",
        "    constructor() : super(2)",
        "}",
        "",
        "class MyView : View {",
        "    constructor(ctx: Context) : super(ctx)",
        "}",
        "",
      ];
      const files = await writeFixtureFiles(root, { "Forms.kt": lines.join("\n") });
      const index = await buildProjectIndex(root, { cache: "off" });
      const graph = await buildSymbolGraphDetailed(index);
      // In a class that declares only secondary constructors, only an unqualified class name proves a class. A
      // typealias, a function type's parameter type, a qualifier, and a library class that the project does not declare
      // each stay out of the hierarchy.
      expect(relationsOf(graph)).toEqual(["Plain:extends:Base", "Wrapped:extends:Widget"]);
      // The class that a same-named factory function shares its name with is the base, not the function.
      const wrapped = graph.edges.find(
        (edge) => edge.label === "extends" && graph.nodes.get(edge.from)?.name === "Wrapped",
      );
      expect(graph.nodes.get(wrapped?.to ?? "")?.kind).toBe("class");
      const superCall = async (line: number) =>
        await goToDefinition(index, { file: files["Forms.kt"]!, line, column: columnInLines(lines, line, "run") });
      const plain = await superCall(14);
      expect(plain.status).toBe("ok");
      if (plain.status === "ok") expect(plain.definition.range.start.line).toBe(7);
      expect(callsAt(graph, files["Forms.kt"]!, 14)).toEqual([`run@${files["Forms.kt"]}`]);
      // A typealias is not followed: its `super.run()` reaches nothing in either consumer.
      expect((await superCall(24)).status).toBe("not_found");
      expect(callsAt(graph, files["Forms.kt"]!, 24)).toEqual([]);
      const event = [...graph.nodes.values()].find((node) => node.name === "Event" && node.kind === "class");
      expect(findImplementations(index, graph, event!.id).status).toBe("unsupported_target");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not read the delegate expression of an explicit delegation as a base", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-delegation-base-"));
    try {
      const lines = [
        "package deleg",
        "",
        "interface Face {",
        "    fun hello(): Int = 1",
        "}",
        "",
        "object DefaultFace : Face {",
        "    override fun hello(): Int = 2",
        "}",
        "",
        "class Delegating : Face by DefaultFace {",
        "    fun go(): Int {",
        "        return super.hello()",
        "    }",
        "}",
        "",
      ];
      const files = await writeFixtureFiles(root, { "Deleg.kt": lines.join("\n") });
      const index = await buildProjectIndex(root, { cache: "off" });
      const graph = await buildSymbolGraphDetailed(index);
      // The delegate object is a value, so it is neither a supertype nor the class `super` addresses.
      expect(relationsOf(graph)).toEqual(["DefaultFace:implements:Face", "Delegating:implements:Face"]);
      const call = await goToDefinition(index, {
        file: files["Deleg.kt"]!,
        line: 13,
        column: columnInLines(lines, 13, "hello"),
      });
      expect(call.status).toBe("not_found");
      expect(callsAt(graph, files["Deleg.kt"]!, 13)).toEqual([]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("records no edge for a function-type supertype and keeps its parameter and return types out of member lookup", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-function-type-base-"));
    try {
      const lines = [
        "package fn",
        "",
        "open class Event(val id: Int) {",
        "    open fun tag(): Int = id",
        "}",
        "",
        "fun tag(): Int = 7",
        "",
        "open class Base(val x: Int) {",
        "    open fun run(): Int = x",
        "}",
        "",
        "class Handler : (Event) -> Unit {",
        "    override fun invoke(e: Event) {}",
        "",
        "    fun go(): Int {",
        "        return tag()",
        "    }",
        "}",
        "",
        "class Suspending : suspend () -> Event {",
        "    override suspend fun invoke(): Event = Event(1)",
        "}",
        "",
        "class Mixed : (Event) -> Unit, Base(2) {",
        "    override fun invoke(e: Event) {}",
        "",
        "    fun go(): Int {",
        "        return super.run()",
        "    }",
        "}",
        "",
      ];
      const files = await writeFixtureFiles(root, { "Fn.kt": lines.join("\n") });
      const file = files["Fn.kt"]!;
      const index = await buildProjectIndex(root, { cache: "off" });
      const graph = await buildSymbolGraphDetailed(index);
      // A function type inherits a library function interface, so its parameter and return types are not supertypes:
      // only the real class beside it is a base.
      expect(relationsOf(graph)).toEqual(["Mixed:extends:Base"]);
      const event = [...graph.nodes.values()].find((node) => node.name === "Event" && node.kind === "class");
      expect(findImplementations(index, graph, event!.id).status).toBe("unsupported_target");
      // `tag()` in Handler reaches the top-level function, never the `Event.tag` that a bound parameter type would add.
      const topLevelTag = `${file}::tag::${lines.join("\n").indexOf("tag(): Int = 7")}`;
      const call = await goToDefinition(index, { file, line: 17, column: columnInLines(lines, 17, "tag") });
      expect(call.status).toBe("ok");
      if (call.status === "ok") expect(call.definition.range.start.line).toBe(7);
      expect(
        graph.edges
          .filter((edge) => edge.label === "calls" && edge.site?.file === file && edge.site.range.start.line === 17)
          .map((edge) => edge.to),
      ).toEqual([topLevelTag]);
      const referenceLines = async (line: number): Promise<number[]> => {
        const refs = await findReferences(index, { file, line, column: columnInLines(lines, line, "tag") });
        if (refs.status !== "ok") throw new Error(`Expected references at line ${line}`);
        return refs.references.map((reference) => reference.range.start.line).sort((a, b) => a - b);
      };
      expect(await referenceLines(4)).toEqual([4]);
      expect(await referenceLines(7)).toEqual([7, 17]);
      // The class that shares a base list with a function type still answers `super`.
      const superCall = await goToDefinition(index, { file, line: 29, column: columnInLines(lines, 29, "run") });
      expect(superCall.status).toBe("ok");
      if (superCall.status === "ok") expect(superCall.definition.range.start.line).toBe(10);
      expect(callsAt(graph, file, 29)).toEqual([`run@${file}`]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps references partial when a qualified base leaves a super call unproven", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-qualified-super-"));
    try {
      const lines = [
        "class Outer {",
        "    open class Nested {",
        "        open fun ping(): Int = 1",
        "    }",
        "",
        "    class Local : Nested {",
        "        constructor() : super()",
        "",
        "        fun local(): Int = super.ping()",
        "    }",
        "}",
        "",
        "open class Base(val arg: Any?, val block: () -> Any? = { null }) {",
        "    open fun ping(): Int = 2",
        "}",
        "",
        "class ArgumentCast : Base(null as Outer.Nested?, { val local: Outer.Nested? = null; local }) {",
        "    fun call(): Int = super.ping()",
        "    fun text(): String = super.toString()",
        "}",
        "",
        "class Other {",
        '    override fun toString(): String = "other"',
        "}",
        "",
        "class Qualified : Outer.Nested {",
        "    constructor() : super()",
        "",
        "    fun qualified(): Int = super.ping()",
        "}",
        "",
        "class Invoked : Outer.Nested() {",
        "    fun invoked(): Int = super.ping()",
        "}",
        "",
      ];
      const files = await writeFixtureFiles(root, { "Main.kt": lines.join("\n") });
      const file = files["Main.kt"]!;
      const index = await buildProjectIndex(root, { cache: "off" });
      const superCall = async (line: number) =>
        await goToDefinition(index, { file, line, column: columnInLines(lines, line, "ping") });
      // The bare nested base proves its class, so its super call resolves. A qualified base resolves through its
      // qualifier when it is a constructor call (`Outer.Nested()`); a bare qualified entry in a class with only
      // secondary constructors proves no class, so its super call stays open.
      const local = await superCall(9);
      expect(local.status).toBe("ok");
      if (local.status === "ok") expect(local.definition.range.start.line).toBe(3);
      const plainBase = await superCall(18);
      expect(plainBase.status).toBe("ok");
      if (plainBase.status === "ok") expect(plainBase.definition.range.start.line).toBe(14);
      expect((await superCall(29)).status).toBe("not_found");
      const invoked = await superCall(33);
      expect(invoked.status).toBe("ok");
      if (invoked.status === "ok") expect(invoked.definition.range.start.line).toBe(3);
      // A qualified type inside constructor value arguments or a lambda argument does not make a plain base unproven:
      // `ArgumentCast` still proves `Base` omits `toString`, so `Other.toString` stays complete.
      const otherRefs = await findReferences(index, {
        file,
        line: 23,
        column: columnInLines(lines, 23, "toString"),
      });
      expect(otherRefs.status).toBe("ok");
      if (otherRefs.status !== "ok") return;
      expect(otherRefs.references.map((reference) => reference.range.start.line)).toEqual([23]);
      expect(otherRefs.referenceCoverage?.state).toBe("complete");
      // The open call in `Qualified` may still reach `ping`, so the omission proof must not rule it out and coverage
      // must not claim to be complete.
      const baseRefs = await findReferences(index, { file, line: 14, column: columnInLines(lines, 14, "ping") });
      expect(baseRefs.status).toBe("ok");
      if (baseRefs.status !== "ok") return;
      expect(baseRefs.references.map((reference) => reference.range.start.line).sort((a, b) => a - b)).toEqual([
        14, 18,
      ]);
      expect(baseRefs.referenceCoverage?.state).toBe("partial");
      const refs = await findReferences(index, { file, line: 3, column: columnInLines(lines, 3, "ping") });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") return;
      expect(refs.references.map((reference) => reference.range.start.line).sort((a, b) => a - b)).toEqual([3, 9, 33]);
      expect(refs.referenceCoverage?.state).toBe("partial");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("proves a qualified base that the project declares and leaves one it does not declare open", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-kotlin-qualified-omission-"));
    try {
      const lines = [
        "class Declared {",
        "    open class Inner",
        "}",
        "",
        "class Resolvable {",
        "    fun alpha(): Int = 1",
        "}",
        "",
        "class Unresolvable {",
        "    fun beta(): Int = 2",
        "}",
        "",
        "class FromDeclared : Declared.Inner() {",
        "    fun call(): Int = super.alpha()",
        "}",
        "",
        "class FromMissing : Missing.Base() {",
        "    fun call(): Int = super.beta()",
        "}",
        "",
      ];
      const files = await writeFixtureFiles(root, { "Main.kt": lines.join("\n") });
      const file = files["Main.kt"]!;
      const index = await buildProjectIndex(root, { cache: "off" });
      const referencesOf = async (line: number, token: string) => {
        const refs = await findReferences(index, { file, line, column: columnInLines(lines, line, token) });
        if (refs.status !== "ok") throw new Error(`Expected references at line ${line}`);
        return refs;
      };
      // `Declared.Inner` resolves through its qualifier and declares no `alpha`, so the open `super.alpha()` in
      // `FromDeclared` is ruled out: the references to `Resolvable.alpha` are complete.
      const alpha = await referencesOf(6, "alpha");
      expect(alpha.references.map((reference) => reference.range.start.line)).toEqual([6]);
      expect(alpha.referenceCoverage?.state).toBe("complete");
      // `Missing.Base` names no declaration, so `FromMissing` may inherit a `beta` that the project declares: the open
      // `super.beta()` stays a candidate and the references to `Unresolvable.beta` are partial.
      const beta = await referencesOf(10, "beta");
      expect(beta.references.map((reference) => reference.range.start.line)).toEqual([10]);
      expect(beta.referenceCoverage?.state).toBe("partial");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
describeTypeParameterReceiverRows("kotlin", "Kotlin type parameter beside a same-named class");
