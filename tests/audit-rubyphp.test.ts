import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed, type DetailedSymbolGraph } from "../src/graphs/symbol-graph-detailed.js";
import { buildProjectIndex, findReferences, goToDefinition } from "../src/index.js";
import type { ProjectIndex } from "../src/indexer/types.js";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function project(prefix: string, files: Record<string, string>): Promise<{ root: string; index: ProjectIndex }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  for (const [file, source] of Object.entries(files)) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source, "utf8");
  }
  const index = await buildProjectIndex(root, { cache: "off", native: "on" });
  return { root, index };
}

function at(source: string, phrase: string, token = phrase, occurrence = 0): { line: number; column: number } {
  let from = 0;
  let phraseAt = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    phraseAt = source.indexOf(phrase, from);
    if (phraseAt < 0) throw new Error(`missing ${phrase}`);
    from = phraseAt + phrase.length;
  }
  const tokenOffset = phrase.indexOf(token);
  if (tokenOffset < 0) throw new Error(`missing ${token} in ${phrase}`);
  const start = phraseAt + tokenOffset;
  const prefix = source.slice(0, start);
  const line = prefix.split("\n").length;
  const column = start - prefix.lastIndexOf("\n");
  return { line, column };
}

function fileIn(root: string, name: string): string {
  return path.join(root, name);
}

function baseName(file: string): string {
  return path.basename(file);
}

describe("Ruby and PHP audit fixes", () => {
  it("resolves Ruby Klass.new across a required file and ignores an unrequired decoy", async () => {
    const widget = ["class Widget", "  def render", "  end", "end", ""].join("\n");
    const decoy = ["class Widget", "  def render", "  end", "end", ""].join("\n");
    const use = [
      "class Other",
      "  def render",
      "  end",
      "end",
      'require_relative "widget"',
      "def run",
      "  w = Widget.new",
      "  w.render",
      "end",
      "",
    ].join("\n");
    const { root, index } = await project("cg-audit-w13-", {
      "widget.rb": widget,
      "decoy.rb": decoy,
      "use.rb": use,
    });
    const useFile = fileIn(root, "use.rb");
    const renderAt = at(use, "w.render", "render");
    const bareAt = at(use, "Widget.new", "Widget");
    const member = await goToDefinition(index, { file: useFile, ...renderAt });
    const bare = await goToDefinition(index, { file: useFile, ...bareAt });
    expect(member.status).toBe("ok");
    expect(bare.status).toBe("ok");
    if (member.status !== "ok" || bare.status !== "ok") return;
    expect(baseName(member.definition.file)).toBe("widget.rb");
    expect(member.definition.range.start.line).toBe(2);
    expect(baseName(bare.definition.file)).toBe("widget.rb");
    expect(bare.definition.range.start.line).toBe(1);
    expect(baseName(member.definition.file)).not.toBe("decoy.rb");

    const widgetFile = fileIn(root, "widget.rb");
    const references = await findReferences(index, { file: widgetFile, ...at(widget, "def render", "render") });
    expect(references.status).toBe("ok");
    if (references.status !== "ok") return;
    expect(references.referenceCoverage.state).toBe("complete");
    const useLines = references.references
      .filter((reference) => baseName(reference.file) === "use.rb")
      .map((reference) => reference.range.start.line);
    expect(useLines).toContain(renderAt.line);
    expect(references.references.some((reference) => baseName(reference.file) === "decoy.rb")).toBe(false);

    const graph = await buildSymbolGraphDetailed(index);
    const run = functionNode(graph, "use.rb", "run");
    const widgetRender = functionNode(graph, "widget.rb", "render");
    const decoyRender = functionNode(graph, "decoy.rb", "render");
    const otherRender = functionNode(graph, "use.rb", "render");
    expect(edgeBetween(graph, run, widgetRender, "calls")).toBe(true);
    expect(edgeBetween(graph, run, decoyRender, "calls")).toBe(false);
    expect(edgeBetween(graph, run, otherRender, "calls")).toBe(false);
    const widgetClass = typeNode(graph, "widget.rb", "Widget");
    expect(edgeBetween(graph, run, widgetClass, "instantiates")).toBe(true);
  });

  it("prefers a same-file Ruby class over a required one and does not search the whole project", async () => {
    const widget = ["class Widget", "  def render", "  end", "end", ""].join("\n");
    const same = [
      'require_relative "widget"',
      "class Widget",
      "  def render",
      "  end",
      "  def run",
      "    w = Widget.new",
      "    w.render",
      "  end",
      "end",
      "",
    ].join("\n");
    const orphan = ["def run", "  w = Widget.new", "  w.render", "end", ""].join("\n");
    const { root, index } = await project("cg-audit-w13-local-", {
      "widget.rb": widget,
      "same.rb": same,
      "orphan.rb": orphan,
    });
    const sameFile = fileIn(root, "same.rb");
    const sameGoto = await goToDefinition(index, { file: sameFile, ...at(same, "w.render", "render") });
    expect(sameGoto.status).toBe("ok");
    if (sameGoto.status !== "ok") return;
    expect(baseName(sameGoto.definition.file)).toBe("same.rb");
    expect(sameGoto.definition.range.start.line).toBe(3);

    const orphanFile = fileIn(root, "orphan.rb");
    const orphanGoto = await goToDefinition(index, { file: orphanFile, ...at(orphan, "w.render", "render") });
    expect(orphanGoto.status).toBe("not_found");
  });

  it("resolves PHP new self, static, and parent, and leaves an unproven parent unresolved", async () => {
    const source = [
      "<?php",
      "class ParentDecoy {}",
      "class Base {",
      "  function __construct() {}",
      "}",
      "class Child extends Base {",
      "  function makeSelf() { return new self(); }",
      "  function makeStatic() { return new static(); }",
      "  function makeParent() { return new parent(); }",
      "  function makeFolded() { return new SELF(); }",
      "}",
      "class Orphan {",
      "  function makeParent() { return new parent(); }",
      "}",
      "function outside() { return new self(); }",
      "",
    ].join("\n");
    const { root, index } = await project("cg-audit-h8-", { "box.php": source });
    const file = fileIn(root, "box.php");
    const selfGoto = await goToDefinition(index, { file, ...at(source, "new self()", "self") });
    const staticGoto = await goToDefinition(index, { file, ...at(source, "new static()", "static") });
    const parentGoto = await goToDefinition(index, { file, ...at(source, "new parent()", "parent") });
    const foldedGoto = await goToDefinition(index, { file, ...at(source, "new SELF()", "SELF") });
    const orphanGoto = await goToDefinition(index, {
      file,
      ...at(source, "return new parent();", "parent", 1),
    });
    const outsideGoto = await goToDefinition(index, {
      file,
      ...at(source, "function outside() { return new self(); }", "self"),
    });
    expect(selfGoto.status).toBe("ok");
    expect(staticGoto.status).toBe("ok");
    expect(parentGoto.status).toBe("ok");
    expect(foldedGoto.status).toBe("ok");
    if (
      selfGoto.status !== "ok" ||
      staticGoto.status !== "ok" ||
      parentGoto.status !== "ok" ||
      foldedGoto.status !== "ok"
    ) {
      return;
    }
    expect(selfGoto.definition.range.start.line).toBe(6);
    expect(staticGoto.definition.range.start.line).toBe(6);
    expect(foldedGoto.definition.range.start.line).toBe(6);
    expect(parentGoto.definition.range.start.line).toBe(3);
    expect(parentGoto.definition.range.start.line).not.toBe(2);
    expect(orphanGoto.status).toBe("not_found");
    expect(outsideGoto.status).toBe("not_found");

    const graph = await buildSymbolGraphDetailed(index);
    const child = typeNode(graph, "box.php", "Child");
    const base = typeNode(graph, "box.php", "Base");
    const decoy = typeNode(graph, "box.php", "ParentDecoy");
    expect(edgeBetween(graph, functionNode(graph, "box.php", "makeSelf"), child, "instantiates")).toBe(true);
    expect(edgeBetween(graph, functionNode(graph, "box.php", "makeStatic"), child, "instantiates")).toBe(true);
    expect(edgeBetween(graph, functionNode(graph, "box.php", "makeStatic"), base, "instantiates")).toBe(false);
    const childParent = methodOf(graph, "box.php", "Child", "makeParent");
    expect(edgeBetween(graph, childParent, base, "instantiates")).toBe(true);
    expect(edgeBetween(graph, childParent, decoy, "instantiates")).toBe(false);
    expect(edgeBetween(graph, childParent, child, "instantiates")).toBe(false);
    const orphanMethod = methodOf(graph, "box.php", "Orphan", "makeParent");
    expect(graph.edges.some((edge) => edge.label === "instantiates" && edge.from === orphanMethod)).toBe(false);
    const outside = functionNode(graph, "box.php", "outside");
    expect(graph.edges.some((edge) => edge.label === "instantiates" && edge.from === outside)).toBe(false);
  });

  it("resolves a PHP base to the namespace class instead of a same-named local function", async () => {
    const base = ["<?php", "namespace Acme;", "class Base {}", ""].join("\n");
    const child = ["<?php", "namespace Acme;", "function Base() {}", "class Child extends Base {}", ""].join("\n");
    const orphan = ["<?php", "namespace Unrelated;", "function Base() {}", "class Orphan extends Base {}", ""].join(
      "\n",
    );
    const { root, index } = await project("cg-audit-php-class-role-", {
      "base.php": base,
      "child.php": child,
      "orphan.php": orphan,
    });
    const resolved = await goToDefinition(index, {
      file: fileIn(root, "child.php"),
      ...at(child, "extends Base", "Base"),
    });
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok") return;
    expect(baseName(resolved.definition.file)).toBe("base.php");
    expect(resolved.definition.range.start.line).toBe(3);
    const unresolved = await goToDefinition(index, {
      file: fileIn(root, "orphan.php"),
      ...at(orphan, "extends Base", "Base"),
    });
    expect(unresolved.status).toBe("not_found");

    const graph = await buildSymbolGraphDetailed(index);
    const childType = typeNode(graph, "child.php", "Child");
    const baseType = typeNode(graph, "base.php", "Base");
    const localFunction = functionNode(graph, "child.php", "Base");
    expect(edgeBetween(graph, childType, baseType, "extends")).toBe(true);
    expect(edgeBetween(graph, childType, localFunction, "extends")).toBe(false);
    const orphanType = typeNode(graph, "orphan.php", "Orphan");
    const orphanFunction = functionNode(graph, "orphan.php", "Base");
    expect(edgeBetween(graph, orphanType, orphanFunction, "extends")).toBe(false);
    expect(graph.edges.some((edge) => edge.from === orphanType && edge.label === "extends")).toBe(false);
  });

  it("resolves PHP use by qualified name and rejects a required same-name decoy", async () => {
    const actual = ["<?php", "namespace App\\Utils;", "class UtilityClass {}", ""].join("\n");
    const decoy = ["<?php", "namespace Other;", "class Widget {}", ""].join("\n");
    const good = [
      "<?php",
      "namespace Client;",
      "use App\\Utils\\UtilityClass;",
      "class Good extends UtilityClass {}",
      "",
    ].join("\n");
    const bad = [
      "<?php",
      "namespace Client;",
      "require './decoy.php';",
      "use Missing\\Widget;",
      "class Bad extends Widget {}",
      "",
    ].join("\n");
    const { root, index } = await project("cg-audit-php-use-qualified-", {
      "actual.php": actual,
      "decoy.php": decoy,
      "good.php": good,
      "bad.php": bad,
    });
    const bound = await goToDefinition(index, {
      file: fileIn(root, "good.php"),
      ...at(good, "extends UtilityClass", "UtilityClass"),
    });
    expect(bound.status).toBe("ok");
    if (bound.status !== "ok") return;
    expect(baseName(bound.definition.file)).toBe("actual.php");
    const unbound = await goToDefinition(index, {
      file: fileIn(root, "bad.php"),
      ...at(bad, "extends Widget", "Widget"),
    });
    expect(unbound.status).toBe("not_found");

    const graph = await buildSymbolGraphDetailed(index);
    const goodType = typeNode(graph, "good.php", "Good");
    const actualType = typeNode(graph, "actual.php", "UtilityClass");
    const badType = typeNode(graph, "bad.php", "Bad");
    const decoyType = typeNode(graph, "decoy.php", "Widget");
    expect(edgeBetween(graph, goodType, actualType, "extends")).toBe(true);
    expect(edgeBetween(graph, badType, decoyType, "extends")).toBe(false);
    expect(graph.edges.some((edge) => edge.from === badType && edge.label === "extends")).toBe(false);
  });
  it("treats PHP constructor promotions as properties and ignores plain and non-constructor promotions", async () => {
    const source = [
      "<?php",
      "class Box {",
      "  function readFirst() { return $this->x; }",
      "  function __construct(public int $x, int $plain) {}",
      "  function foo(public int $y) { return $this->y; }",
      "  function read($x) { return $this->x; }",
      "  function missing() { return $this->plain; }",
      "}",
      "class Other {",
      "  public $x;",
      "  function read() { return $this->x; }",
      "}",
      "",
    ].join("\n");
    const { root, index } = await project("cg-audit-h9-", { "box.php": source });
    const file = fileIn(root, "box.php");
    const propertyGoto = await goToDefinition(index, { file, ...at(source, "return $this->x;", "x", 1) });
    const earlyGoto = await goToDefinition(index, { file, ...at(source, "return $this->x;", "x") });
    const plainGoto = await goToDefinition(index, { file, ...at(source, "$this->plain", "plain") });
    const promotedMethodGoto = await goToDefinition(index, { file, ...at(source, "$this->y", "y") });
    const otherGoto = await goToDefinition(index, { file, ...at(source, "return $this->x;", "x", 2) });
    expect(propertyGoto.status).toBe("ok");
    expect(earlyGoto.status).toBe("ok");
    if (propertyGoto.status !== "ok" || earlyGoto.status !== "ok") return;
    expect(propertyGoto.definition.range.start.line).toBe(4);
    expect(earlyGoto.definition.range.start.line).toBe(4);
    expect(propertyGoto.definition.localName).toBe("$x");
    expect(plainGoto.status).toBe("not_found");
    expect(promotedMethodGoto.status).toBe("not_found");
    expect(otherGoto.status).toBe("ok");
    if (otherGoto.status !== "ok") return;
    expect(otherGoto.definition.range.start.line).toBe(10);

    const references = await findReferences(index, { file, ...at(source, "public int $x", "$x") });
    expect(references.status).toBe("ok");
    if (references.status !== "ok") return;
    const lines = references.references.map((reference) => reference.range.start.line);
    expect(lines).toContain(3);
    expect(lines).toContain(6);
    expect(lines).not.toContain(7);
    expect(lines).not.toContain(11);
    const module = [...index.byFile.values()].find((entry) => path.basename(entry.file) === "box.php");
    expect(module?.locals.some((local) => local.localName === "$y" && local.isMember)).toBe(false);
    expect(module?.locals.some((local) => local.localName === "$plain")).toBe(false);
  });

  it("resolves Ruby block parameters inside the block and not outside it", async () => {
    const source = [
      "def run",
      "  item = 1",
      "  [1, 2].each do |item|",
      "    item",
      "  end",
      "  [3].each { |item| item }",
      "  item",
      "end",
      "",
    ].join("\n");
    const { root, index } = await project("cg-audit-h10-", { "blocks.rb": source });
    const file = fileIn(root, "blocks.rb");
    const inner = await goToDefinition(index, { file, ...at(source, "    item", "item") });
    const param = await goToDefinition(index, { file, ...at(source, "do |item|", "item") });
    const after = await goToDefinition(index, { file, ...at(source, "  item\nend", "item") });
    const brace = await goToDefinition(index, { file, ...at(source, "item }", "item") });
    expect(inner.status).toBe("ok");
    expect(param.status).toBe("ok");
    expect(after.status).toBe("ok");
    expect(brace.status).toBe("ok");
    if (inner.status !== "ok" || param.status !== "ok" || after.status !== "ok" || brace.status !== "ok") return;
    expect(inner.definition.range.start.line).toBe(3);
    expect(param.definition.range.start.line).toBe(3);
    expect(inner.definition.range.start.column).toBe(param.definition.range.start.column);
    expect(after.definition.range.start.line).toBe(2);
    expect(brace.definition.range.start.line).toBe(6);
    expect(brace.definition.range.start.column).not.toBe(param.definition.range.start.column);

    const references = await findReferences(index, { file, ...at(source, "do |item|", "item") });
    expect(references.status).toBe("ok");
    if (references.status !== "ok") return;
    const lines = references.references.map((reference) => reference.range.start.line);
    expect(lines).toContain(3);
    expect(lines).toContain(4);
    expect(lines).not.toContain(2);
    expect(lines).not.toContain(6);
    expect(lines).not.toContain(7);
  });

  it("resolves Ruby super to the proven superclass method and leaves an unproven super unresolved", async () => {
    const source = [
      "module Mixin",
      "  def helper",
      "  end",
      "end",
      "class Base",
      "  def helper",
      "  end",
      "  def other",
      "  end",
      "end",
      "class Child < Base",
      "  include Mixin",
      "  def helper",
      "    super",
      "    super()",
      "    super(1)",
      "  end",
      "end",
      "class Orphan",
      "  include Mixin",
      "  def helper",
      "    super",
      "  end",
      "end",
      "",
    ].join("\n");
    const { root, index } = await project("cg-audit-h12-", { "super.rb": source });
    const file = fileIn(root, "super.rb");
    const bare = await goToDefinition(index, { file, ...at(source, "    super\n", "super") });
    const empty = await goToDefinition(index, { file, ...at(source, "super()", "super") });
    const args = await goToDefinition(index, { file, ...at(source, "super(1)", "super") });
    const orphan = await goToDefinition(index, { file, ...at(source, "    super\n", "super", 1) });
    expect(bare.status).toBe("ok");
    expect(empty.status).toBe("ok");
    expect(args.status).toBe("ok");
    if (bare.status !== "ok" || empty.status !== "ok" || args.status !== "ok") return;
    expect(bare.definition.range.start.line).toBe(6);
    expect(empty.definition.range.start.line).toBe(6);
    expect(args.definition.range.start.line).toBe(6);
    expect(bare.definition.localName).toBe("helper");
    expect(orphan.status).toBe("not_found");

    const graph = await buildSymbolGraphDetailed(index);
    const childHelper = methodOf(graph, "super.rb", "Child", "helper");
    const baseHelper = methodOf(graph, "super.rb", "Base", "helper");
    const mixinHelper = methodOf(graph, "super.rb", "Mixin", "helper");
    const orphanHelper = methodOf(graph, "super.rb", "Orphan", "helper");
    const baseOther = methodOf(graph, "super.rb", "Base", "other");
    expect(callCount(graph, childHelper, baseHelper)).toBe(3);
    expect(callCount(graph, childHelper, mixinHelper)).toBe(0);
    expect(callCount(graph, childHelper, baseOther)).toBe(0);
    expect(callCount(graph, orphanHelper, mixinHelper)).toBe(0);
    expect(callCount(graph, orphanHelper, baseHelper)).toBe(0);
  });

  it("exports only top-level Ruby classes and does not let a nested class steal a bare name", async () => {
    const outer = [
      "module Outer",
      "  class Base",
      "  end",
      "  class Path::Tool",
      "  end",
      "end",
      "module Path::Box",
      "end",
      "",
    ].join("\n");
    const realBase = ["class Base", "end", ""].join("\n");
    const worker = ['require_relative "outer"', 'require_relative "real_base"', "class Worker < Base", "end", ""].join(
      "\n",
    );
    const onlyNested = ['require_relative "outer"', "class Only < Base", "end", ""].join("\n");
    const { root, index } = await project("cg-audit-w18-", {
      "outer.rb": outer,
      "real_base.rb": realBase,
      "worker.rb": worker,
      "only.rb": onlyNested,
    });
    const outerNames = exportedNames(index, "outer.rb");
    expect(outerNames).toContain("Outer");
    expect(outerNames).toContain("Path::Tool");
    expect(outerNames).toContain("Path::Box");
    expect(outerNames).not.toContain("Base");
    expect(exportedNames(index, "real_base.rb")).toContain("Base");

    const workerFile = fileIn(root, "worker.rb");
    const resolved = await goToDefinition(index, { file: workerFile, ...at(worker, "class Worker < Base", "Base") });
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok") return;
    expect(baseName(resolved.definition.file)).toBe("real_base.rb");
    expect(resolved.definition.range.start.line).toBe(1);

    const onlyFile = fileIn(root, "only.rb");
    const unresolved = await goToDefinition(index, { file: onlyFile, ...at(onlyNested, "class Only < Base", "Base") });
    expect(unresolved.status).toBe("not_found");

    const graph = await buildSymbolGraphDetailed(index);
    const workerType = typeNode(graph, "worker.rb", "Worker");
    const onlyType = typeNode(graph, "only.rb", "Only");
    const real = typeNode(graph, "real_base.rb", "Base");
    const nested = typeNode(graph, "outer.rb", "Base");
    expect(edgeBetween(graph, workerType, real, "extends")).toBe(true);
    expect(edgeBetween(graph, workerType, nested, "extends")).toBe(false);
    expect(edgeBetween(graph, onlyType, nested, "extends")).toBe(false);
    expect(edgeBetween(graph, onlyType, real, "extends")).toBe(false);
  });
});

function exportedNames(index: ProjectIndex, file: string): string[] {
  const module = [...index.byFile.values()].find((entry) => path.basename(entry.file) === file);
  return (module?.exports ?? []).flatMap((entry) => ("exportedAs" in entry ? [entry.exportedAs] : []));
}

function functionNode(graph: DetailedSymbolGraph, file: string, name: string): string {
  const matches = [...graph.nodes.values()].filter(
    (node) => node.kind === "function" && node.name === name && path.basename(node.file) === file,
  );
  expect(matches, `${name} in ${file}`).toHaveLength(1);
  return matches[0]?.id ?? "";
}

function methodOf(graph: DetailedSymbolGraph, file: string, owner: string, name: string): string {
  const owners = [...graph.nodes.values()].filter(
    (node) => node.kind !== "function" && node.name === owner && path.basename(node.file) === file,
  );
  expect(owners, owner).toHaveLength(1);
  const ownerId = owners[0]?.id ?? "";
  const methods = graph.edges
    .filter((edge) => edge.label === "member_of" && edge.to === ownerId)
    .map((edge) => graph.nodes.get(edge.from))
    .filter((node) => node?.kind === "function" && node.name === name);
  expect(methods, `${owner}.${name}`).toHaveLength(1);
  return methods[0]?.id ?? "";
}

function typeNode(graph: DetailedSymbolGraph, file: string, name: string): string {
  const matches = [...graph.nodes.values()].filter(
    (node) => node.kind !== "function" && node.name === name && path.basename(node.file) === file,
  );
  expect(matches, name).toHaveLength(1);
  return matches[0]?.id ?? "";
}

function edgeBetween(graph: DetailedSymbolGraph, from: string, to: string, label: string): boolean {
  return graph.edges.some((edge) => edge.from === from && edge.to === to && edge.label === label);
}

function callCount(graph: DetailedSymbolGraph, from: string, to: string): number {
  return graph.edges.filter((edge) => edge.from === from && edge.to === to && edge.label === "calls").length;
}

describe("Ruby scope-resolution class names follow their lexical nesting", () => {
  it("exports `class Inner::Tool` inside `module Outer` as Outer::Inner::Tool and `class ::Top` as Top", async () => {
    const use = ["require_relative 'defs'", "Outer::Inner::Tool.new", "Inner::Tool.new", "Top.new", ""];
    const { root, index } = await project("cg-audit-ruby-scope-name-", {
      "defs.rb": "module Outer\n  module Inner\n  end\n  class Inner::Tool\n  end\n  class ::Top\n  end\nend\n",
      "use.rb": use.join("\n"),
    });
    const file = path.join(root, "use.rb").replace(/\\/g, "/");
    const at = async (line: number, token: string) =>
      await goToDefinition(index, { file, line, column: use[line - 1]!.lastIndexOf(token) + 1 });

    const nested = await at(2, "Tool");
    expect(nested.status).toBe("ok");
    if (nested.status === "ok") expect(nested.definition.range.start.line).toBe(4);
    // At the top level `Inner` is not defined, so `Inner::Tool` names nothing.
    expect((await at(3, "Tool")).status).toBe("not_found");
    const top = await at(4, "Top");
    expect(top.status).toBe("ok");
    if (top.status === "ok") expect(top.definition.range.start.line).toBe(6);
  });
});
