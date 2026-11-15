import path from "node:path";
import { expect } from "vitest";
import { findReferences, goToDefinition } from "../../src/indexer/navigation.js";
import { SymbolKind, type ProjectIndex } from "../../src/indexer/types.js";
import { findUnusedExports } from "../../src/indexer/unused-exports.js";

/**
 * Constant reads in PHP's namespace order beside same-named decoys: another namespace's constant, a class with the
 * constant's spelling, a case variant, an import alias, a grouped `use const`, and a namespace alias. Each expectation
 * below is what the PHP 8.3 interpreter selects: `CurrentNamespace\NAME`, then the global `NAME` for an unqualified
 * name; `\NAME`, `namespace\NAME`, and qualified names have no fallback; namespace segments fold case and constant
 * names do not.
 */
export const PHP_CONSTANT_LINES: Readonly<Record<string, readonly string[]>> = {
  "consts.php": ["<?php", "const LIMIT = 10;", "const GLOBAL_LIMIT = 11;", "const NEVER_READ = 12;"],
  "app.php": ["<?php", "namespace App;", "const LIMIT = 1;", "function inApp() { return LIMIT; }"],
  "other.php": ["<?php", "namespace Other;", "const LIMIT = 2;", "const ONLY_OTHER = 3;"],
  "deep.php": ["<?php", "namespace Other\\Deep;", "const LIMIT = 4;", "const MAX = 5;", "const MIN = 6;"],
  "braced.php": [
    "<?php",
    "namespace Br {",
    "  const BR = 7;",
    "  function inBr() { return BR; }",
    "}",
    "namespace {",
    "  const GL = 8;",
    "  function inGl() { return GL; }",
    "}",
  ],
  "reader.php": [
    "<?php",
    "namespace App;",
    "function fromApp() { return LIMIT; }",
    "function fromGlobal() { return GLOBAL_LIMIT; }",
    "function rooted() { return \\Other\\LIMIT; }",
    "function qualified() { return \\App\\LIMIT; }",
    "function relative() { return namespace\\LIMIT; }",
    "function defaults($n = LIMIT) { return $n < GLOBAL_LIMIT; }",
  ],
  "imported.php": ["<?php", "namespace Imported;", "use const Other\\LIMIT;", "function read() { return LIMIT; }"],
  "forms.php": [
    "<?php",
    "namespace Forms;",
    "use const Other\\Deep\\LIMIT as L;",
    "use const Other\\Deep\\{MAX, MIN as LOW};",
    "use Other\\Deep as OD;",
    "function aliased() { return L; }",
    "function grouped() { return MAX + LOW; }",
    "function namespaceAlias() { return OD\\LIMIT; }",
    "function caseFolded() { return \\other\\deep\\LIMIT; }",
    "function caseExact() { return \\Other\\Deep\\limit; }",
    "function notImported() { return MIN; }",
  ],
  "decoy.php": [
    "<?php",
    "namespace Decoy;",
    "const Foo = 1;",
    "class Foo extends \\Exception {}",
    "class Child extends Foo {}",
    "function check($x) {",
    "  try { new Foo(); } catch (Foo $e) { }",
    "  return $x instanceof Foo ? Foo : 0;",
    "}",
    "function typed(Foo $f) { return $f; }",
  ],
  "third.php": [
    "<?php",
    "namespace Third;",
    "function readLimit() { return LIMIT; }",
    "function readForeign() { return ONLY_OTHER; }",
  ],
};

export const PHP_CONSTANT_FILES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PHP_CONSTANT_LINES).map(([file, rows]) => [file, rows.join("\n")]),
);

/** Two declarations of one global constant, a reader that cannot tell them apart, and one that requires `b.php`. */
export const PHP_COMPETING_CONSTANT_LINES: Readonly<Record<string, readonly string[]>> = {
  "a.php": ["<?php", "const LIMIT = 1;"],
  "b.php": ["<?php", "const LIMIT = 2;"],
  "reader.php": ["<?php", "function read() { return LIMIT; }"],
  "required.php": ["<?php", "require __DIR__ . '/b.php';", "function readRequired() { return LIMIT; }"],
};

export const PHP_COMPETING_CONSTANT_FILES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PHP_COMPETING_CONSTANT_LINES).map(([file, rows]) => [file, rows.join("\n")]),
);

/** The line and column of `token` on a 1-based line, at its first or last occurrence. */
function locate(
  lines: Readonly<Record<string, readonly string[]>>,
  file: string,
  line: number,
  token: string,
  last = false,
): { line: number; column: number } {
  const text = lines[file]?.[line - 1] ?? "";
  const at = last ? text.lastIndexOf(token) : text.indexOf(token);
  if (at < 0) throw new Error(`${token} not found on ${file}:${line}: ${text}`);
  return { line, column: at + 1 };
}

/** The answer a goto gives as `file:line`, or its status when nothing is found. */
async function gotoAnswer(index: ProjectIndex, file: string, position: { line: number; column: number }) {
  const result = await goToDefinition(index, { file, ...position });
  if (result.status !== "ok") return result.status;
  return `${path.basename(result.definition.file)}:${result.definition.range.start.line}`;
}

type ConstantGotoCase = readonly [file: string, line: number, token: string, last: boolean, expected: string];

const CONSTANT_GOTO_CASES: readonly ConstantGotoCase[] = [
  ["reader.php", 3, "LIMIT", false, "app.php:3"],
  ["reader.php", 4, "GLOBAL_LIMIT", false, "consts.php:3"],
  ["reader.php", 5, "LIMIT", true, "other.php:3"],
  ["reader.php", 6, "LIMIT", true, "app.php:3"],
  ["reader.php", 7, "LIMIT", true, "app.php:3"],
  ["reader.php", 8, "LIMIT", false, "app.php:3"],
  ["imported.php", 4, "LIMIT", false, "other.php:3"],
  // An unqualified constant falls back to the global namespace, never to a constant of an unrelated one.
  ["third.php", 3, "LIMIT", false, "consts.php:2"],
  ["third.php", 4, "ONLY_OTHER", false, "not_found"],
  ["forms.php", 6, "L;", false, "deep.php:3"],
  ["forms.php", 7, "MAX", false, "deep.php:4"],
  ["forms.php", 7, "LOW", false, "deep.php:5"],
  ["forms.php", 8, "LIMIT", true, "deep.php:3"],
  ["forms.php", 9, "LIMIT", true, "deep.php:3"],
  ["forms.php", 10, "limit", true, "not_found"],
  ["forms.php", 11, "MIN", false, "not_found"],
  ["braced.php", 4, "BR", false, "braced.php:3"],
  ["braced.php", 8, "GL", false, "braced.php:7"],
  // A class named like the constant keeps every class position; only the expression read is the constant.
  ["decoy.php", 8, "Foo", true, "decoy.php:3"],
  ["decoy.php", 5, "Foo", true, "decoy.php:4"],
  ["decoy.php", 7, "Foo", false, "decoy.php:4"],
  ["decoy.php", 8, "Foo", false, "decoy.php:4"],
];

export async function expectPhpConstantGoto(index: ProjectIndex, paths: Record<string, string>): Promise<void> {
  for (const [file, line, token, last, expected] of CONSTANT_GOTO_CASES) {
    const answer = await gotoAnswer(index, paths[file]!, locate(PHP_CONSTANT_LINES, file, line, token, last));
    expect(answer, `${file}:${line} ${token}`).toBe(expected);
  }
}

type ConstantReferencesCase = readonly [file: string, line: number, token: string, sites: readonly string[]];

const CONSTANT_REFERENCES_CASES: readonly ConstantReferencesCase[] = [
  ["app.php", 3, "LIMIT", ["app.php:3", "app.php:4", "reader.php:3", "reader.php:6", "reader.php:7", "reader.php:8"]],
  ["other.php", 3, "LIMIT", ["imported.php:3", "imported.php:4", "other.php:3", "reader.php:5"]],
  ["consts.php", 2, "LIMIT", ["consts.php:2", "third.php:3"]],
  ["consts.php", 3, "GLOBAL_LIMIT", ["consts.php:3", "reader.php:4", "reader.php:8"]],
  ["other.php", 4, "ONLY_OTHER", ["other.php:4"]],
  // An import clause lists the imported name and its alias, and a read through the alias is a reference.
  ["deep.php", 3, "LIMIT", ["deep.php:3", "forms.php:3", "forms.php:3", "forms.php:6", "forms.php:8", "forms.php:9"]],
  ["deep.php", 4, "MAX", ["deep.php:4", "forms.php:4", "forms.php:7"]],
  ["deep.php", 5, "MIN", ["deep.php:5", "forms.php:4", "forms.php:4", "forms.php:7"]],
  ["braced.php", 3, "BR", ["braced.php:3", "braced.php:4"]],
  ["braced.php", 7, "GL", ["braced.php:7", "braced.php:8"]],
  // The class positions that spell `Foo` are not references of the constant.
  ["decoy.php", 3, "Foo", ["decoy.php:3", "decoy.php:8"]],
];

export async function expectPhpConstantReferences(index: ProjectIndex, paths: Record<string, string>): Promise<void> {
  const observed: Array<[string, readonly string[], string]> = [];
  for (const [file, line, token] of CONSTANT_REFERENCES_CASES) {
    const result = await findReferences(index, {
      file: paths[file]!,
      ...locate(PHP_CONSTANT_LINES, file, line, token),
    });
    if (result.status !== "ok") throw new Error(`Expected references for ${file}:${line}`);
    const sites = result.references.map((site) => `${path.basename(site.file)}:${site.range.start.line}`).sort();
    observed.push([`${file}:${line}`, sites, result.referenceCoverage.state]);
  }
  expect(observed).toEqual(
    CONSTANT_REFERENCES_CASES.map(([file, line, , sites]) => [`${file}:${line}`, [...sites].sort(), "complete"]),
  );
}

/** A used constant is never reported; one that nothing reads still is. */
export async function expectPhpConstantUnused(index: ProjectIndex): Promise<void> {
  const unused = await findUnusedExports(index);
  expect(
    unused
      .filter((candidate) => candidate.kind === SymbolKind.Variable)
      .map((candidate) => candidate.name)
      .sort(),
  ).toEqual(["NEVER_READ", "ONLY_OTHER"]);
}

/** Competing declarations leave the read unresolved with partial coverage, so none is reported unused. */
export async function expectPhpCompetingConstants(index: ProjectIndex, paths: Record<string, string>): Promise<void> {
  const open = await goToDefinition(index, {
    file: paths["reader.php"]!,
    ...locate(PHP_COMPETING_CONSTANT_LINES, "reader.php", 2, "LIMIT"),
  });
  expect(open.status).toBe("not_found");
  expect(open.status === "not_found" ? open.reason : "").toBe("Ambiguous PHP constant");
  // The file that requires one of them reads that one.
  const required = await gotoAnswer(
    index,
    paths["required.php"]!,
    locate(PHP_COMPETING_CONSTANT_LINES, "required.php", 3, "LIMIT"),
  );
  expect(required).toBe("b.php:2");
  for (const file of ["a.php", "b.php"]) {
    const result = await findReferences(index, {
      file: paths[file]!,
      ...locate(PHP_COMPETING_CONSTANT_LINES, file, 2, "LIMIT"),
    });
    expect(result.status).toBe("ok");
    expect(result.status === "ok" ? result.referenceCoverage.state : "").toBe("partial");
  }
  const unused = await findUnusedExports(index);
  expect(unused.filter((candidate) => candidate.name === "LIMIT")).toEqual([]);
}
