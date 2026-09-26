import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSymbolGraphDetailed,
  findReferences,
  goToDefinition,
  listSymbols,
  type FindReferencesResult,
  type SymbolGraph,
} from "../src/index.js";
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
  const root = (await mkdtemp(path.join(os.tmpdir(), "cg-audit-tsjs-"))).replace(/\\/g, "/");
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

describe("TypeScript and JavaScript accuracy audit", () => {
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
