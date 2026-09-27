import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildProjectIndex, buildSymbolGraphDetailed, findReferences, goToDefinition } from "../src/index.js";
import type { ProjectIndex } from "../src/indexer/types.js";
import type { SymbolGraph } from "../src/graphs/symbol-graph.js";
import { normalizePath } from "../src/util/paths.js";
import { columnOf, writeFixtureFiles } from "./languages/callable-consumer-fixtures.js";

async function withProject(
  prefix: string,
  files: Readonly<Record<string, string>>,
  run: (paths: Record<string, string>, index: ProjectIndex) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    const paths = await writeFixtureFiles(root, files);
    const index = await buildProjectIndex(root, { cache: "off" });
    await run(paths, index);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sourceFiles(files: Readonly<Record<string, readonly string[]>>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([file, lines]) => [file, `${lines.join("\n")}\n`]));
}

async function expectDefinition(
  index: ProjectIndex,
  file: string,
  lines: readonly string[],
  line: number,
  token: string,
  definitionFile: string,
  definitionLine: number,
): Promise<void> {
  const goto = await goToDefinition(index, { file, line, column: columnOf(lines, line, token) });
  expect(goto.status, `${file}:${line} ${token}`).toBe("ok");
  if (goto.status !== "ok") throw new Error(`${token} did not resolve`);
  expect(normalizePath(goto.definition.file)).toBe(definitionFile);
  expect(goto.definition.range.start.line).toBe(definitionLine);
}

async function expectUnresolved(
  index: ProjectIndex,
  file: string,
  lines: readonly string[],
  line: number,
  token: string,
): Promise<void> {
  const goto = await goToDefinition(index, { file, line, column: columnOf(lines, line, token) });
  expect(goto.status, `${file}:${line} ${token} must not resolve across files`).toBe("not_found");
}

function graphNode(graph: SymbolGraph, file: string, name: string): string {
  const matches = [...graph.nodes.values()].filter((node) => node.name === name && normalizePath(node.file) === file);
  expect(matches, `${name} in ${file}`).toHaveLength(1);
  return matches[0]!.id;
}

function edgeTargets(graph: SymbolGraph, fromId: string, label: string): Array<{ name: string; file: string }> {
  const targets: Array<{ name: string; file: string }> = [];
  for (const edge of graph.edges) {
    if (edge.from !== fromId || edge.label !== label) continue;
    const node = graph.nodes.get(edge.to);
    if (node) targets.push({ name: node.name, file: normalizePath(node.file) });
  }
  return targets;
}

describe("same-unit peers without an import", () => {
  it("resolves Java same-package types and constructed members, not another package or a private method", async () => {
    const fooLines = [
      "package p;",
      "",
      "public class Foo {",
      '  public String hello() { return "hi"; }',
      '  String pack() { return "p"; }',
      '  private String secret() { return "no"; }',
      "}",
    ];
    const barLines = [
      "package p;",
      "",
      "public class Bar {",
      "  public Foo typed() {",
      "    return new Foo();",
      "  }",
      "  public String direct() {",
      "    return new Foo().hello();",
      "  }",
      "  public String packed() {",
      "    return new Foo().pack();",
      "  }",
      "  public String hidden() {",
      "    return new Foo().secret();",
      "  }",
      "}",
    ];
    const decoyLines = [
      "package q;",
      "",
      "public class Foo {",
      '  public String hello() { return "no"; }',
      '  String pack() { return "q"; }',
      "}",
    ];
    await withProject(
      "cg-peers-java-",
      sourceFiles({
        "p/Foo.java": fooLines,
        "p/Bar.java": barLines,
        "q/Foo.java": decoyLines,
      }),
      async (paths, index) => {
        const fooPath = paths["p/Foo.java"]!;
        const barPath = paths["p/Bar.java"]!;
        const decoyPath = paths["q/Foo.java"]!;
        await expectDefinition(index, barPath, barLines, 4, "Foo", fooPath, 3);
        await expectDefinition(index, barPath, barLines, 5, "Foo", fooPath, 3);
        await expectDefinition(index, barPath, barLines, 8, "hello", fooPath, 4);
        await expectDefinition(index, barPath, barLines, 11, "pack", fooPath, 5);
        await expectUnresolved(index, barPath, barLines, 14, "secret");

        const references = await findReferences(index, {
          file: fooPath,
          line: 4,
          column: columnOf(fooLines, 4, "hello"),
        });
        expect(references.status).toBe("ok");
        if (references.status !== "ok") throw new Error("hello references did not resolve");
        const sites = references.references.map(
          (reference) => `${normalizePath(reference.file)}:${reference.range.start.line}`,
        );
        expect(sites).toContain(`${barPath}:8`);
        expect(references.references.some((reference) => normalizePath(reference.file) === decoyPath)).toBe(false);
        expect(references.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });

        const graph = await buildSymbolGraphDetailed(index);
        const direct = graphNode(graph, barPath, "direct");
        const packed = graphNode(graph, barPath, "packed");
        const hidden = graphNode(graph, barPath, "hidden");
        expect(edgeTargets(graph, direct, "calls")).toContainEqual({ name: "hello", file: fooPath });
        expect(edgeTargets(graph, direct, "calls").some((target) => target.file === decoyPath)).toBe(false);
        expect(edgeTargets(graph, packed, "calls")).toContainEqual({ name: "pack", file: fooPath });
        expect(edgeTargets(graph, hidden, "calls").some((target) => target.name === "secret")).toBe(false);
      },
    );
  });

  it("resolves Kotlin same-package constructed members and hides private and internal methods", async () => {
    const fooLines = [
      "package p",
      "",
      "class Foo {",
      '  fun hello(): String = "hi"',
      '  private fun secret(): String = "no"',
      '  internal fun inside(): String = "no"',
      "}",
    ];
    const barLines = [
      "package p",
      "",
      "class Bar {",
      "  fun typed(): Foo {",
      "    return Foo()",
      "  }",
      "  fun direct(): String {",
      "    return Foo().hello()",
      "  }",
      "  fun hidden(): String {",
      "    return Foo().secret()",
      "  }",
      "  fun moduleOnly(): String {",
      "    return Foo().inside()",
      "  }",
      "}",
    ];
    const decoyLines = ["package q", "", "class Foo {", '  fun hello(): String = "no"', "}"];
    await withProject(
      "cg-peers-kotlin-",
      sourceFiles({
        "p/Foo.kt": fooLines,
        "p/Bar.kt": barLines,
        "q/Foo.kt": decoyLines,
      }),
      async (paths, index) => {
        const fooPath = paths["p/Foo.kt"]!;
        const barPath = paths["p/Bar.kt"]!;
        const decoyPath = paths["q/Foo.kt"]!;
        await expectDefinition(index, barPath, barLines, 4, "Foo", fooPath, 3);
        await expectDefinition(index, barPath, barLines, 8, "hello", fooPath, 4);
        await expectUnresolved(index, barPath, barLines, 11, "secret");
        await expectUnresolved(index, barPath, barLines, 14, "inside");

        const references = await findReferences(index, {
          file: fooPath,
          line: 4,
          column: columnOf(fooLines, 4, "hello"),
        });
        expect(references.status).toBe("ok");
        if (references.status !== "ok") throw new Error("hello references did not resolve");
        const sites = references.references.map(
          (reference) => `${normalizePath(reference.file)}:${reference.range.start.line}`,
        );
        expect(sites).toContain(`${barPath}:8`);
        expect(references.references.some((reference) => normalizePath(reference.file) === decoyPath)).toBe(false);
        expect(references.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });

        const graph = await buildSymbolGraphDetailed(index);
        const direct = graphNode(graph, barPath, "direct");
        const hidden = graphNode(graph, barPath, "hidden");
        const moduleOnly = graphNode(graph, barPath, "moduleOnly");
        expect(edgeTargets(graph, direct, "calls")).toContainEqual({ name: "hello", file: fooPath });
        expect(edgeTargets(graph, direct, "calls").some((target) => target.file === decoyPath)).toBe(false);
        expect(edgeTargets(graph, hidden, "calls").some((target) => target.name === "secret")).toBe(false);
        expect(edgeTargets(graph, moduleOnly, "calls").some((target) => target.name === "inside")).toBe(false);
      },
    );
  });

  it("resolves Swift same-directory constructed members and hides private and fileprivate methods", async () => {
    const fooLines = [
      "class Foo {",
      '  func hello() -> String { return "hi" }',
      '  private func secret() -> String { return "no" }',
      '  fileprivate func localOnly() -> String { return "no" }',
      "}",
    ];
    const barLines = [
      "class Bar {",
      "  func typed() -> Foo {",
      "    return Foo()",
      "  }",
      "  func direct() -> String {",
      "    return Foo().hello()",
      "  }",
      "  func hidden() -> String {",
      "    return Foo().secret()",
      "  }",
      "  func fileHidden() -> String {",
      "    return Foo().localOnly()",
      "  }",
      "}",
    ];
    const decoyLines = ["class Foo {", '  func hello() -> String { return "no" }', "}"];
    await withProject(
      "cg-peers-swift-",
      sourceFiles({
        "Foo.swift": fooLines,
        "Bar.swift": barLines,
      }),
      async (paths, index) => {
        const fooPath = paths["Foo.swift"]!;
        const barPath = paths["Bar.swift"]!;
        await expectDefinition(index, barPath, barLines, 2, "Foo", fooPath, 1);
        await expectDefinition(index, barPath, barLines, 6, "hello", fooPath, 2);
        await expectUnresolved(index, barPath, barLines, 9, "secret");
        await expectUnresolved(index, barPath, barLines, 12, "localOnly");

        const references = await findReferences(index, {
          file: fooPath,
          line: 2,
          column: columnOf(fooLines, 2, "hello"),
        });
        expect(references.status).toBe("ok");
        if (references.status !== "ok") throw new Error("hello references did not resolve");
        const sites = references.references.map(
          (reference) => `${normalizePath(reference.file)}:${reference.range.start.line}`,
        );
        expect(sites).toContain(`${barPath}:6`);
        expect(references.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });

        const graph = await buildSymbolGraphDetailed(index);
        const direct = graphNode(graph, barPath, "direct");
        const hidden = graphNode(graph, barPath, "hidden");
        const fileHidden = graphNode(graph, barPath, "fileHidden");
        expect(edgeTargets(graph, direct, "calls")).toContainEqual({ name: "hello", file: fooPath });
        expect(edgeTargets(graph, hidden, "calls").some((target) => target.name === "secret")).toBe(false);
        expect(edgeTargets(graph, fileHidden, "calls").some((target) => target.name === "localOnly")).toBe(false);
      },
    );
    // A second directory is a different Swift unit, but without a package manifest the module
    // boundary is unproven, so coverage stays partial. Resolution must still ignore that Foo.
    await withProject(
      "cg-peers-swift-decoy-",
      sourceFiles({
        "Foo.swift": fooLines,
        "Bar.swift": barLines,
        "other/Foo.swift": decoyLines,
      }),
      async (paths, index) => {
        const fooPath = paths["Foo.swift"]!;
        const barPath = paths["Bar.swift"]!;
        const decoyPath = paths["other/Foo.swift"]!;
        await expectDefinition(index, barPath, barLines, 6, "hello", fooPath, 2);
        const references = await findReferences(index, {
          file: fooPath,
          line: 2,
          column: columnOf(fooLines, 2, "hello"),
        });
        expect(references.status).toBe("ok");
        if (references.status !== "ok") throw new Error("hello references did not resolve");
        expect(references.references.some((reference) => normalizePath(reference.file) === decoyPath)).toBe(false);
        const graph = await buildSymbolGraphDetailed(index);
        const direct = graphNode(graph, barPath, "direct");
        expect(edgeTargets(graph, direct, "calls").some((target) => target.file === decoyPath)).toBe(false);
      },
    );
  });

  it("resolves PHP same-namespace extends, trait use, new, static calls, and parent::", async () => {
    const baseLines = [
      "<?php",
      "namespace Acme\\App;",
      "",
      "class Base",
      "{",
      "    public function greet(): string",
      "    {",
      '        return "hi";',
      "    }",
      "",
      "    public static function make(): Base",
      "    {",
      "        return new Base();",
      "    }",
      "}",
    ];
    const greetableLines = [
      "<?php",
      "namespace Acme\\App;",
      "",
      "trait Greetable",
      "{",
      "    public function wave(): string",
      "    {",
      '        return "wave";',
      "    }",
      "}",
    ];
    const workerLines = [
      "<?php",
      "namespace Acme\\App;",
      "",
      "class Worker extends Base",
      "{",
      "    use Greetable;",
      "",
      "    public function run(): string",
      "    {",
      "        $made = Base::make();",
      "        $fresh = new Base();",
      "        return parent::greet();",
      "    }",
      "}",
    ];
    const decoyLines = [
      "<?php",
      "namespace Other\\Ns;",
      "",
      "class Base",
      "{",
      "    public function greet(): string",
      "    {",
      '        return "no";',
      "    }",
      "}",
    ];
    await withProject(
      "cg-peers-php-",
      sourceFiles({
        "Base.php": baseLines,
        "Greetable.php": greetableLines,
        "Worker.php": workerLines,
        "Other.php": decoyLines,
      }),
      async (paths, index) => {
        const basePath = paths["Base.php"]!;
        const greetablePath = paths["Greetable.php"]!;
        const workerPath = paths["Worker.php"]!;
        const decoyPath = paths["Other.php"]!;
        await expectDefinition(index, workerPath, workerLines, 4, "Base", basePath, 4);
        await expectDefinition(index, workerPath, workerLines, 6, "Greetable", greetablePath, 4);
        await expectDefinition(index, workerPath, workerLines, 10, "Base", basePath, 4);
        await expectDefinition(index, workerPath, workerLines, 10, "make", basePath, 11);
        await expectDefinition(index, workerPath, workerLines, 11, "Base", basePath, 4);
        await expectDefinition(index, workerPath, workerLines, 12, "greet", basePath, 6);

        const references = await findReferences(index, {
          file: basePath,
          line: 4,
          column: columnOf(baseLines, 4, "Base"),
        });
        expect(references.status).toBe("ok");
        if (references.status !== "ok") throw new Error("Base references did not resolve");
        const sites = references.references.map(
          (reference) => `${normalizePath(reference.file)}:${reference.range.start.line}`,
        );
        expect(sites).toContain(`${workerPath}:4`);
        expect(sites).toContain(`${workerPath}:10`);
        expect(sites).toContain(`${workerPath}:11`);
        expect(references.references.some((reference) => normalizePath(reference.file) === decoyPath)).toBe(false);
        expect(references.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });

        const graph = await buildSymbolGraphDetailed(index);
        const worker = graphNode(graph, workerPath, "Worker");
        const run = graphNode(graph, workerPath, "run");
        expect(edgeTargets(graph, worker, "extends")).toContainEqual({ name: "Base", file: basePath });
        expect(edgeTargets(graph, worker, "extends").some((target) => target.file === decoyPath)).toBe(false);
        expect(edgeTargets(graph, worker, "trait")).toContainEqual({ name: "Greetable", file: greetablePath });
        expect(edgeTargets(graph, run, "instantiates")).toContainEqual({ name: "Base", file: basePath });
        expect(edgeTargets(graph, run, "calls")).toContainEqual({ name: "make", file: basePath });
        expect(edgeTargets(graph, run, "calls")).toContainEqual({ name: "greet", file: basePath });
        expect(edgeTargets(graph, run, "calls").some((target) => target.file === decoyPath)).toBe(false);
      },
    );
  });
});
