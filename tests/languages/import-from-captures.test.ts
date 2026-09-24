import { describe, expect, it } from "vitest";
import { collectModuleSpecifiersFromSource } from "../../src/graphs.js";
import { PHP_SUPPORT, PY_SUPPORT } from "../../src/languages.js";
import { getNativeQueryExecution } from "../../src/native/tree-sitter-native.js";
import { unquote } from "../../src/util/ast.js";

function nativeFromCaptures(source: string, support: typeof PHP_SUPPORT): string[] {
  const matches = getNativeQueryExecution(source, support).results?.imports ?? [];
  const names = new Set<string>();
  const from: string[] = [];
  for (const match of matches) {
    for (const capture of match.captures) names.add(capture.name);
    const pathCapture = match.captures.find((capture) => capture.name === "from");
    if (pathCapture) from.push(unquote(pathCapture.text));
  }
  expect(names.has("mod")).toBe(false);
  return from;
}

describe("native import specifiers from @from", () => {
  it("takes Python module specifiers from the path-bearing capture", () => {
    const source = [
      "import os",
      "import os.path as p",
      "from pkg.sub import x",
      "from .rel import y",
      "from pkg import *",
      "from __future__ import annotations",
      "",
    ].join("\n");
    const captured = nativeFromCaptures(source, PY_SUPPORT);
    expect(captured).toEqual(["os", "os.path", "pkg.sub", ".rel", "pkg"]);
    const nativeQueries = getNativeQueryExecution(source, PY_SUPPORT).results;
    const specs = collectModuleSpecifiersFromSource(PY_SUPPORT, source, { nativeQueries }).map((entry) => entry.spec);
    for (const spec of captured) expect(specs).toContain(spec);
    expect(specs).toContain("__future__");
    const futureMatch = (nativeQueries?.imports ?? []).find((match) =>
      match.captures.some((capture) => capture.name === "stmt" && capture.text.includes("__future__")),
    );
    expect(futureMatch?.captures.some((capture) => capture.name === "from")).toBe(false);
  });

  it("takes PHP require and use specifiers from the path-bearing capture", () => {
    const source = [
      "<?php",
      'require "a.php";',
      "include 'b.php';",
      "use Foo\\Bar;",
      "use Foo\\Bar as Baz;",
      "use Foo;",
      "",
    ].join("\n");
    const captured = nativeFromCaptures(source, PHP_SUPPORT);
    expect(captured).toEqual(["a.php", "b.php", "Foo\\Bar", "Foo\\Bar", "Foo"]);
    const nativeQueries = getNativeQueryExecution(source, PHP_SUPPORT).results;
    const specs = collectModuleSpecifiersFromSource(PHP_SUPPORT, source, { nativeQueries }).map((entry) => entry.spec);
    for (const spec of captured) expect(specs).toContain(spec);
  });

  it("keeps same-spelled PHP imports from separate symbol namespaces", () => {
    const source = ["<?php", "use App\\Shared;", "use function App\\Shared;", "use const App\\Shared;", ""].join("\n");
    const nativeQueries = getNativeQueryExecution(source, PHP_SUPPORT).results;
    const imports = collectModuleSpecifiersFromSource(PHP_SUPPORT, source, { nativeQueries })
      .filter((entry) => entry.spec === "App\\Shared")
      .map((entry) => entry.phpImportType)
      .sort();

    expect(imports).toEqual(["class", "const", "function"]);
  });
});
