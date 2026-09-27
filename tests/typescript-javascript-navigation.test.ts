import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSymbolGraphDetailed,
  buildSymbolGraph,
  buildProjectIndexIncremental,
  findReferences,
  goToDefinition,
  listSymbols,
  type FindReferencesResult,
  type BuildReport,
  type ProjectIndex,
  type SymbolGraph,
} from "../src/index.js";
import { closeDiskCacheDatabase } from "../src/indexer/build-cache.js";
import { collectLocalsAndExportsFromSource } from "../src/indexer.js";
import { supportForFile } from "../src/languages.js";
import { createTestIndexFromFiles } from "./test-utils.js";
import { fileIdentityKey } from "../src/util/paths.js";

function columnOf(source: string, line: number, token: string): number {
  const text = source.split("\n")[line - 1];
  if (!text) throw new Error(`missing line ${line}`);
  const column = text.indexOf(token);
  if (column < 0) throw new Error(`missing ${token} on line ${line}`);
  return column + 1;
}

function tokenIndex(source: string, line: number, token: string): number {
  const lines = source.split("\n");
  const column = columnOf(source, line, token) - 1;
  const prior = lines.slice(0, line - 1).join("\n");
  return (line === 1 ? 0 : prior.length + 1) + column;
}

async function project(files: Record<string, string>): Promise<{
  root: string;
  index: Awaited<ReturnType<typeof createTestIndexFromFiles>>;
  file: (name: string) => string;
}> {
  const root = (await mkdtemp(path.join(os.tmpdir(), "cg-tsjs-"))).replace(/\\/g, "/");
  const paths = Object.keys(files).map((name) => `${root}/${name}`);
  await Promise.all(paths.map((filePath, offset) => writeFile(filePath, Object.values(files)[offset]!, "utf8")));
  const index = await createTestIndexFromFiles(root, paths);
  return {
    root,
    index,
    file: (name: string) => `${root}/${name}`,
  };
}

function referenceSites(result: FindReferencesResult): string[] {
  if (result.status !== "ok") return [];
  return result.references.map((reference) => {
    const base = path.basename(reference.file);
    return `${base}:${reference.range.start.line}`;
  });
}

function callTargetIds(graph: SymbolGraph, caller: string): string[] {
  const targets: string[] = [];
  for (const edge of graph.edges) {
    if (edge.label !== "calls") continue;
    if (graph.nodes.get(edge.from)?.name !== caller) continue;
    targets.push(edge.to);
  }
  return targets;
}

describe("TypeScript and JavaScript navigation", () => {
  it("keeps overload signatures and resolves calls to the implementation", async () => {
    const fmt = [
      "export function format(value: string): string;",
      "export function format(value: number): string;",
      "export function format(value: string | number): string { return String(value); }",
      "",
    ].join("\n");
    const decoy = ["export function format(value: string): string { return value; }", ""].join("\n");
    const use = ['import { format } from "./fmt";', 'export function run(): string { return format("hi"); }', ""].join(
      "\n",
    );
    const fixture = await project({ "fmt.ts": fmt, "decoy.ts": decoy, "use.ts": use });
    try {
      const symbols = listSymbols(fixture.index, { file: fixture.file("fmt.ts") }).filter(
        (symbol) => symbol.name === "format",
      );
      expect(symbols.map((symbol) => symbol.range?.start.line).sort()).toEqual([1, 2, 3]);
      const exported = fixture.index.byFile
        .get(fileIdentityKey(fixture.file("fmt.ts")))
        ?.exports.flatMap((entry) => (entry.type === "local" && entry.exportedAs === "format" ? [entry] : []));
      expect(exported?.map((entry) => entry.target.range.start.line)).toEqual([3]);

      const result = await goToDefinition(fixture.index, {
        file: fixture.file("use.ts"),
        line: 2,
        column: columnOf(use, 2, "format("),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(fixture.file("fmt.ts")));
      expect(result.definition.range.start.line).toBe(3);

      const refs = await findReferences(fixture.index, {
        file: fixture.file("fmt.ts"),
        line: 3,
        column: columnOf(fmt, 3, "format"),
      });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") return;
      expect(refs.referenceCoverage?.state).toBe("complete");
      const sites = referenceSites(refs);
      expect(sites).toContain("use.ts:2");
      expect(sites.some((site) => site.startsWith("decoy.ts"))).toBe(false);

      const graph = await buildSymbolGraphDetailed(fixture.index);
      const implIndex = tokenIndex(fmt, 3, "format");
      const targets = callTargetIds(graph, "run");
      expect(targets.some((id) => id.endsWith(`::format::${implIndex}`))).toBe(true);
      expect(targets.some((id) => id.includes("decoy.ts"))).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("retains overload signatures without exactly one implementation and member overloads", async () => {
    const declarations = [
      "export declare function f(a: string): void;",
      "export declare function f(a: number): void;",
      "export interface Contract {",
      "  apply(a: string): void;",
      "  apply(a: number): void;",
      "}",
      "export abstract class AbstractWorker {",
      "  abstract apply(a: string): void;",
      "  abstract apply(a: number): void;",
      "}",
      "",
    ].join("\n");
    const duplicateBodies = [
      "export function g(a: string): void;",
      "export function g(a: string): void {}",
      "export function g(a: number): void {}",
      "",
    ].join("\n");
    const use = ['import { f } from "./declarations";', 'f("hello");', ""].join("\n");
    const fixture = await project({
      "declarations.ts": declarations,
      "duplicates.ts": duplicateBodies,
      "use.ts": use,
    });
    try {
      const module = fixture.index.byFile.get(fileIdentityKey(fixture.file("declarations.ts")));
      const exportLines = module?.exports.flatMap((entry) =>
        entry.type === "local" && entry.exportedAs === "f" ? [entry.target.range.start.line] : [],
      );
      expect(exportLines).toEqual([1, 2]);

      const duplicated = fixture.index.byFile.get(fileIdentityKey(fixture.file("duplicates.ts")));
      const duplicateLines = duplicated?.exports.flatMap((entry) =>
        entry.type === "local" && entry.exportedAs === "g" ? [entry.target.range.start.line] : [],
      );
      expect(duplicateLines).toEqual([1, 2, 3]);

      const graph = await buildSymbolGraphDetailed(fixture.index);
      const applyIds = [...graph.nodes.values()]
        .filter(
          (node) =>
            node.name === "apply" && fileIdentityKey(node.file) === fileIdentityKey(fixture.file("declarations.ts")),
        )
        .map((node) => node.id);
      expect(applyIds.sort()).toEqual(
        [4, 5, 8, 9]
          .map((line) => fixture.file("declarations.ts") + "::apply::" + tokenIndex(declarations, line, "apply"))
          .sort(),
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("selects later TypeScript overload signatures by arity across navigation, references, and graph edges", async () => {
    const overloads = [
      "export interface Parser {",
      "  parse(input: string): string;",
      "  parse(input: string, flags: number): string;",
      "}",
      "export declare function declared(input: string): string;",
      "export declare function declared(input: string, flags: number): string;",
      "export abstract class AbstractParser {",
      "  abstract parse(input: string): string;",
      "  abstract parse(input: string, flags: number): string;",
      "}",
      "export function implemented(input: string): string;",
      "export function implemented(input: string, flags: number): string;",
      "export function implemented(input: string, flags?: number): string { return input; }",
      "export function run(parser: Parser, abstractParser: AbstractParser): string {",
      '  parser.parse("a", 1);',
      '  abstractParser.parse("a", 1);',
      '  declared("a", 1);',
      '  return implemented("a", 1);',
      "}",
      'export function wrongArity(parser: Parser): void { parser.parse("a", 1, 2); }',
      "",
    ].join("\n");
    const fixture = await project({ "overloads.ts": overloads });
    try {
      const cases = [
        { line: 15, token: "parse(", declarationLine: 3 },
        { line: 16, token: "parse(", declarationLine: 9 },
        { line: 17, token: "declared", declarationLine: 6 },
        { line: 18, token: "implemented", declarationLine: 13 },
      ];
      for (const entry of cases) {
        const result = await goToDefinition(fixture.index, {
          file: fixture.file("overloads.ts"),
          line: entry.line,
          column: columnOf(overloads, entry.line, entry.token),
        });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") continue;
        expect(result.definition.range.start.line).toBe(entry.declarationLine);
      }

      const wrongArity = await goToDefinition(fixture.index, {
        file: fixture.file("overloads.ts"),
        line: 20,
        column: columnOf(overloads, 20, "parse("),
      });
      expect(wrongArity.status).toBe("not_found");

      const referenceCoverageStates: Record<number, string | undefined> = {};
      for (const entry of [
        { declarationLine: 3, token: "parse", useLine: 15 },
        { declarationLine: 9, token: "parse", useLine: 16 },
        { declarationLine: 6, token: "declared", useLine: 17 },
        { declarationLine: 13, token: "implemented", useLine: 18 },
      ]) {
        const refs = await findReferences(fixture.index, {
          file: fixture.file("overloads.ts"),
          line: entry.declarationLine,
          column: columnOf(overloads, entry.declarationLine, entry.token),
        });
        expect(refs.status).toBe("ok");
        if (refs.status !== "ok") continue;
        referenceCoverageStates[entry.declarationLine] = refs.referenceCoverage?.state;
        expect(referenceSites(refs)).toContain(`overloads.ts:${entry.useLine}`);
        expect(referenceSites(refs)).not.toContain("overloads.ts:20");
      }
      expect(referenceCoverageStates).toEqual({
        3: "partial",
        6: "complete",
        9: "partial",
        13: "complete",
      });

      const graph = await buildSymbolGraphDetailed(fixture.index);
      const runTargets = callTargetIds(graph, "run");
      for (const entry of [
        { line: 3, token: "parse" },
        { line: 9, token: "parse" },
        { line: 6, token: "declared" },
        { line: 13, token: "implemented" },
      ]) {
        const targetIndex = tokenIndex(overloads, entry.line, entry.token);
        expect(runTargets.some((id) => id.endsWith(`::${entry.token}::${targetIndex}`))).toBe(true);
      }
      expect(callTargetIds(graph, "wrongArity")).toEqual([]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
  it("keeps overloads in distinct TypeScript namespaces separate", async () => {
    const namespaces = [
      "export namespace A {",
      "  export function select(value: string): string { return value; }",
      "}",
      "export declare namespace B {",
      "  export function select(value: string): string;",
      "  export function select(value: string, count: number): string;",
      "}",
      'export function run(): string { return B.select("b", 2); }',
      'export function wrongArity(): void { B.select("b", 2, 3); }',
      "",
    ].join("\n");
    const fixture = await project({ "namespaces.ts": namespaces });
    try {
      const module = fixture.index.byFile.get(fileIdentityKey(fixture.file("namespaces.ts")));
      const exportLines = module?.exports.flatMap((entry) =>
        entry.type === "local" && entry.exportedAs === "select" ? [entry.target.range.start.line] : [],
      );
      expect(exportLines).toEqual([2, 5, 6]);

      const result = await goToDefinition(fixture.index, {
        file: fixture.file("namespaces.ts"),
        line: 8,
        column: columnOf(namespaces, 8, "select"),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.definition.range.start.line).toBe(6);

      const wrongArity = await goToDefinition(fixture.index, {
        file: fixture.file("namespaces.ts"),
        line: 9,
        column: columnOf(namespaces, 9, "select"),
      });
      expect(wrongArity.status).toBe("not_found");

      const refs = await findReferences(fixture.index, {
        file: fixture.file("namespaces.ts"),
        line: 6,
        column: columnOf(namespaces, 6, "select"),
      });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") return;
      expect(refs.referenceCoverage?.state).toBe("partial");
      expect(referenceSites(refs)).toContain("namespaces.ts:8");
      expect(referenceSites(refs)).not.toContain("namespaces.ts:9");

      // The detailed graph does not resolve same-file namespace member calls yet, so `run` gets no
      // edge. It must never target namespace A's implementation, and a wrong-arity call gets none.
      const graph = await buildSymbolGraphDetailed(fixture.index);
      const implementationIndex = tokenIndex(namespaces, 2, "select");
      expect(callTargetIds(graph, "run").some((id) => id.endsWith(`::select::${implementationIndex}`))).toBe(false);
      expect(callTargetIds(graph, "wrongArity")).toEqual([]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
  it("selects later signature-only receiver overloads across namespaces and merged interfaces", async () => {
    const declarations = [
      "export declare namespace NamespaceApi {",
      "  function parse(value: string): string;",
      "  function parse(value: string, flags: number): string;",
      "}",
      "export interface Merged {",
      "  parse(value: string): string;",
      "}",
      "export interface Merged {",
      "  parse(value: string, flags: number): string;",
      "}",
      'export function namespaceRun(): string { return NamespaceApi.parse("v", 1); }',
      'export function interfaceRun(value: Merged): string { return value.parse("v", 1); }',
      'export function namespaceWrong(): void { NamespaceApi.parse("v", 1, 2); }',
      'export function interfaceWrong(value: Merged): void { value.parse("v", 1, 2); }',
      "",
    ].join("\n");
    const fixture = await project({ "receiver-overloads.ts": declarations });
    try {
      for (const entry of [
        { line: 11, token: "parse", declarationLine: 3 },
        { line: 12, token: "parse", declarationLine: 9 },
      ]) {
        const result = await goToDefinition(fixture.index, {
          file: fixture.file("receiver-overloads.ts"),
          line: entry.line,
          column: columnOf(declarations, entry.line, entry.token),
        });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") continue;
        expect(result.definition.range.start.line).toBe(entry.declarationLine);
      }

      for (const entry of [
        { line: 13, token: "parse" },
        { line: 14, token: "parse" },
      ]) {
        const result = await goToDefinition(fixture.index, {
          file: fixture.file("receiver-overloads.ts"),
          line: entry.line,
          column: columnOf(declarations, entry.line, entry.token),
        });
        expect(result.status).toBe("not_found");
      }

      const graph = await buildSymbolGraphDetailed(fixture.index);
      const interfaceTarget = tokenIndex(declarations, 9, "parse");
      expect(callTargetIds(graph, "interfaceRun").some((id) => id.endsWith(`::parse::${interfaceTarget}`))).toBe(true);
      expect(callTargetIds(graph, "namespaceWrong")).toEqual([]);
      expect(callTargetIds(graph, "interfaceWrong")).toEqual([]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
  it("resolves an overloaded method through this to its implementation", async () => {
    const box = [
      "export class Box {",
      "  method(value: string): string;",
      "  method(value: number): string;",
      "  method(value: string | number): string { return String(value); }",
      '  run(): string { return this.method("x"); }',
      "}",
      "export class Other {",
      "  method(value: string): string { return value; }",
      '  run(): string { return this.method("y"); }',
      "}",
      "",
    ].join("\n");
    const fixture = await project({ "box.ts": box });
    try {
      const result = await goToDefinition(fixture.index, {
        file: fixture.file("box.ts"),
        line: 5,
        column: columnOf(box, 5, "method("),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.definition.range.start.line).toBe(4);

      const refs = await findReferences(fixture.index, {
        file: fixture.file("box.ts"),
        line: 4,
        column: columnOf(box, 4, "method"),
      });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") return;
      expect(refs.referenceCoverage?.state).toBe("complete");
      const sites = referenceSites(refs);
      expect(sites).toContain("box.ts:5");
      expect(sites).not.toContain("box.ts:9");

      const graph = await buildSymbolGraphDetailed(fixture.index);
      const implIndex = tokenIndex(box, 4, "method");
      const callers = graph.edges.filter(
        (edge) => edge.label === "calls" && edge.to.endsWith(`::method::${implIndex}`),
      );
      expect(callers.map((edge) => graph.nodes.get(edge.from)?.name)).toContain("run");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("binds a default-exported class for static and instance members", async () => {
    const widget = [
      "export default class Widget {",
      "  static create(): Widget { return new Widget(); }",
      '  render(): string { return "w"; }',
      "}",
      "export class Other {",
      "  static create(): Other { return new Other(); }",
      '  render(): string { return "o"; }',
      "}",
      "",
    ].join("\n");
    const decoy = [
      "export class Widget {",
      "  static create(): Widget { return new Widget(); }",
      '  render(): string { return "d"; }',
      "}",
      "",
    ].join("\n");
    const use = [
      'import Widget from "./widget";',
      "export function run(): string {",
      "  Widget.create();",
      "  return new Widget().render();",
      "}",
      "",
    ].join("\n");
    const decoyUse = [
      'import { Widget } from "./decoy";',
      "export function decoyRun(): string {",
      "  Widget.create();",
      "  return new Widget().render();",
      "}",
      "",
    ].join("\n");
    const fixture = await project({
      "widget.ts": widget,
      "decoy.ts": decoy,
      "use.ts": use,
      "decoy-use.ts": decoyUse,
    });
    try {
      const staticResult = await goToDefinition(fixture.index, {
        file: fixture.file("use.ts"),
        line: 3,
        column: columnOf(use, 3, "create"),
      });
      expect(staticResult.status).toBe("ok");
      if (staticResult.status !== "ok") return;
      expect(fileIdentityKey(staticResult.definition.file)).toBe(fileIdentityKey(fixture.file("widget.ts")));
      expect(staticResult.definition.range.start.line).toBe(2);

      const instanceResult = await goToDefinition(fixture.index, {
        file: fixture.file("use.ts"),
        line: 4,
        column: columnOf(use, 4, "render"),
      });
      expect(instanceResult.status).toBe("ok");
      if (instanceResult.status !== "ok") return;
      expect(instanceResult.definition.range.start.line).toBe(3);

      const refs = await findReferences(fixture.index, {
        file: fixture.file("widget.ts"),
        line: 3,
        column: columnOf(widget, 3, "render"),
      });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") return;
      expect(refs.referenceCoverage?.state).toBe("complete");
      const sites = referenceSites(refs);
      expect(sites).toContain("use.ts:4");
      expect(sites.some((site) => site.startsWith("decoy"))).toBe(false);

      const graph = await buildSymbolGraphDetailed(fixture.index);
      const renderIndex = tokenIndex(widget, 3, "render");
      expect(callTargetIds(graph, "run").some((id) => id.endsWith(`::render::${renderIndex}`))).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("binds module.exports = Class for static and instance members", async () => {
    const widget = [
      "class Widget {",
      "  static create() { return new Widget(); }",
      '  render() { return "w"; }',
      "}",
      "class Other {",
      "  static create() { return new Other(); }",
      '  render() { return "o"; }',
      "}",
      "module.exports = Widget;",
      "",
    ].join("\n");
    const decoy = [
      "class Widget {",
      "  static create() { return new Widget(); }",
      '  render() { return "d"; }',
      "}",
      "module.exports = Widget;",
      "",
    ].join("\n");
    const use = [
      'const Widget = require("./widget");',
      "function run() {",
      "  Widget.create();",
      "  return new Widget().render();",
      "}",
      "module.exports = { run };",
      "",
    ].join("\n");
    const decoyUse = [
      'const Widget = require("./decoy");',
      "function decoyRun() {",
      "  Widget.create();",
      "  return new Widget().render();",
      "}",
      "",
    ].join("\n");
    const fixture = await project({
      "widget.js": widget,
      "decoy.js": decoy,
      "use.js": use,
      "decoy-use.js": decoyUse,
    });
    try {
      const staticResult = await goToDefinition(fixture.index, {
        file: fixture.file("use.js"),
        line: 3,
        column: columnOf(use, 3, "create"),
      });
      expect(staticResult.status).toBe("ok");
      if (staticResult.status !== "ok") return;
      expect(fileIdentityKey(staticResult.definition.file)).toBe(fileIdentityKey(fixture.file("widget.js")));
      expect(staticResult.definition.range.start.line).toBe(2);

      const instanceResult = await goToDefinition(fixture.index, {
        file: fixture.file("use.js"),
        line: 4,
        column: columnOf(use, 4, "render"),
      });
      expect(instanceResult.status).toBe("ok");
      if (instanceResult.status !== "ok") return;
      expect(instanceResult.definition.range.start.line).toBe(3);

      const refs = await findReferences(fixture.index, {
        file: fixture.file("widget.js"),
        line: 3,
        column: columnOf(widget, 3, "render"),
      });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") return;
      expect(refs.referenceCoverage?.state).toBe("complete");
      const sites = referenceSites(refs);
      expect(sites).toContain("use.js:4");
      expect(sites.some((site) => site.startsWith("decoy"))).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not bind a default-exported function to a nested class with the same name", async () => {
    const widget = [
      "function Widget() {}",
      "export default Widget;",
      "function unrelated() {",
      "  class Widget { static method() {} }",
      "  return Widget;",
      "}",
      "",
    ].join("\n");
    const use = ['import Widget from "./widget";', "function run() { Widget.method(); }", ""].join("\n");
    const fixture = await project({ "widget.js": widget, "use.js": use });
    try {
      const result = await goToDefinition(fixture.index, {
        file: fixture.file("use.js"),
        line: 2,
        column: columnOf(use, 2, "method"),
      });
      expect(result.status).toBe("not_found");

      const refs = await findReferences(fixture.index, {
        file: fixture.file("widget.js"),
        line: 4,
        column: columnOf(widget, 4, "method"),
      });
      expect(refs.status).toBe("ok");
      expect(referenceSites(refs)).not.toContain("use.js:2");

      const graph = await buildSymbolGraphDetailed(fixture.index);
      expect(callTargetIds(graph, "run")).not.toContain(
        fixture.file("widget.js") + "::method::" + tokenIndex(widget, 4, "method"),
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['export { helper } from "./helper";', "helper"],
    ['export * from "./helper";', "helper"],
  ])("keeps require as a namespace for a default class with %s", async (reexport, member) => {
    const widget = ["export default class Widget { static method() {} }", reexport, ""].join("\n");
    const helper = "export function helper() {}\n";
    const use = [
      'const W = require("./widget");',
      "function run() {",
      "  W.method();",
      `  return W.${member}();`,
      "}",
      "",
    ].join("\n");
    const fixture = await project({ "widget.js": widget, "helper.js": helper, "use.js": use });
    try {
      const wrongMember = await goToDefinition(fixture.index, {
        file: fixture.file("use.js"),
        line: 3,
        column: columnOf(use, 3, "method"),
      });
      expect(wrongMember.status).toBe("not_found");
      const exportedMember = await goToDefinition(fixture.index, {
        file: fixture.file("use.js"),
        line: 4,
        column: columnOf(use, 4, "helper"),
      });
      expect(exportedMember.status).toBe("ok");
      if (exportedMember.status !== "ok") return;
      expect(fileIdentityKey(exportedMember.definition.file)).toBe(fileIdentityKey(fixture.file("helper.js")));
      expect(exportedMember.definition.range.start.index).toBe(tokenIndex(helper, 1, "helper"));

      const wrongRefs = await findReferences(fixture.index, {
        file: fixture.file("widget.js"),
        line: 1,
        column: columnOf(widget, 1, "method"),
      });
      expect(wrongRefs.status).toBe("ok");
      expect(referenceSites(wrongRefs)).not.toContain("use.js:3");
      const helperRefs = await findReferences(fixture.index, {
        file: fixture.file("helper.js"),
        line: 1,
        column: columnOf(helper, 1, "helper"),
      });
      expect(helperRefs.status).toBe("ok");
      expect(referenceSites(helperRefs)).toContain("use.js:4");

      const graph = await buildSymbolGraphDetailed(fixture.index);
      const targets = callTargetIds(graph, "run");
      expect(targets).not.toContain(fixture.file("widget.js") + "::method::" + tokenIndex(widget, 1, "method"));
      expect(targets).toContain(fixture.file("helper.js") + "::helper::" + tokenIndex(helper, 1, "helper"));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
  it("keeps require as a namespace for a default class with a namespace re-export", async () => {
    const widget = 'export default class Widget { static method() {} }\nexport * as helpers from "./helper";\n';
    const helper = "export function helper() {}\n";
    const use = [
      'const W = require("./widget");',
      "function run() { W.method(); }",
      "function nested() { return W.helpers.helper(); }",
      "",
    ].join("\n");
    const fixture = await project({ "widget.js": widget, "helper.js": helper, "use.js": use });
    try {
      const result = await goToDefinition(fixture.index, {
        file: fixture.file("use.js"),
        line: 2,
        column: columnOf(use, 2, "method"),
      });
      expect(result.status).toBe("not_found");
      const refs = await findReferences(fixture.index, {
        file: fixture.file("widget.js"),
        line: 1,
        column: columnOf(widget, 1, "method"),
      });
      expect(refs.status).toBe("ok");
      expect(referenceSites(refs)).not.toContain("use.js:2");
      const graph = await buildSymbolGraphDetailed(fixture.index);
      expect(callTargetIds(graph, "run")).not.toContain(
        fixture.file("widget.js") + "::method::" + tokenIndex(widget, 1, "method"),
      );
      const nested = await goToDefinition(fixture.index, {
        file: fixture.file("use.js"),
        line: 3,
        column: columnOf(use, 3, "helper"),
      });
      const helperRefs = await findReferences(fixture.index, {
        file: fixture.file("helper.js"),
        line: 1,
        column: columnOf(helper, 1, "helper"),
      });
      expect(nested.status).toBe("ok");
      if (nested.status !== "ok") return;
      expect(fileIdentityKey(nested.definition.file)).toBe(fileIdentityKey(fixture.file("helper.js")));
      expect(helperRefs.status).toBe("ok");
      if (helperRefs.status !== "ok") return;
      expect(helperRefs.referenceCoverage?.state).toBe("complete");
      expect(referenceSites(helperRefs)).toContain("use.js:3");
      expect(callTargetIds(graph, "nested")).toContain(
        fixture.file("helper.js") + "::helper::" + tokenIndex(helper, 1, "helper"),
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["module.exports.helper = helper;", "Widget.helper = helper;"])(
    "retains a direct CommonJS class value with a later %s assignment",
    async (assignment) => {
      const widget = [
        "class Widget { static method() {} }",
        "function helper() {}",
        "module.exports = Widget;",
        assignment,
        "",
      ].join("\n");
      const use = ['const W = require("./widget");', "function run() { W.method(); }", ""].join("\n");
      const fixture = await project({ "widget.js": widget, "use.js": use });
      try {
        const result = await goToDefinition(fixture.index, {
          file: fixture.file("use.js"),
          line: 2,
          column: columnOf(use, 2, "method"),
        });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(fixture.file("widget.js")));
        expect(result.definition.range.start.index).toBe(tokenIndex(widget, 1, "method"));

        const refs = await findReferences(fixture.index, {
          file: fixture.file("widget.js"),
          line: 1,
          column: columnOf(widget, 1, "method"),
        });
        expect(refs.status).toBe("ok");
        expect(referenceSites(refs)).toContain("use.js:2");

        const graph = await buildSymbolGraphDetailed(fixture.index);
        expect(callTargetIds(graph, "run")).toContain(
          fixture.file("widget.js") + "::method::" + tokenIndex(widget, 1, "method"),
        );
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it("records direct CommonJS function values in native and no-native extraction without marking ESM exports", async () => {
    const cjsSource = "module.exports = function thing() {};\n";
    const esmSource = "export function exports() {}\n";
    const fixture = await project({ "cjs.js": cjsSource, "esm.js": esmSource });
    try {
      const cjsFile = fixture.file("cjs.js");
      const esmFile = fixture.file("esm.js");
      const support = supportForFile(cjsFile)!;
      const modes = [
        {
          name: "native",
          cjs: fixture.index.byFile.get(fileIdentityKey(cjsFile)),
          esm: fixture.index.byFile.get(fileIdentityKey(esmFile)),
        },
        {
          name: "no-native",
          cjs: collectLocalsAndExportsFromSource(cjsFile, cjsSource, support, [], { nativeMode: "off" }),
          esm: collectLocalsAndExportsFromSource(esmFile, esmSource, support, [], { nativeMode: "off" }),
        },
      ];
      for (const { name, cjs, esm } of modes) {
        expect(
          cjs?.exports.some(
            (entry) =>
              entry.type === "local" && entry.exportedAs === "exports" && entry.mechanism === "cjs-module-value",
          ),
          name,
        ).toBe(true);
        expect(
          esm?.exports.some((entry) => entry.type === "local" && entry.mechanism === "cjs-module-value"),
          name,
        ).toBe(false);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
  it.each([
    ["anonymous", "require", "module.exports = function () {};\n", 'const W = require("./w");'],
    ["anonymous", "default import", "module.exports = function () {};\n", 'import W from "./w";'],
    ["identifier", "require", "function Widget() {}\nmodule.exports = Widget;\n", 'const W = require("./w");'],
    ["identifier", "default import", "function Widget() {}\nmodule.exports = Widget;\n", 'import W from "./w";'],
  ])(
    "aligns direct CommonJS %s values through %s navigation, references, and graph",
    async (_shape, mode, source, importLine) => {
      const use = importLine + "\nnew W();\n";
      const decoyUse = 'const W = require("./decoy");\nnew W();\n';
      const fixture = await project({
        "w.js": source,
        "main.js": use,
        "decoy.js": "module.exports = function () {};\n",
        "decoy-use.js": decoyUse,
      });
      try {
        const file = fixture.file("w.js");
        const direct = fixture.index.byFile
          .get(fileIdentityKey(file))
          ?.exports.find((entry) => entry.type === "local" && entry.mechanism === "cjs-module-value");
        expect(direct?.type).toBe("local");
        if (direct?.type !== "local") return;

        for (const line of [1, 2]) {
          const result = await goToDefinition(fixture.index, {
            file: fixture.file("main.js"),
            line,
            column: columnOf(use, line, "W"),
          });
          expect(result.status).toBe("ok");
          if (result.status !== "ok") return;
          expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(file));
          expect(result.definition.range.start.index).toBe(direct.target.range.start.index);
        }

        const refs = await findReferences(fixture.index, {
          file,
          line: direct.target.range.start.line,
          column: direct.target.range.start.column,
        });
        expect(refs.status).toBe("ok");
        if (refs.status !== "ok") return;
        expect(refs.referenceCoverage?.state).toBe("complete");
        expect(referenceSites(refs)).toContain("main.js:1");
        expect(referenceSites(refs)).toContain("main.js:2");
        expect(referenceSites(refs).some((site) => site.startsWith("decoy"))).toBe(false);

        const graph = await buildSymbolGraphDetailed(fixture.index);
        const importNode = [...graph.nodes.values()].find(
          (node) =>
            node.file === fixture.file("main.js") &&
            node.name === "W" &&
            node.kind === (mode === "require" ? "namespaceImport" : "import"),
        );
        const targetNode = [...graph.nodes.values()].find(
          (node) => node.file === file && node.name === direct.target.localName,
        );
        expect(importNode).toBeDefined();
        expect(targetNode).toBeDefined();
        if (!importNode || !targetNode) return;
        expect(graph.edges.some((edge) => edge.from === importNode.id && edge.to === targetNode.id)).toBe(true);
        expect(
          graph.edges.some(
            (edge) => edge.from === importNode.id && graph.nodes.get(edge.to)?.file === fixture.file("decoy.js"),
          ),
        ).toBe(false);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it("does not invent a default value from named CommonJS exports", async () => {
    const source = "exports.helper = function helper() {};\n";
    const use = 'import W from "./w";\nnew W();\n';
    const fixture = await project({ "w.js": source, "main.js": use });
    try {
      const result = await goToDefinition(fixture.index, {
        file: fixture.file("main.js"),
        line: 2,
        column: columnOf(use, 2, "W"),
      });
      expect(result.status).toBe("not_found");

      for (const graph of [await buildSymbolGraph(fixture.index), await buildSymbolGraphDetailed(fixture.index)]) {
        const importNode = [...graph.nodes.values()].find(
          (node) => node.file === fixture.file("main.js") && node.name === "W" && node.kind === "import",
        );
        expect(importNode).toBeDefined();
        if (!importNode) return;
        expect(
          graph.edges.some(
            (edge) => edge.from === importNode.id && graph.nodes.get(edge.to)?.file === fixture.file("w.js"),
          ),
        ).toBe(false);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  const directCjsWidget = [
    "function decoy() {",
    "  class Widget { static method() {} }",
    "  return Widget;",
    "}",
    "class Widget { static method() {} }",
    "module.exports = Widget;",
    "",
  ].join("\n");

  it.each(["js", "ts", "tsx"] as const)("resolves native direct CJS identifier exports in %s", async (extension) => {
    const widgetName = `widget.${extension}`;
    const useName = `use.${extension}`;
    const importLine = extension === "js" ? 'const W = require("./widget");' : 'import W = require("./widget");';
    const use = [importLine, "function run() { W.method(); }", ""].join("\n");
    const fixture = await project({ [widgetName]: directCjsWidget, [useName]: use });
    try {
      const module = fixture.index.byFile.get(fileIdentityKey(fixture.file(widgetName)));
      const direct = module?.exports.find((entry) => entry.type === "local" && entry.exportedAs === "default");
      expect(direct?.type).toBe("local");
      if (direct?.type !== "local") return;
      expect(direct.mechanism).toBe("cjs-module-value");
      expect(direct.target.range.start.index).toBe(tokenIndex(directCjsWidget, 5, "Widget"));

      const result = await goToDefinition(fixture.index, {
        file: fixture.file(useName),
        line: 2,
        column: columnOf(use, 2, "method"),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.definition.range.start.index).toBe(tokenIndex(directCjsWidget, 5, "method"));

      const refs = await findReferences(fixture.index, {
        file: fixture.file(widgetName),
        line: 5,
        column: columnOf(directCjsWidget, 5, "method"),
      });
      expect(refs.status).toBe("ok");
      expect(referenceSites(refs)).toContain(`${useName}:2`);
      expect(referenceSites(refs)).not.toContain(`${widgetName}:2`);

      const graph = await buildSymbolGraphDetailed(fixture.index);
      expect(callTargetIds(graph, "run")).toContain(
        fixture.file(widgetName) + "::method::" + tokenIndex(directCjsWidget, 5, "method"),
      );
      expect(callTargetIds(graph, "run")).not.toContain(
        fixture.file(widgetName) + "::method::" + tokenIndex(directCjsWidget, 2, "method"),
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["js", "ts", "tsx"] as const)("binds fallback direct CJS identifier exports in %s", async (extension) => {
    const widgetName = `widget.${extension}`;
    const fixture = await project({ [widgetName]: directCjsWidget });
    try {
      const file = fixture.file(widgetName);
      const native = fixture.index.byFile.get(fileIdentityKey(file));
      const fallback = collectLocalsAndExportsFromSource(file, directCjsWidget, supportForFile(file)!, [], {
        nativeMode: "off",
      });
      const direct = fallback.exports.find((entry) => entry.type === "local" && entry.exportedAs === "default");
      expect(direct?.type).toBe("local");
      if (direct?.type !== "local") return;
      expect(direct.mechanism).toBe("cjs-module-value");
      expect(direct.target.range.start.index).toBe(tokenIndex(directCjsWidget, 5, "Widget"));
      const nativeDirect = native?.exports.find((entry) => entry.type === "local" && entry.exportedAs === "default");
      if (nativeDirect?.type === "local") {
        expect(direct.target.localName).toBe(nativeDirect.target.localName);
        expect(direct.target.kind).toBe(nativeDirect.target.kind);
        expect(direct.target.range).toEqual(nativeDirect.target.range);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["js", "ts"] as const)("leaves a reassigned module.exports value unproven in %s", async (extension) => {
    const widgetName = `widget.${extension}`;
    const useName = `use.${extension}`;
    const widget = [
      "class First { static method() {} }",
      "class Second { static method() {} }",
      "module.exports = First;",
      "module.exports = Second;",
      "",
    ].join("\n");
    const importLine = extension === "js" ? 'const W = require("./widget");' : 'import W = require("./widget");';
    const use = [importLine, "function run() { W.method(); }", ""].join("\n");
    const fixture = await project({ [widgetName]: widget, [useName]: use });
    try {
      const file = fixture.file(widgetName);
      const fallback = collectLocalsAndExportsFromSource(file, widget, supportForFile(file)!, [], {
        nativeMode: "off",
      });
      for (const exports of [fixture.index.byFile.get(fileIdentityKey(file))?.exports, fallback.exports]) {
        expect(exports?.some((entry) => entry.type === "local" && entry.mechanism === "cjs-module-value")).toBe(false);
      }
      // Node binds the last assignment; codegraph must not name the first class.
      const result = await goToDefinition(fixture.index, {
        file: fixture.file(useName),
        line: 2,
        column: columnOf(use, 2, "method"),
      });
      if (result.status === "ok") {
        expect(result.definition.range.start.index).not.toBe(tokenIndex(widget, 1, "method"));
      }
      const graph = await buildSymbolGraphDetailed(fixture.index);
      expect(callTargetIds(graph, "run")).not.toContain(file + "::method::" + tokenIndex(widget, 1, "method"));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("preserves a direct CommonJS class value across a reopened disk cache", async () => {
    const widget = [
      "class Widget { static method() {} }",
      "function helper() {}",
      "module.exports = Widget;",
      "module.exports.helper = helper;",
      "",
    ].join("\n");
    const use = ['const W = require("./widget");', "function run() { W.method(); }", ""].join("\n");
    const fixture = await project({ "widget.js": widget, "use.js": use });
    const cacheOptions = { cache: "disk" as const, cacheLocation: "project", threads: 1 };
    try {
      const cold = await buildProjectIndexIncremental(fixture.root, cacheOptions);
      closeDiskCacheDatabase(fixture.root, cacheOptions);
      const warmReport: BuildReport = { timings: {} };
      const warm = await buildProjectIndexIncremental(fixture.root, { ...cacheOptions, report: warmReport });
      expect(warmReport.files?.parsed).toBe(0);

      const observe = async (index: ProjectIndex) => {
        const module = index.byFile.get(fileIdentityKey(fixture.file("widget.js")));
        const hasDirectValue = module?.exports.some(
          (entry) => entry.type === "local" && entry.exportedAs === "default" && entry.mechanism === "cjs-module-value",
        );
        const goto = await goToDefinition(index, {
          file: fixture.file("use.js"),
          line: 2,
          column: columnOf(use, 2, "method"),
        });
        const refs = await findReferences(index, {
          file: fixture.file("widget.js"),
          line: 1,
          column: columnOf(widget, 1, "method"),
        });
        const graph = await buildSymbolGraphDetailed(index);
        return {
          hasDirectValue,
          definition: goto.status === "ok" ? goto.definition.range.start.index : goto.status,
          references: referenceSites(refs),
          calls: callTargetIds(graph, "run"),
        };
      };
      const coldResult = await observe(cold);
      expect(coldResult.hasDirectValue).toBe(true);
      expect(coldResult.definition).toBe(tokenIndex(widget, 1, "method"));
      expect(coldResult.references).toContain("use.js:2");
      expect(coldResult.calls).toContain(fixture.file("widget.js") + "::method::" + tokenIndex(widget, 1, "method"));
      expect(await observe(warm)).toEqual(coldResult);
    } finally {
      closeDiskCacheDatabase(fixture.root, cacheOptions);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
  it("uses the visible CommonJS RHS binding instead of an earlier nested namesake", async () => {
    const widget = [
      "function decoy() {",
      "  class Widget { render() { return 'decoy'; } }",
      "  return Widget;",
      "}",
      "class Widget { render() { return 'real'; } }",
      "module.exports = Widget;",
      "",
    ].join("\n");
    const use = ['const W = require("./widget");', "function run() { return new W().render(); }", ""].join("\n");
    const fixture = await project({ "widget.js": widget, "use.js": use });
    try {
      const module = fixture.index.byFile.get(fileIdentityKey(fixture.file("widget.js")));
      const defaultExport = module?.exports.find((entry) => entry.type === "local" && entry.exportedAs === "default");
      expect(defaultExport?.type).toBe("local");
      if (defaultExport?.type !== "local") return;
      expect(defaultExport.target.range.start.line).toBe(5);

      const result = await goToDefinition(fixture.index, {
        file: fixture.file("use.js"),
        line: 2,
        column: columnOf(use, 2, "render"),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.definition.range.start.line).toBe(5);
      expect(result.definition.range.start.index).toBe(tokenIndex(widget, 5, "render"));

      const graph = await buildSymbolGraphDetailed(fixture.index);
      const targets = callTargetIds(graph, "run");
      expect(targets.some((id) => id.endsWith("::render::" + tokenIndex(widget, 5, "render")))).toBe(true);
      expect(targets.some((id) => id.endsWith("::render::" + tokenIndex(widget, 2, "render")))).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("honors a nested CommonJS RHS binding that shadows a module class", async () => {
    const widget = [
      "class Widget { render() { return 'outer'; } }",
      "function install() {",
      "  class Widget { render() { return 'inner'; } }",
      "  module.exports = Widget;",
      "}",
      "install();",
      "",
    ].join("\n");
    const use = ['const W = require("./widget");', "function run() { return new W().render(); }", ""].join("\n");
    const fixture = await project({ "widget.js": widget, "use.js": use });
    try {
      const module = fixture.index.byFile.get(fileIdentityKey(fixture.file("widget.js")));
      const target = module?.exports.find((entry) => entry.type === "local" && entry.exportedAs === "default");
      expect(target?.type).toBe("local");
      if (target?.type !== "local") return;
      expect(target.target.range.start.line).toBe(3);

      const result = await goToDefinition(fixture.index, {
        file: fixture.file("use.js"),
        line: 2,
        column: columnOf(use, 2, "render"),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.definition.range.start.line).toBe(3);
      expect(result.definition.range.start.index).toBe(tokenIndex(widget, 3, "render"));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("treats a whole-module require as a namespace binding", async () => {
    const util = "exports.helper = function helper() { return 1; };\n";
    const decoy = "exports.helper = function helper() { return 2; };\n";
    const use = ['const util = require("./util");', "function run() { return util.helper(); }", ""].join("\n");
    const decoyUse = ['const util = require("./decoy");', "function decoyRun() { return util.helper(); }", ""].join(
      "\n",
    );
    const fixture = await project({ "util.js": util, "decoy.js": decoy, "use.js": use, "decoy-use.js": decoyUse });
    try {
      const result = await goToDefinition(fixture.index, {
        file: fixture.file("use.js"),
        line: 2,
        column: columnOf(use, 2, "helper"),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(fixture.file("util.js")));

      const refs = await findReferences(fixture.index, {
        file: result.definition.file,
        line: result.definition.range.start.line,
        column: result.definition.range.start.column,
      });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") return;
      expect(refs.referenceCoverage?.state).toBe("complete");
      const sites = referenceSites(refs);
      expect(sites).toContain("use.js:2");
      expect(sites.some((site) => site.startsWith("decoy"))).toBe(false);

      const graph = await buildSymbolGraphDetailed(fixture.index);
      const helperIndex = result.definition.range.start.index;
      expect(
        callTargetIds(graph, "run").some((id) => id.includes("util.js") && id.endsWith(`::helper::${helperIndex}`)),
      ).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("treats an awaited dynamic import as a namespace binding", async () => {
    const lazy = 'export function thing(): string { return "lazy"; }\n';
    const decoy = 'export function thing(): string { return "decoy"; }\n';
    const use = [
      "export async function run(): Promise<string> {",
      '  const mod = await import("./lazy");',
      "  return mod.thing();",
      "}",
      "",
    ].join("\n");
    const decoyUse = [
      "export async function decoyRun(): Promise<string> {",
      '  const mod = await import("./decoy");',
      "  return mod.thing();",
      "}",
      "",
    ].join("\n");
    const fixture = await project({ "lazy.ts": lazy, "decoy.ts": decoy, "use.ts": use, "decoy-use.ts": decoyUse });
    try {
      const result = await goToDefinition(fixture.index, {
        file: fixture.file("use.ts"),
        line: 3,
        column: columnOf(use, 3, "thing"),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(fixture.file("lazy.ts")));
      expect(result.definition.range.start.line).toBe(1);

      const refs = await findReferences(fixture.index, {
        file: fixture.file("lazy.ts"),
        line: 1,
        column: columnOf(lazy, 1, "thing"),
      });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") return;
      expect(refs.referenceCoverage?.state).toBe("complete");
      const sites = referenceSites(refs);
      expect(sites).toContain("use.ts:3");
      expect(sites.some((site) => site.startsWith("decoy"))).toBe(false);

      const graph = await buildSymbolGraphDetailed(fixture.index);
      const thingIndex = tokenIndex(lazy, 1, "thing");
      expect(callTargetIds(graph, "run").some((id) => id.endsWith(`::thing::${thingIndex}`))).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not let a parameter type annotation shadow an imported enum", async () => {
    const status = ["export enum Status {", "  Active,", "  Inactive,", "}", ""].join("\n");
    const decoy = ["export enum Status {", "  Active,", "  Inactive,", "}", ""].join("\n");
    const use = [
      'import { Status } from "./status";',
      "enum Palette { Active }",
      "export function withParam(s: Status): Status {",
      "  return Status.Active;",
      "}",
      "export function noParam(): Status {",
      "  return Status.Active;",
      "}",
      "export const swatch = Palette.Active;",
      "",
    ].join("\n");
    const decoyUse = [
      'import { Status } from "./decoy";',
      "export function decoyUse(): Status {",
      "  return Status.Active;",
      "}",
      "",
    ].join("\n");
    const fixture = await project({
      "status.ts": status,
      "decoy.ts": decoy,
      "use.ts": use,
      "decoy-use.ts": decoyUse,
    });
    try {
      const withParam = await goToDefinition(fixture.index, {
        file: fixture.file("use.ts"),
        line: 4,
        column: columnOf(use, 4, "Active"),
      });
      expect(withParam.status).toBe("ok");
      if (withParam.status !== "ok") return;
      expect(fileIdentityKey(withParam.definition.file)).toBe(fileIdentityKey(fixture.file("status.ts")));
      expect(withParam.definition.range.start.line).toBe(2);

      const noParam = await goToDefinition(fixture.index, {
        file: fixture.file("use.ts"),
        line: 7,
        column: columnOf(use, 7, "Active"),
      });
      expect(noParam.status).toBe("ok");
      if (noParam.status !== "ok") return;
      expect(noParam.definition.range.start.line).toBe(2);

      const refs = await findReferences(fixture.index, {
        file: fixture.file("status.ts"),
        line: 2,
        column: columnOf(status, 2, "Active"),
      });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") return;
      expect(refs.referenceCoverage?.state).toBe("complete");
      const sites = referenceSites(refs);
      expect(sites).toContain("use.ts:4");
      expect(sites).toContain("use.ts:7");
      expect(sites).not.toContain("use.ts:9");
      expect(sites.some((site) => site.startsWith("decoy"))).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
