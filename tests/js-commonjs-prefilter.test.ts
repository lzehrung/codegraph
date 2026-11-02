import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectImportsForFile } from "../src/index.js";
import type { ImportBinding } from "../src/indexer/types.js";
import { collectLocalsAndExportsFromSource } from "../src/indexer/locals-and-exports.js";
import { supportForFile } from "../src/languages.js";
import { maskJsLikeCommentsAndStrings, stripJsLikeComments } from "../src/util/comments.js";

/** The exported names that the real extraction recovers from one source, in order. */
function recoveredExports(file: string, source: string): string[] {
  const support = supportForFile(file);
  if (!support) throw new Error(`No language support for ${file}`);
  return collectLocalsAndExportsFromSource(file, source, support).exports.map((entry) =>
    entry.type === "local" ? entry.exportedAs : entry.type,
  );
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

describe("CommonJS export recovery", () => {
  const found: Array<{ name: string; source: string; exported: string[] }> = [
    { name: "exports.name = function", source: "exports.foo = function () {};\n", exported: ["foo"] },
    { name: "module.exports.name = arrow", source: "module.exports.bar = () => 1;\n", exported: ["bar"] },
    { name: "module.exports = function", source: "module.exports = function named() {};\n", exported: ["exports"] },
    {
      name: "module.exports = identifier",
      source: "const value = 1;\nmodule.exports = value;\n",
      exported: ["default"],
    },
    { name: "module.exports = object", source: "module.exports = { a: function () {} };\n", exported: ["a"] },
    { name: "a form after a semicolon on its line", source: "x(); exports.q = function () {};\n", exported: ["q"] },
    {
      name: "CRLF line breaks",
      source: "exports.crlf = function () {};\r\nmodule.exports.other = () => 2;\r\n",
      exported: ["crlf", "other"],
    },
    {
      name: "a form after a comment that mentions the word",
      source: "/* module.exports = nope */\n// exports in prose\nexports.real = function () {};\n",
      exported: ["real"],
    },
    {
      name: "an ES export next to a string that mentions the word",
      source: 'export const kept = 1;\nconst text = "exports.fake = function () {}";\n',
      exported: ["kept"],
    },
  ];

  // None of these spells `exports` in code: it is escaped, split, cased differently, bracketed, or in a comment or string.
  const absent: Array<{ name: string; source: string; exported: string[] }> = [
    { name: "a line comment", source: "// exports.foo = function () {};\n", exported: [] },
    { name: "a block comment", source: "/* module.exports = function () {} */\n", exported: [] },
    {
      name: "a string",
      source: "const s = \"module.exports = function () {}\";\nconst t = 'exports.a = () => 1';\n",
      exported: [],
    },
    { name: "a template literal", source: "const t = `exports.a = () => 1`;\n", exported: [] },
    { name: "a Unicode escape in the identifier", source: "exp\\u006frts.foo = function () {};\n", exported: [] },
    {
      name: "a Unicode escape of the first letter",
      source: "\\u0065xports.foo = function () {};\nmodule.exp\\u006frts = function () {};\n",
      exported: [],
    },
    {
      name: "bracket access",
      source: "module[\"exports\"] = function () {};\nmodule['exports'].a = () => 1;\n",
      exported: [],
    },
    {
      name: "another letter case",
      source: "EXPORTS.a = function () {};\nmodule.Exports = function () {};\n",
      exported: [],
    },
    {
      name: "a comment inside the word",
      source: "exp/**/orts.a = function () {};\nmodule.ex/**/ports = function () {};\n",
      exported: [],
    },
    { name: "a zero-width space inside the word", source: "exp\u200borts.a = function () {};\n", exported: [] },
    {
      name: "the singular word",
      source: "module.export = function () {};\nmodule.exportz.a = () => 1;\n",
      exported: [],
    },
    {
      name: "ES exports only",
      source: "export const z = 1;\nexport default function main() {}\n",
      exported: ["z", "default"],
    },
  ];

  const files = ["recovery.js", "recovery.ts", "recovery.tsx"];

  it.each(files.flatMap((file) => found.map((entry) => ({ file, ...entry }))))(
    "recovers $name in $file",
    ({ file, source, exported }) => {
      expect(recoveredExports(file, source)).toEqual(expect.arrayContaining(exported));
    },
  );

  it.each(files.flatMap((file) => absent.map((entry) => ({ file, ...entry }))))(
    "recovers only $exported from $name in $file",
    ({ file, source, exported }) => {
      expect(recoveredExports(file, source)).toEqual(exported);
    },
  );

  // The scans of CommonJS forms are skipped when the masked source lacks the word `exports`. A source that gains an
  // inert use of the word outside comments and strings runs them, so each pair must recover the same exports.
  const inertUse = "\n;void exports;\n";

  it("recovers the same exports whether or not the CommonJS scans run", () => {
    const sources = [...found.map((entry) => entry.source), ...absent.map((entry) => entry.source)];
    const fragments = [
      ...sources,
      "export const kept = 1;\n",
      "export default function main() {}\n",
      'export { named } from "./named";\n',
      'export * from "./star";\n',
      'export * as ns from "./ns";\n',
      "export = legacy;\n",
      "const legacy = { exp: 1 };\n",
      "function helper() { return 'é😀'; }\n",
    ];
    const random = mulberry32(0xc0ffee);
    const pairs = [...sources];
    for (let round = 0; round < 250; round += 1) {
      const count = 1 + Math.floor(random() * 3);
      const picked = Array.from({ length: count }, () => fragments[Math.floor(random() * fragments.length)]);
      pairs.push(picked.join(""));
    }

    let compared = 0;
    const differing: Array<{ file: string; source: string; without: string[]; with: string[] }> = [];
    for (const file of ["pairs.js", "pairs.ts"]) {
      for (const source of pairs) {
        if (maskJsLikeCommentsAndStrings(source).includes("exports")) continue;
        const guarded = maskJsLikeCommentsAndStrings(`${source}${inertUse}`).includes("exports");
        // A source that ends inside an unterminated comment or string swallows the use, so it cannot run the scans.
        if (!guarded) continue;
        compared += 1;
        const without = recoveredExports(file, source);
        const withScans = recoveredExports(file, `${source}${inertUse}`);
        if (JSON.stringify(without) !== JSON.stringify(withScans)) {
          differing.push({ file, source, without, with: withScans });
        }
      }
    }
    expect(differing).toEqual([]);
    expect(compared).toBeGreaterThan(200);
  });
});

describe("TypeScript value require() supplement", () => {
  function bindingLabel(binding: ImportBinding): string {
    if (binding.kind === "star") return `star<-${binding.from}`;
    const local = binding.kind === "namespace" ? binding.localNS : binding.local;
    return `${binding.kind}:${local}<-${binding.from}`;
  }

  async function bindingsOf(file: string, source: string): Promise<string[]> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-ts-require-"));
    try {
      const imports = await collectImportsForFile(path.join(root, file), root, { source });
      return imports.map(bindingLabel);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  const found: Array<{ name: string; source: string; bindings: string[] }> = [
    { name: "a default require", source: 'const dep = require("./dep");\n', bindings: ["namespace:dep<-./dep"] },
    {
      name: "a destructuring require",
      source: 'const { a, b: c } = require("./dep");\n',
      bindings: ["named:a<-./dep", "named:c<-./dep"],
    },
    {
      name: "an exported and a let require",
      source: 'export const e = require("./e");\nlet l = require("./l");\n',
      bindings: ["namespace:e<-./e", "namespace:l<-./l"],
    },
    {
      name: "a comment between the equals sign and the call",
      source: 'const x = /* c */ require("./x");\n',
      bindings: ["namespace:x<-./x"],
    },
    {
      name: "a line break before the parenthesis",
      source: 'const y = require\n("./y");\n',
      bindings: ["namespace:y<-./y"],
    },
    {
      name: "a require beside an ES import",
      source: 'import a from "./a";\nconst m = require("./m");\n',
      bindings: ["default:a<-./a", "namespace:m<-./m"],
    },
  ];
  // The word `require` appears here only in prose, comments, strings, escapes, or split across a comment.
  const absent: Array<{ name: string; source: string }> = [
    { name: "a line comment", source: '// const z = require("./z");\n' },
    { name: "a block comment", source: '/* const z = require("./z"); */\n' },
    { name: "prose", source: "// required to be fine; requirements are met\nexport const r = 1;\n" },
    { name: "a string", source: 'const s = "const q = require(\\"./q\\")";\n' },
    { name: "a template literal", source: "const s = `const q = require('./q')`;\n" },
    { name: "a Unicode escape", source: 'const w = \\u0072equire("./w");\n' },
    { name: "a comment inside the word", source: 'const v = req/**/uire("./v");\n' },
  ];

  const files = ["supplement.ts", "supplement.tsx"];

  it.each(files.flatMap((file) => found.map((entry) => ({ file, ...entry }))))(
    "binds $name in $file",
    async ({ file, source, bindings }) => {
      expect((await bindingsOf(file, source)).sort()).toEqual([...bindings].sort());
    },
  );

  it.each(files.flatMap((file) => absent.map((entry) => ({ file, ...entry }))))(
    "binds nothing for $name in $file",
    async ({ file, source }) => {
      expect(await bindingsOf(file, source)).toEqual([]);
    },
  );

  // The supplement runs when `/\brequire\s*\(/` matches the comment-stripped source. The check for the word in the
  // source itself may only skip that work if stripping comments never builds the word out of its pieces.
  it("never builds the word require out of a source that lacks it", () => {
    const fragments = [
      "req",
      "uire",
      "require",
      "r",
      "e",
      "q",
      "u",
      "i",
      "(",
      ")",
      "/* x */",
      "/**/",
      "// x\n",
      "/*",
      "*/",
      "//",
      "\n",
      "\r\n",
      " ",
      "'",
      '"',
      "`",
      "${",
      "}",
      "\\u0072",
      "\\",
      "é",
      "😀",
      "/",
      "*",
    ];
    const random = mulberry32(0x7e57);
    const explicit = [
      'req/**/uire("./x")',
      'r/* a */e/* b */q/* c */uire("./x")',
      '\\u0072equire("./x")',
      'requ\\u0069re("./x")',
      '"req" + "uire"("x")',
      '`req${""}uire`("x")',
      "re//\nquire(1)",
      "re/*\n*/quire(1)",
    ];
    const sources = [...explicit];
    for (let round = 0; round < 4000; round += 1) {
      const length = 1 + Math.floor(random() * 14);
      sources.push(Array.from({ length }, () => fragments[Math.floor(random() * fragments.length)]).join(""));
    }

    const violations = sources.filter(
      (source) => !source.includes("require") && /\brequire\s*\(/.test(stripJsLikeComments(source)),
    );
    expect(violations).toEqual([]);
    // The guard is not vacuous: sources that spell the word and the call reach the regular expression.
    expect(sources.filter((source) => /\brequire\s*\(/.test(stripJsLikeComments(source))).length).toBeGreaterThan(0);
  });
});
