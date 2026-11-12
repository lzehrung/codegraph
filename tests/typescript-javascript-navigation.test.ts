import {
  expectTypeScriptSplitMethods,
  typescriptSplitMethodSources,
} from "./helpers/typescript-split-method-fixture.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  buildProjectIndex,
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
  it.each(["ts", "tsx"] as const)(
    "resolves a forward type alias after semicolonless generic signatures in %s across disk cache reload",
    async (extension) => {
      const fileName = `forward.${extension}`;
      const source = [
        "export interface Handler {",
        "  <T0>(): Forward<T0>",
        "  <T1>(): Forward<T1>",
        "  <T2>(): Forward<T2>",
        "}",
        "type Forward<T> = T;",
        "",
      ].join("\n");
      const decoy = "export type Forward<T> = { unrelated: T };\n";
      const fixture = await project({ [fileName]: source, "decoy.ts": decoy });
      const cacheOptions = { cache: "disk" as const, cacheLocation: "project", threads: 1 };
      try {
        const observe = async (index: ProjectIndex) => {
          const gotos = await Promise.all(
            [2, 3, 4].map((line) =>
              goToDefinition(index, { file: fixture.file(fileName), line, column: columnOf(source, line, "Forward") }),
            ),
          );
          const references = await findReferences(index, {
            file: fixture.file(fileName),
            line: 6,
            column: columnOf(source, 6, "Forward"),
          });
          const decoyReferences = await findReferences(index, {
            file: fixture.file("decoy.ts"),
            line: 1,
            column: columnOf(decoy, 1, "Forward"),
          });
          const graph = await buildSymbolGraphDetailed(index);
          return {
            definitions: gotos.map((goto) =>
              goto.status === "ok"
                ? `${path.basename(goto.definition.file)}:${goto.definition.range.start.line}`
                : goto.status,
            ),
            references: referenceSites(references),
            coverage: references.status === "ok" ? references.referenceCoverage?.state : references.status,
            decoyReferences: referenceSites(decoyReferences),
            hasAliasNode: [...graph.nodes.values()].some(
              (node) =>
                node.name === "Forward" && fileIdentityKey(node.file) === fileIdentityKey(fixture.file(fileName)),
            ),
          };
        };
        const result = await observe(fixture.index);
        expect(result.definitions).toEqual([`${fileName}:6`, `${fileName}:6`, `${fileName}:6`]);
        expect(result.references).toEqual([`${fileName}:2`, `${fileName}:3`, `${fileName}:4`, `${fileName}:6`]);
        expect(result.coverage).toBe("complete");
        expect(result.decoyReferences).toEqual(["decoy.ts:1"]);
        expect(result.hasAliasNode).toBe(true);

        const cold = await buildProjectIndexIncremental(fixture.root, cacheOptions);
        expect(await observe(cold)).toEqual(result);
        closeDiskCacheDatabase(fixture.root, cacheOptions);
        const warmReport: BuildReport = { timings: {} };
        const warm = await buildProjectIndexIncremental(fixture.root, { ...cacheOptions, report: warmReport });
        expect(warmReport.files?.parsed).toBe(0);
        expect(await observe(warm)).toEqual(result);
      } finally {
        closeDiskCacheDatabase(fixture.root, cacheOptions);
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it.each(["ts", "tsx"] as const)(
    "keeps overloaded router members and exports after adjacent call signatures in %s through cache reload",
    async (extension) => {
      const routerFile = `router.${extension}`;
      const consumerFile = `consumer.${extension}`;
      const router = [
        "export type Handler = () => void",
        "export interface Router {",
        "  <T>(path: string): T",
        "  <U>(path: string, fallback: U): U",
        "  /** Registers a GET route. */",
        "  get(path: string): Router",
        "  get(path: string, handler: Handler): Router",
        "  new (name: string): Router",
        "  readonly name: string",
        "  [route: string]: unknown",
        "  <V>(): V",
        "  post(path: string): Router",
        "}",
        "export function createRouter(): Router { return null as never }",
        "",
        "export const DEFAULT_PATH = '/'",
        "",
      ].join("\n");
      const consumer = [
        "import { createRouter, DEFAULT_PATH, type Handler, type Router } from './router'",
        "export function wire(h: Handler): Router {",
        "  const r: Router = createRouter()",
        "  r.get(DEFAULT_PATH)",
        "  r.get(DEFAULT_PATH, h)",
        "  return r.post(DEFAULT_PATH)",
        "}",
        "",
      ].join("\n");
      const decoy = [
        "export interface Other { get(path: string): Other; post(path: string): Other }",
        "export function useOther(o: Other): Other { return o.get('/').post('/') }",
        "",
      ].join("\n");
      const fixture = await project({ [routerFile]: router, [consumerFile]: consumer, "decoy.ts": decoy });
      const cacheOptions = { cache: "disk" as const, cacheLocation: "project", threads: 1 };
      try {
        const observe = async (index: ProjectIndex) => {
          const goto = async (file: string, source: string, line: number, name: string) => {
            const result = await goToDefinition(index, {
              file: fixture.file(file),
              line,
              column: columnOf(source, line, name),
            });
            return result.status === "ok"
              ? `${path.basename(result.definition.file)}:${result.definition.range.start.line}`
              : result.status;
          };
          const postRefs = await findReferences(index, {
            file: fixture.file(routerFile),
            line: 12,
            column: columnOf(router, 12, "post"),
          });
          const routerRefs = await findReferences(index, {
            file: fixture.file(routerFile),
            line: 2,
            column: columnOf(router, 2, "Router"),
          });
          const graph = await buildSymbolGraphDetailed(index);
          const routerId = fixture.file(routerFile) + "::Router::" + tokenIndex(router, 2, "Router");
          const members = graph.edges
            .filter((edge) => edge.label === "member_of" && edge.to === routerId)
            .map((edge) => edge.from)
            .sort();
          const gets = listSymbols(index, { file: fixture.file(routerFile) })
            .filter((symbol) => symbol.name === "get")
            .map((symbol) => ({ line: symbol.range?.start.line, docstring: symbol.docstring ?? null }));
          const exports = index.byFile
            .get(fileIdentityKey(fixture.file(routerFile)))
            ?.exports.filter((entry) => entry.type === "local")
            .map((entry) => entry.exportedAs);
          return {
            gotos: await Promise.all([
              goto(consumerFile, consumer, 4, "get"),
              goto(consumerFile, consumer, 5, "get"),
              goto(consumerFile, consumer, 6, "post"),
              goto(consumerFile, consumer, 3, "createRouter"),
              goto(consumerFile, consumer, 4, "DEFAULT_PATH"),
              goto("decoy.ts", decoy, 2, "get"),
            ]),
            post: {
              status: postRefs.status,
              sites: referenceSites(postRefs).sort(),
              coverage: postRefs.status === "ok" ? postRefs.referenceCoverage?.state : null,
              reasons: postRefs.status === "ok" ? postRefs.referenceCoverage?.reasons : undefined,
              affectedFiles:
                postRefs.status === "ok"
                  ? postRefs.referenceCoverage?.affectedFiles?.map((file) => path.basename(file))
                  : undefined,
            },
            router: {
              status: routerRefs.status,
              sites: referenceSites(routerRefs).sort(),
              coverage: routerRefs.status === "ok" ? routerRefs.referenceCoverage?.state : null,
            },
            calls: callTargetIds(graph, "wire").sort(),
            members,
            gets,
            exports,
          };
        };
        const expected = {
          gotos: [
            `${routerFile}:6`,
            `${routerFile}:7`,
            `${routerFile}:12`,
            `${routerFile}:14`,
            `${routerFile}:16`,
            "decoy.ts:1",
          ],
          post: {
            status: "ok",
            sites: [`${consumerFile}:6`, `${routerFile}:12`],
            coverage: "partial",
            reasons: ["strategy_unavailable"],
            affectedFiles: ["decoy.ts"],
          },
          router: {
            status: "ok",
            sites: [
              `${consumerFile}:1`,
              `${consumerFile}:2`,
              `${consumerFile}:3`,
              `${routerFile}:12`,
              `${routerFile}:14`,
              `${routerFile}:2`,
              `${routerFile}:6`,
              `${routerFile}:7`,
              `${routerFile}:8`,
            ],
            coverage: "complete",
          },
        };
        const result = await observe(fixture.index);
        expect(result.gotos).toEqual(expected.gotos);
        expect(result.post).toEqual(expected.post);
        expect(result.router).toEqual(expected.router);
        expect(result.calls).toEqual([
          fixture.file(routerFile) + "::createRouter::" + tokenIndex(router, 14, "createRouter"),
          fixture.file(routerFile) + "::get::" + tokenIndex(router, 6, "get"),
          fixture.file(routerFile) + "::get::" + tokenIndex(router, 7, "get"),
          fixture.file(routerFile) + "::post::" + tokenIndex(router, 12, "post"),
        ]);
        expect(result.members).toEqual(
          expect.arrayContaining([
            fixture.file(routerFile) + "::get::" + tokenIndex(router, 6, "get"),
            fixture.file(routerFile) + "::get::" + tokenIndex(router, 7, "get"),
            fixture.file(routerFile) + "::post::" + tokenIndex(router, 12, "post"),
          ]),
        );
        expect(result.calls.every((id) => id.startsWith(fixture.file(routerFile) + "::"))).toBe(true);
        expect(result.gets).toEqual([
          { line: 6, docstring: "Registers a GET route." },
          { line: 7, docstring: null },
        ]);
        expect(result.exports).toEqual(["createRouter", "DEFAULT_PATH"]);
        const cold = await buildProjectIndexIncremental(fixture.root, cacheOptions);
        expect(await observe(cold)).toEqual(result);
        closeDiskCacheDatabase(fixture.root, cacheOptions);
        const warmReport: BuildReport = { timings: {} };
        const warm = await buildProjectIndexIncremental(fixture.root, { ...cacheOptions, report: warmReport });
        expect(warmReport.files?.parsed).toBe(0);
        expect(await observe(warm)).toEqual(result);
      } finally {
        closeDiskCacheDatabase(fixture.root, cacheOptions);
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it.each(["js", "ts", "tsx"] as const)("does not index missing method names in %s", async (extension) => {
    const fileName = `missing.${extension}`;
    const source = ["class A {", "  () {}", "  valid() {}", "}", ""].join("\n");
    const fixture = await project({ [fileName]: source });
    try {
      const symbols = listSymbols(fixture.index, { file: fixture.file(fileName) });
      expect(symbols.map((symbol) => symbol.name)).toEqual(expect.arrayContaining(["A", "valid"]));
      expect(symbols.some((symbol) => !symbol.name)).toBe(false);
      const graph = await buildSymbolGraphDetailed(fixture.index);
      expect([...graph.nodes.values()].some((node) => !node.name)).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["ts", "tsx"] as const)(
    "discovers forward aliases and methods in TypeScript declarations from %s",
    async (extension) => {
      const declaration = [
        "export interface Handler {",
        "  <T>(): Alias<T>",
        "  <U>(): Alias<U>",
        "  get(): void",
        "}",
        "export type Alias<T> = T",
        "",
      ].join("\n");
      const use = [
        "import type { Handler, Alias } from './types'",
        "export const value: Alias<string> = 'ok'",
        "declare const handler: Handler",
        "handler.get()",
        "",
      ].join("\n");
      const fixture = await project({ "types.d.ts": declaration, [`use.${extension}`]: use });
      try {
        const index = await buildProjectIndex(fixture.root, { cache: "off" });
        const goto = async (file: string, source: string, line: number, name: string) => {
          const result = await goToDefinition(index, {
            file: fixture.file(file),
            line,
            column: columnOf(source, line, name),
          });
          return result.status === "ok"
            ? `${path.basename(result.definition.file)}:${result.definition.range.start.line}`
            : result.status;
        };
        expect(await goto("types.d.ts", declaration, 2, "Alias")).toBe("types.d.ts:6");
        expect(await goto("types.d.ts", declaration, 3, "Alias")).toBe("types.d.ts:6");
        expect(await goto(`use.${extension}`, use, 2, "Alias")).toBe("types.d.ts:6");
        expect(await goto(`use.${extension}`, use, 4, "get")).toBe("types.d.ts:4");
        const refs = await findReferences(index, {
          file: fixture.file("types.d.ts"),
          line: 6,
          column: columnOf(declaration, 6, "Alias"),
        });
        expect(refs.status).toBe("ok");
        if (refs.status !== "ok") return;
        expect(refs.referenceCoverage.state).toBe("complete");
        expect(referenceSites(refs).sort()).toEqual([
          "types.d.ts:2",
          "types.d.ts:3",
          "types.d.ts:6",
          `use.${extension}:1`,
          `use.${extension}:2`,
        ]);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it.each(["ts", "tsx"] as const)(
    "excludes missing-name declarations without losing later aliases in %s",
    async (extension) => {
      const fileName = `split.${extension}`;
      const source = [
        "class A {",
        "  fixed() {}",
        "  m",
        "  <T>() {}",
        "  other() {}",
        "}",
        "type After = number",
        "let value: After = 1",
        "",
      ].join("\n");
      const fixture = await project({ [fileName]: source });
      try {
        const symbols = listSymbols(fixture.index, { file: fixture.file(fileName) });
        expect(symbols.map((symbol) => symbol.name)).toEqual(
          expect.arrayContaining(["A", "fixed", "m", "other", "After", "value"]),
        );
        expect(symbols.some((symbol) => !symbol.name)).toBe(false);
        const graph = await buildSymbolGraphDetailed(fixture.index);
        expect([...graph.nodes.values()].some((node) => !node.name)).toBe(false);
        const goto = await goToDefinition(fixture.index, {
          file: fixture.file(fileName),
          line: 8,
          column: columnOf(source, 8, "After"),
        });
        expect(goto.status).toBe("ok");
        if (goto.status === "ok") expect(goto.definition.range.start.line).toBe(7);
        const refs = await findReferences(fixture.index, {
          file: fixture.file(fileName),
          line: 7,
          column: columnOf(source, 7, "After"),
        });
        expect(refs.status).toBe("ok");
        if (refs.status === "ok") {
          expect(referenceSites(refs)).toEqual([`${fileName}:7`, `${fileName}:8`]);
          expect(refs.referenceCoverage.state).toBe("partial");
          expect(refs.referenceCoverage.reasons).toContain("parse_error");
        }
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { wrapper: "declare module 'pkg'", prelude: [] },
    { wrapper: "declare global", prelude: ["export {}"] },
    { wrapper: "declare namespace NS", prelude: [] },
    { wrapper: "namespace NS", prelude: [] },
  ])("keeps a later alias inside $wrapper distinct from a following file alias", async ({ wrapper, prelude }) => {
    const prefix = [...prelude, `${wrapper} {`];
    const memberExport = wrapper === "declare global" ? "" : "export ";
    const source = [
      ...prefix,
      `  ${memberExport}interface Handler {`,
      "    <T0>(): Alias<T0>",
      "    <T1>(): Alias<T1>",
      "    <T2>(): Alias<T2>",
      "  }",
      `  ${memberExport}type Alias<T> = T`,
      "}",
      "type Outer = number",
      "let o: Outer = 1",
      "",
    ].join("\n");
    const fixture = await project({ "ambient.ts": source });
    try {
      const aliasLine = prefix.length + 6;
      for (let line = prefix.length + 2; line <= prefix.length + 4; line++) {
        const result = await goToDefinition(fixture.index, {
          file: fixture.file("ambient.ts"),
          line,
          column: columnOf(source, line, "Alias"),
        });
        expect(result.status).toBe("ok");
        if (result.status === "ok") expect(result.definition.range.start.line).toBe(aliasLine);
      }
      const refs = await findReferences(fixture.index, {
        file: fixture.file("ambient.ts"),
        line: aliasLine,
        column: columnOf(source, aliasLine, "Alias"),
      });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        expect(refs.referenceCoverage.state).toBe("complete");
        expect(referenceSites(refs)).toEqual(
          [prefix.length + 2, prefix.length + 3, prefix.length + 4, aliasLine].map((line) => `ambient.ts:${line}`),
        );
      }
      const outerLine = prefix.length + 8;
      const outerUseLine = prefix.length + 9;
      const outerGoto = await goToDefinition(fixture.index, {
        file: fixture.file("ambient.ts"),
        line: outerUseLine,
        column: columnOf(source, outerUseLine, "Outer"),
      });
      expect(outerGoto.status).toBe("ok");
      if (outerGoto.status === "ok") expect(outerGoto.definition.range.start.line).toBe(outerLine);
      const outerRefs = await findReferences(fixture.index, {
        file: fixture.file("ambient.ts"),
        line: outerLine,
        column: columnOf(source, outerLine, "Outer"),
      });
      expect(outerRefs.status).toBe("ok");
      if (outerRefs.status === "ok") {
        expect(outerRefs.referenceCoverage.state).toBe("complete");
        expect(referenceSites(outerRefs)).toEqual([`ambient.ts:${outerLine}`, `ambient.ts:${outerUseLine}`]);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("indexes a method after generic signatures inside a TypeScript module augmentation", async () => {
    const router = "export interface Router { base(): void }\n";
    const augmentation = [
      "import './router'",
      "declare module './router' {",
      "  interface Router {",
      "    <T0>(): T0",
      "    <T1>(): T1",
      "    <T2>(): T2",
      "    extra(): void",
      "  }",
      "}",
      "",
    ].join("\n");
    const fixture = await project({ "router.ts": router, "augment.ts": augmentation });
    try {
      const extra = listSymbols(fixture.index, { file: fixture.file("augment.ts") }).find(
        (symbol) => symbol.name === "extra",
      );
      expect(extra?.range?.start.line).toBe(7);
      const graph = await buildSymbolGraphDetailed(fixture.index);
      expect(
        [...graph.nodes.values()].some(
          (node) => node.name === "extra" && fileIdentityKey(node.file) === fileIdentityKey(fixture.file("augment.ts")),
        ),
      ).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["ts", "tsx"] as const)("keeps the import-type return parse limit explicit in %s", async (extension) => {
    const fileName = `limits.${extension}`;
    const importType = [
      "interface H {",
      "  <T>(): import('x').Foo<string>",
      "  <U>(): Promise<U>",
      "}",
      "type After = number",
      "let value: After = 1",
      "",
    ].join("\n");
    const fixture = await project({
      [fileName]: importType,
      "x.d.ts": "declare module 'x' { export type Foo<T> = T }\n",
    });
    try {
      const goto = await goToDefinition(fixture.index, {
        file: fixture.file(fileName),
        line: 6,
        column: columnOf(importType, 6, "After"),
      });
      const refs = await findReferences(fixture.index, {
        file: fixture.file(fileName),
        line: 5,
        column: columnOf(importType, 5, "After"),
      });
      if (extension === "ts") {
        expect(goto.status).toBe("not_found");
        expect(refs.status).toBe("not_found");
      } else {
        expect(goto.status).toBe("ok");
        if (goto.status === "ok") expect(goto.definition.range.start.line).toBe(5);
        expect(refs.status).toBe("ok");
        if (refs.status === "ok") {
          expect(referenceSites(refs)).toEqual([`${fileName}:5`, `${fileName}:6`]);
          expect(refs.referenceCoverage.state).toBe("partial");
          expect(refs.referenceCoverage.reasons).toContain("parse_error");
        }
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  describe.each(["ts", "tsx"] as const)("split generic methods in %s", (extension) => {
    it.each([
      { declaration: ["  m", "  <T>(): void {}"], role: "implementation", abstract: false },
      {
        declaration: ["  m? /* name */", "  // signature", "  <T>(): void {}"],
        role: "implementation",
        abstract: false,
      },
      { declaration: ["  abstract m", "  <T>(): void"], role: "signature", abstract: true },
    ])("retains class split method kind, arity, and $role metadata", async ({ declaration, role, abstract }) => {
      const fileName = `class.${extension}`;
      const source = [
        "class Base { m(value: number): void {} }",
        "abstract class Own extends Base {",
        ...declaration,
        "}",
        "declare const x: Own;",
        "x.m<string>();",
        "x.m();",
        "export function wrong(x: Own) { x.m(1); }",
      ].join("\n");
      const fixture = await project({ [fileName]: source });
      const file = fixture.file(fileName);
      const compiler = ts.createLanguageService({
        getScriptFileNames: () => [file],
        getScriptVersion: () => "1",
        getScriptSnapshot: () => ts.ScriptSnapshot.fromString(source),
        getCurrentDirectory: () => fixture.root,
        getCompilationSettings: () => ({ noLib: true }),
        getDefaultLibFileName: () => "",
        fileExists: (name) => name === file,
        readFile: (name) => (name === file ? source : undefined),
      });
      try {
        expect(compiler.getSyntacticDiagnostics(file)).toEqual([]);
        const parsed = compiler.getProgram()!.getSourceFile(file)!;
        const owner = parsed.statements[1]!;
        if (!ts.isClassDeclaration(owner)) throw new Error("Expected class");
        expect(owner.members.map((member) => ts.SyntaxKind[member.kind])).toEqual(["MethodDeclaration"]);
        const ownIndex = tokenIndex(source, 3, "m");
        for (const line of [declaration.length + 5, declaration.length + 6]) {
          const position = tokenIndex(source, line, "m");
          expect(
            compiler.getDefinitionAtPosition(file, position)?.map((definition) => definition.textSpan.start),
          ).toEqual([ownIndex]);
          expect(
            compiler
              .findReferences(file, position)
              ?.some((group) => group.references.some((reference) => reference.textSpan.start === ownIndex)),
          ).toBe(true);
          const target = await goToDefinition(fixture.index, { file, line, column: columnOf(source, line, "m") });
          expect(target.status).toBe("ok");
          if (target.status === "ok") {
            expect(target.definition.kind).toBe("function");
            expect(target.definition.range.start.index).toBe(ownIndex);
            expect(target.definition.callable?.role).toBe(role);
            expect(target.definition.callable?.arity).toEqual({ minArgs: 0, maxArgs: 0 });
          }
        }
        const wrongLine = declaration.length + 7;
        expect(
          (await goToDefinition(fixture.index, { file, line: wrongLine, column: columnOf(source, wrongLine, "m(1)") }))
            .status,
        ).toBe("not_found");
        const graph = await buildSymbolGraphDetailed(fixture.index);
        expect(callTargetIds(graph, "wrong")).toEqual([]);
        const own = graph.nodes.get(`${file}::m::${ownIndex}`);
        expect(own?.kind).toBe("function");
        expect(!!own?.implementationTarget).toBe(abstract);
      } finally {
        compiler.dispose();
        await rm(fixture.root, { recursive: true, force: true });
      }
    });

    it("keeps cross-file receivers on their own interface and class methods after reopening", async () => {
      const fixture = await project(typescriptSplitMethodSources(extension));
      const options = { cache: "disk" as const, cacheLocation: "project", threads: 1 };
      try {
        await expectTypeScriptSplitMethods(fixture.index, fixture.root, extension);
        await expectTypeScriptSplitMethods(
          await buildProjectIndexIncremental(fixture.root, options),
          fixture.root,
          extension,
        );
        closeDiskCacheDatabase(fixture.root, options);
        const report: BuildReport = { timings: {} };
        await expectTypeScriptSplitMethods(
          await buildProjectIndexIncremental(fixture.root, { ...options, report }),
          fixture.root,
          extension,
        );
        expect(report.files?.parsed).toBe(0);
      } finally {
        closeDiskCacheDatabase(fixture.root, options);
        await rm(fixture.root, { recursive: true, force: true });
      }
    });

    it.each(["<T>()", "()"])("does not invent a method from a split new %s construct signature", async (parameters) => {
      const fileName = `construct.${extension}`;
      const source = [
        "interface Base { new(): void }",
        "interface C extends Base {",
        "  new",
        `  ${parameters}: C`,
        "}",
        "declare const ctor: C;",
        "const value = new ctor();",
      ].join("\n");
      const fixture = await project({ [fileName]: source });
      const file = fixture.file(fileName);
      const compiler = ts.createLanguageService({
        getScriptFileNames: () => [file],
        getScriptVersion: () => "1",
        getScriptSnapshot: () => ts.ScriptSnapshot.fromString(source),
        getCurrentDirectory: () => fixture.root,
        getCompilationSettings: () => ({ noLib: true }),
        getDefaultLibFileName: () => "",
        fileExists: (name) => name === file,
        readFile: (name) => (name === file ? source : undefined),
      });
      try {
        expect(compiler.getSyntacticDiagnostics(file)).toEqual([]);
        const declaration = compiler.getProgram()!.getSourceFile(file)!.statements[1]!;
        if (!ts.isInterfaceDeclaration(declaration)) throw new Error("Expected construct owner");
        expect(declaration.members.map((member) => ts.SyntaxKind[member.kind])).toEqual(["ConstructSignature"]);
        expect(compiler.getDefinitionAtPosition(file, tokenIndex(source, 3, "new")) ?? []).toEqual([]);
        expect(compiler.findReferences(file, tokenIndex(source, 3, "new"))).toBeUndefined();
        expect(fixture.index.byFile.get(fileIdentityKey(file))?.locals.some((local) => local.localName === "new")).toBe(
          false,
        );
        const target = await goToDefinition(fixture.index, { file, line: 3, column: 3 });
        expect(target.status).toBe("not_found");
        const graph = await buildSymbolGraphDetailed(fixture.index);
        expect([...graph.nodes.values()].some((node) => node.name === "new")).toBe(false);
      } finally {
        compiler.dispose();
        await rm(fixture.root, { recursive: true, force: true });
      }
    });

    it.each([
      { name: "get", kind: "MethodSignature" },
      { name: "set", kind: "MethodSignature" },
      { name: "new?", kind: "MethodSignature", indexedName: "new" },
      { name: "readonly new", kind: "MethodSignature", indexedName: "new" },
      { name: "readonly new?", kind: "MethodSignature", indexedName: "new" },
      { name: '"m"', kind: "MethodSignature" },
      { name: "1", kind: "MethodSignature" },
      { name: '["m"]', kind: "MethodSignature" },
      { name: "[key]", kind: "MethodSignature" },
      { name: 'readonly "m"?', kind: "MethodSignature", indexedName: '"m"' },
      { name: 'readonly ["m"]?', kind: "MethodSignature", indexedName: '["m"]' },
      { name: "get m", kind: "GetAccessor", indexedName: "m" },
      { name: "set m", kind: "SetAccessor", indexedName: "m" },
    ])(
      "preserves TypeScript's $kind parse for $name without inventing an accessor method",
      async ({ name, kind, indexedName }) => {
        const fileName = `names.${extension}`;
        const memberName = indexedName ?? name;
        let use = "x.m<string>();";
        if (name === "get" || name === "set") use = `x.${name}<string>();`;
        if (memberName === "new") use = "x.new<string>();";
        if (name === "1") use = "x[1]<string>();";
        const source = [
          "declare const key: 'm';",
          "interface Base { m(value: number): void }",
          "interface Own extends Base {",
          `  ${name}`,
          "  <T>(): void",
          "}",
          "declare const x: Own;",
          use,
        ].join("\n");
        const fixture = await project({ [fileName]: source });
        const file = fixture.file(fileName);
        const compiler = ts.createLanguageService({
          getScriptFileNames: () => [file],
          getScriptVersion: () => "1",
          getScriptSnapshot: () => ts.ScriptSnapshot.fromString(source),
          getCurrentDirectory: () => fixture.root,
          getCompilationSettings: () => ({ noLib: true }),
          getDefaultLibFileName: () => "",
          fileExists: (candidate) => candidate === file,
          readFile: (candidate) => (candidate === file ? source : undefined),
        });
        try {
          expect(compiler.getSyntacticDiagnostics(file)).toEqual([]);
          const parsed = compiler.getProgram()!.getSourceFile(file)!;
          const owner = parsed.statements[2]!;
          if (!ts.isInterfaceDeclaration(owner)) throw new Error("Expected named owner");
          expect(owner.members.map((member) => ts.SyntaxKind[member.kind])).toEqual([kind]);
          const token = name === "1" ? "1" : ".";
          const useIndex = source.lastIndexOf(use) + use.indexOf(token) + (name === "1" ? 0 : 1);
          expect(
            compiler
              .getDefinitionAtPosition(file, useIndex)
              ?.every((definition) => parsed.getLineAndCharacterOfPosition(definition.textSpan.start).line === 3),
          ).toBe(true);
          if (name === "[key]") expect(compiler.findReferences(file, useIndex)).toBeUndefined();
          else expect(compiler.findReferences(file, useIndex)?.length).toBeGreaterThan(0);
          const local = fixture.index.byFile
            .get(fileIdentityKey(file))
            ?.locals.find((definition) => definition.range.start.line === 4 && definition.localName === memberName);
          expect(local?.kind).toBe("function");
          expect(local?.callable?.arity).toEqual({ minArgs: 0, maxArgs: 0 });
          const graph = await buildSymbolGraphDetailed(fixture.index);
          expect(graph.nodes.get(`${file}::${memberName}::${local!.range.start.index}`)?.kind).toBe("function");
          if (memberName === "new" || memberName === "get" || memberName === "set") {
            const target = await goToDefinition(fixture.index, { file, line: 8, column: use.indexOf(".") + 2 });
            expect(target.status).toBe("ok");
            if (target.status === "ok") expect(target.definition.range.start.index).toBe(local!.range.start.index);
            const refs = await findReferences(fixture.index, {
              file,
              line: 4,
              column: local!.range.start.column,
            });
            expect(referenceSites(refs)).toEqual([`${fileName}:4`, `${fileName}:8`]);
          }
        } finally {
          compiler.dispose();
          await rm(fixture.root, { recursive: true, force: true });
        }
      },
    );

    for (const owner of ["interface A extends B {", "type A = {"]) {
      it.each([
        { label: "split", declaration: ["  m", "  <T>(): void"], args: "", arity: { minArgs: 0, maxArgs: 0 } },
        { label: "optional", declaration: ["  m?", "  <T>(): void"], args: "", arity: { minArgs: 0, maxArgs: 0 } },
        {
          label: "readonly",
          declaration: ["  readonly m", "  <T>(): void"],
          args: "",
          arity: { minArgs: 0, maxArgs: 0 },
        },
        {
          label: "readonly optional",
          declaration: ["  readonly m?", "  <T>(): void"],
          args: "",
          arity: { minArgs: 0, maxArgs: 0 },
        },
        ...["public", "protected", "private", "static", "override"].map((modifier) => ({
          label: modifier,
          declaration: [`  ${modifier} m?`, "  <T>(): void"],
          args: "",
          arity: { minArgs: 0, maxArgs: 0 },
        })),
        { label: "one-line", declaration: ["  m<T>(): void"], args: "", arity: { minArgs: 0, maxArgs: 0 } },
        {
          label: "split with parameters",
          declaration: ["  m", "  <T>(value: T, extra?: number): void"],
          args: "'x'",
          arity: { minArgs: 1, maxArgs: 2 },
        },
        {
          label: "split with a comment",
          declaration: ["  m /* name */", "  // signature", "  <T>(...values: T[]): void"],
          args: "'x', 'y'",
          arity: { minArgs: 0, maxArgs: null },
        },
      ])(`indexes a $label method in ${owner}`, async ({ declaration, args, arity }) => {
        const fileName = `split.${extension}`;
        const source = [
          "interface B { m(): void }",
          owner,
          ...declaration,
          "}",
          "declare const a: A;",
          `a.m<string>(${args});`,
          `function run(a: A) { a.m<string>(${args}); }`,
          `a.m(${args});`,
          "",
        ].join("\n");
        const callLine = declaration.length + 5;
        const fixture = await project({ [fileName]: source });
        const file = fixture.file(fileName);
        const service = ts.createLanguageService({
          getScriptFileNames: () => [file],
          getScriptVersion: () => "1",
          getScriptSnapshot: (name) => (name === file ? ts.ScriptSnapshot.fromString(source) : undefined),
          getCurrentDirectory: () => fixture.root,
          getCompilationSettings: () => ({ noLib: true }),
          getDefaultLibFileName: () => "",
          fileExists: (name) => name === file,
          readFile: (name) => (name === file ? source : undefined),
        });
        try {
          expect(service.getSyntacticDiagnostics(file)).toEqual([]);
          const parsed = service.getProgram()!.getSourceFile(file)!;
          const ownerNode = parsed.statements[1]!;
          let ownMembers: readonly ts.TypeElement[];
          if (ts.isInterfaceDeclaration(ownerNode)) ownMembers = ownerNode.members;
          else if (ts.isTypeAliasDeclaration(ownerNode) && ts.isTypeLiteralNode(ownerNode.type)) {
            ownMembers = ownerNode.type.members;
          } else throw new Error("Expected a method owner");
          expect(ownMembers.map((member) => ts.SyntaxKind[member.kind])).toEqual(["MethodSignature"]);
          const ownIndex = tokenIndex(source, 3, "m");
          const useIndex = tokenIndex(source, callLine, "m");
          expect(service.getDefinitionAtPosition(file, useIndex)?.map((def) => [def.kind, def.textSpan.start])).toEqual(
            [["method", ownIndex]],
          );
          const compilerRefs = service.findReferences(file, ownIndex);
          const ownCompilerRefs = compilerRefs?.find((refs) => refs.definition.textSpan.start === ownIndex);
          expect(ownCompilerRefs?.references.map((ref) => ref.textSpan.start)).toEqual([
            ownIndex,
            useIndex,
            tokenIndex(source, callLine + 1, "m"),
            tokenIndex(source, callLine + 2, "m"),
          ]);
          const observe = async (index: ProjectIndex) => {
            const mod = index.byFile.get(fileIdentityKey(file));
            const own = mod?.locals.find((def) => def.range.start.index === ownIndex);
            expect(own?.kind).toBe("function");
            expect(own?.callable?.arity).toEqual(arity);
            expect(own?.callable?.role).toBe("signature");
            for (const line of [3, callLine, callLine + 1, callLine + 2]) {
              const goto = await goToDefinition(index, { file, line, column: columnOf(source, line, "m") });
              expect(goto.status).toBe("ok");
              if (goto.status === "ok") {
                expect(goto.definition.range.start.index, `goto at line ${line}`).toBe(ownIndex);
                expect(goto.definition.kind).toBe("function");
                expect(goto.definition.callable?.arity).toEqual(arity);
              }
            }
            const refs = await findReferences(index, { file, line: 3, column: columnOf(source, 3, "m") });
            expect(refs.status).toBe("ok");
            expect(referenceSites(refs)).toEqual(
              [3, callLine, callLine + 1, callLine + 2].map((line) => `${fileName}:${line}`),
            );
            if (refs.status === "ok") expect(refs.referenceCoverage.state).toBe("complete");
            const inherited = await findReferences(index, { file, line: 1, column: columnOf(source, 1, "m") });
            expect(referenceSites(inherited)).toEqual([`${fileName}:1`]);
            const graph = await buildSymbolGraphDetailed(index);
            const ownId = `${file}::m::${ownIndex}`;
            expect(callTargetIds(graph, "run")).toEqual([ownId]);
            expect(graph.edges.some((edge) => edge.from === ownId && edge.label === "member_of")).toBe(true);
          };
          await observe(fixture.index);
          const cacheOptions = { cache: "disk" as const, cacheLocation: "project", threads: 1 };
          await observe(await buildProjectIndexIncremental(fixture.root, cacheOptions));
          closeDiskCacheDatabase(fixture.root, cacheOptions);
          const report: BuildReport = { timings: {} };
          await observe(await buildProjectIndexIncremental(fixture.root, { ...cacheOptions, report }));
          expect(report.files?.parsed).toBe(0);
          closeDiskCacheDatabase(fixture.root, cacheOptions);
        } finally {
          service.dispose();
          closeDiskCacheDatabase(fixture.root, { cacheLocation: "project" });
          await rm(fixture.root, { recursive: true, force: true });
        }
      });
    }

    it.each([
      { label: "explicit semicolon", declaration: ["  m;", "  <T>(): void"] },
      { label: "explicit comma", declaration: ["  m,", "  <T>(): void"] },
      { label: "separator after a comment", declaration: ["  m /* property */;", "  <T>(): void"] },
      { label: "typed property", declaration: ["  m: number", "  <T>(): void"] },
      { label: "ordinary property", declaration: ["  m"] },
      { label: "function-typed property", declaration: ["  m: <T>() => void"] },
    ])("keeps an $label unindexed, as on main", async ({ declaration, label }) => {
      const fileName = `separate.${extension}`;
      const source = [
        "interface B { m(): void }",
        "interface A extends B {",
        ...declaration,
        "}",
        "declare const a: A;",
        "function run() { a.m(); }",
        "",
      ].join("\n");
      const fixture = await project({ [fileName]: source });
      const file = fixture.file(fileName);
      try {
        expect(
          fixture.index.byFile
            .get(fileIdentityKey(file))
            ?.locals.filter((def) => def.localName === "m")
            .map((def) => def.range.start.line),
        ).toEqual([1]);
        const line = declaration.length + 5;
        const goto = await goToDefinition(fixture.index, { file, line, column: columnOf(source, line, "m") });
        expect(goto.status).toBe("ok");
        if (goto.status === "ok") expect(goto.definition.range.start.line).toBe(1);
        const graph = await buildSymbolGraphDetailed(fixture.index);
        expect(callTargetIds(graph, "run")).toEqual([`${file}::m::${tokenIndex(source, 1, "m")}`]);
        if (label === "explicit semicolon") {
          const service = ts.createLanguageService({
            getScriptFileNames: () => [file],
            getScriptVersion: () => "1",
            getScriptSnapshot: () => ts.ScriptSnapshot.fromString(source),
            getCurrentDirectory: () => fixture.root,
            getCompilationSettings: () => ({ noLib: true }),
            getDefaultLibFileName: () => "",
            fileExists: (name) => name === file,
            readFile: (name) => (name === file ? source : undefined),
          });
          try {
            expect(
              service.getDefinitionAtPosition(file, tokenIndex(source, line, "m"))?.map((def) => def.kind),
            ).toEqual(["property"]);
            const refs = service.findReferences(file, tokenIndex(source, 3, "m"));
            expect(refs?.some((group) => group.definition.kind === "property")).toBe(true);
          } finally {
            service.dispose();
          }
        }
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });

    it("preserves named and namespace imports through star barrels with same-named properties", async () => {
      const core = "export function config(x?: number) { return x }\n";
      const use = [
        "import * as core from './index'",
        "import { config } from './index'",
        "export function a() { return core.config(1) }",
        "export function b() { return config(2) }",
      ].join("\n");
      const fixture = await project({
        [`core.${extension}`]: core,
        [`types.${extension}`]:
          "export interface Settings { config: number }\nexport type Other = { config: string }\n",
        [`index.${extension}`]: "export * from './core'\nexport * from './types'\n",
        [`use.${extension}`]: use,
      });
      try {
        for (const line of [2, 3, 4]) {
          const result = await goToDefinition(fixture.index, {
            file: fixture.file(`use.${extension}`),
            line,
            column: columnOf(use, line, "config"),
          });
          expect(result.status).toBe("ok");
          if (result.status === "ok") {
            expect(result.definition.file).toBe(fixture.file(`core.${extension}`));
            expect(result.definition.range.start.line).toBe(1);
          }
        }
        const refs = await findReferences(fixture.index, {
          file: fixture.file(`core.${extension}`),
          line: 1,
          column: columnOf(core, 1, "config"),
        });
        expect(referenceSites(refs)).toEqual([
          `core.${extension}:1`,
          `use.${extension}:2`,
          `use.${extension}:3`,
          `use.${extension}:4`,
        ]);
        if (refs.status === "ok") expect(refs.referenceCoverage.state).toBe("complete");
        const graph = await buildSymbolGraphDetailed(fixture.index);
        const target = `${fixture.file(`core.${extension}`)}::config::${tokenIndex(core, 1, "config")}`;
        expect(callTargetIds(graph, "a")).toEqual([target]);
        expect(callTargetIds(graph, "b")).toEqual([target]);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });

    it("does not borrow a function-type parameter's property for a destructured receiver", async () => {
      const source = [
        "export interface RefinementCtx { path: string[] }",
        "export type Effect = { transform: (arg: number, ctx: RefinementCtx) => unknown }",
        "export function f(x: unknown) {",
        "  const { ctx } = x;",
        "  return ctx.path;",
        "}",
      ].join("\n");
      const fileName = `destructured.${extension}`;
      const fixture = await project({ [fileName]: source });
      try {
        const goto = await goToDefinition(fixture.index, {
          file: fixture.file(fileName),
          line: 5,
          column: columnOf(source, 5, "path"),
        });
        expect(goto.status).toBe("not_found");
        expect(
          listSymbols(fixture.index, { file: fixture.file(fileName) }).some((symbol) => symbol.name === "path"),
        ).toBe(false);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  });

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

  it.each(["ts", "js"] as const)(
    "rejects enclosing declaration fallback for unresolved %s callees",
    async (extension) => {
      const header =
        extension === "ts"
          ? "export function run(args: string[], store: unknown, value: string): void {"
          : "export function run(args, store, value) {";
      const source = [
        header,
        "  const handle = args[0]?.trim();",
        '  const lazy = import("./other");',
        "  /re/.test(value);",
        "  store?.close();",
        "  void handle; void lazy;",
        "}",
        "",
      ].join("\n");
      const file = `calls.${extension}`;
      const fixture = await project({ [file]: source, [`other.${extension}`]: "export const item = 1;\n" });
      try {
        for (const [line, token] of [
          [2, "trim"],
          [3, "import"],
          [4, "test"],
          [5, "close"],
        ] as const) {
          const request = { file: fixture.file(file), line, column: columnOf(source, line, token) };
          expect((await goToDefinition(fixture.index, request)).status).toBe("not_found");
          expect((await findReferences(fixture.index, request)).status).toBe("not_found");
        }
        const declaration = await goToDefinition(fixture.index, {
          file: fixture.file(file),
          line: 2,
          column: columnOf(source, 2, "handle"),
        });
        expect(declaration.status).toBe("ok");
        if (declaration.status === "ok") expect(declaration.definition.localName).toBe("handle");
        const graph = await buildSymbolGraphDetailed(fixture.index);
        expect(callTargetIds(graph, "run")).toEqual([]);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it("does not attribute invalid multiple-superclass receiver calls", async () => {
    const source = [
      "class Left { helper(): number { return 1; } }",
      "class Right { helper(): number { return 2; } }",
      "class Ambiguous extends Left, Right {",
      "  throughThis(): number { return this.helper(); }",
      "  throughSuper(): number { return super.helper(); }",
      "}",
      "",
    ].join("\n");
    const fixture = await project({ "ambiguous.ts": source });
    try {
      for (const line of [4, 5]) {
        const request = { file: fixture.file("ambiguous.ts"), line, column: columnOf(source, line, "helper()") };
        expect((await goToDefinition(fixture.index, request)).status).toBe("not_found");
        expect((await findReferences(fixture.index, request)).status).toBe("not_found");
      }
      for (const line of [1, 2]) {
        const refs = await findReferences(fixture.index, {
          file: fixture.file("ambiguous.ts"),
          line,
          column: columnOf(source, line, "helper()"),
        });
        expect(refs.status).toBe("ok");
        expect(referenceSites(refs)).not.toContain("ambiguous.ts:4");
        expect(referenceSites(refs)).not.toContain("ambiguous.ts:5");
      }
      const graph = await buildSymbolGraphDetailed(fixture.index);
      expect(callTargetIds(graph, "throughThis")).toEqual([]);
      expect(callTargetIds(graph, "throughSuper")).toEqual([]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("distinguishes callable receiver properties from same-named non-callable members", async () => {
    const source = [
      "export function helper(): number { return 3; }",
      "export class Box {",
      "  helper = () => 1;",
      "  caller(): number { return this.helper(); }",
      "}",
      "export class Counter {",
      "  helper = 2;",
      "  readNumber(): number { return this.helper(); }",
      "}",
      "",
    ].join("\n");
    const fixture = await project({ "properties.ts": source });
    try {
      for (const [callLine, declarationLine] of [
        [4, 3],
        [8, 7],
      ] as const) {
        const result = await goToDefinition(fixture.index, {
          file: fixture.file("properties.ts"),
          line: callLine,
          column: columnOf(source, callLine, "helper()"),
        });
        expect(result.status).toBe("ok");
        if (result.status === "ok") expect(result.definition.range.start.line).toBe(declarationLine);
        const refs = await findReferences(fixture.index, {
          file: fixture.file("properties.ts"),
          line: declarationLine,
          column: columnOf(source, declarationLine, "helper"),
        });
        expect(refs.status).toBe("ok");
        expect(referenceSites(refs)).toContain("properties.ts:" + callLine);
      }
      const graph = await buildSymbolGraphDetailed(fixture.index);
      expect(callTargetIds(graph, "caller")).toContain(
        fixture.file("properties.ts") + "::helper::" + tokenIndex(source, 3, "helper"),
      );
      expect(callTargetIds(graph, "caller")).not.toContain(
        fixture.file("properties.ts") + "::helper::" + tokenIndex(source, 1, "helper"),
      );
      expect(callTargetIds(graph, "readNumber")).toEqual([]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "free function",
      files: {
        "free.ts": [
          "export function choose(a: string): string;",
          "export function choose(a: string, b: number): string;",
          "export function choose(a: string, b?: number, c?: boolean): string { return a; }",
          'export function accepted(): string { return choose("a", 1); }',
          'export function rejected(): string { return choose("a", 1, true); }',
          "export function spread(values: [string, number, boolean]): string { return choose(...values); }",
        ].join("\n"),
      },
      declared: "free.ts",
      use: "free.ts",
      name: "choose",
      impl: 3,
      accepted: 4,
      rejected: 5,
      spread: 6,
      coverage: "complete",
    },
    {
      label: "method through this",
      files: {
        "method.ts": [
          "export class Handler {",
          "  handle(a: string): string;",
          "  handle(a: string, b: number): string;",
          "  handle(a: string, b?: number, c?: boolean): string { return a; }",
          '  accepted(): string { return this.handle("a", 1); }',
          '  rejected(): string { return this.handle("a", 1, true); }',
          "  spread(values: [string, number, boolean]): string { return this.handle(...values); }",
          "}",
        ].join("\n"),
      },
      declared: "method.ts",
      use: "method.ts",
      name: "handle",
      impl: 4,
      accepted: 5,
      rejected: 6,
      spread: 7,
      coverage: "partial",
    },
    {
      label: "named import",
      files: {
        "declared.ts": [
          "export function format(a: string): string;",
          "export function format(a: string, b: number): string;",
          "export function format(a: string, b?: number, c?: boolean): string { return a; }",
        ].join("\n"),
        "use.ts": [
          'import { format } from "./declared";',
          'export function accepted(): string { return format("a", 1); }',
          'export function rejected(): string { return format("a", 1, true); }',
          "export function spread(values: [string, number, boolean]): string { return format(...values); }",
        ].join("\n"),
      },
      declared: "declared.ts",
      use: "use.ts",
      name: "format",
      impl: 3,
      accepted: 2,
      rejected: 3,
      spread: 4,
      coverage: "complete",
    },
  ])("rejects implementation-only arity for $label", async (scenario) => {
    const { files, declared, use, name, impl, accepted, rejected, spread, coverage } = scenario;
    const fileSources: Record<string, string> = files;
    const fixture = await project(fileSources);
    try {
      const source = fileSources[declared]!;
      const useSource = fileSources[use]!;
      for (const [line, status] of [
        [accepted, "ok"],
        [rejected, "not_found"],
        [spread, "ok"],
      ] as const) {
        const result = await goToDefinition(fixture.index, {
          file: fixture.file(use),
          line,
          column: columnOf(useSource, line, name + "("),
        });
        expect(result.status).toBe(status);
        if (result.status === "ok") {
          expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(fixture.file(declared)));
          expect(result.definition.range.start.line).toBe(impl);
        }
      }
      const refs = await findReferences(fixture.index, {
        file: fixture.file(declared),
        line: impl,
        column: columnOf(source, impl, name),
      });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") return;
      expect(refs.referenceCoverage?.state).toBe(coverage);
      expect(referenceSites(refs)).toContain(use + ":" + accepted);
      expect(referenceSites(refs)).toContain(use + ":" + spread);
      expect(referenceSites(refs)).not.toContain(use + ":" + rejected);
      const graph = await buildSymbolGraphDetailed(fixture.index);
      const target = fixture.file(declared) + "::" + name + "::" + tokenIndex(source, impl, name);
      expect(callTargetIds(graph, "accepted")).toContain(target);
      expect(callTargetIds(graph, "spread")).toContain(target);
      expect(callTargetIds(graph, "rejected")).toEqual([]);
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

  it("keeps a function local to a method body out of the class member's overload group", async () => {
    const source = [
      "export abstract class Worker {",
      "  abstract helper(): number;",
      "  run(): number {",
      "    function helper(): number { return 1; }",
      "    return this.helper() + helper();",
      "  }",
      "}",
      "",
    ].join("\n");
    const fixture = await project({ "worker.ts": source });
    try {
      const file = fixture.file("worker.ts");
      const member = await goToDefinition(fixture.index, { file, line: 5, column: columnOf(source, 5, "helper()") });
      expect(member.status === "ok" && member.definition.range.start.line).toBe(2);
      const local = await goToDefinition(fixture.index, { file, line: 5, column: columnOf(source, 5, "+ helper") + 2 });
      expect(local.status === "ok" && local.definition.range.start.line).toBe(4);

      const graph = await buildSymbolGraphDetailed(fixture.index);
      expect(callTargetIds(graph, "run").sort()).toEqual(
        [
          `${file}::helper::${tokenIndex(source, 2, "helper")}`,
          `${file}::helper::${tokenIndex(source, 4, "helper")}`,
        ].sort(),
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

      const graph = await buildSymbolGraphDetailed(fixture.index);
      const declarationIndex = tokenIndex(namespaces, 6, "select");
      const decoyIndex = tokenIndex(namespaces, 2, "select");
      expect(callTargetIds(graph, "run")).toContain(fixture.file("namespaces.ts") + "::select::" + declarationIndex);
      expect(callTargetIds(graph, "run").some((id) => id.endsWith(`::select::${decoyIndex}`))).toBe(false);
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
      const namespaceTarget = tokenIndex(declarations, 3, "parse");
      expect(callTargetIds(graph, "namespaceRun")).toContain(
        fixture.file("receiver-overloads.ts") + "::parse::" + namespaceTarget,
      );
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

  it("records direct CommonJS function values without marking ESM exports", async () => {
    const cjsSource = "module.exports = function thing() {};\n";
    const esmSource = "export function exports() {}\n";
    const fixture = await project({ "cjs.js": cjsSource, "esm.js": esmSource });
    try {
      const cjsFile = fixture.file("cjs.js");
      const esmFile = fixture.file("esm.js");
      const cjs = fixture.index.byFile.get(fileIdentityKey(cjsFile));
      const esm = fixture.index.byFile.get(fileIdentityKey(esmFile));
      expect(
        cjs?.exports.some(
          (entry) => entry.type === "local" && entry.exportedAs === "exports" && entry.mechanism === "cjs-module-value",
        ),
      ).toBe(true);
      expect(esm?.exports.some((entry) => entry.type === "local" && entry.mechanism === "cjs-module-value")).toBe(
        false,
      );
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

  it.each(["js", "ts", "tsx"] as const)("binds direct CJS identifier exports in %s", async (extension) => {
    const widgetName = `widget.${extension}`;
    const fixture = await project({ [widgetName]: directCjsWidget });
    try {
      const file = fixture.file(widgetName);
      const direct = fixture.index.byFile
        .get(fileIdentityKey(file))
        ?.exports.find((entry) => entry.type === "local" && entry.exportedAs === "default");
      expect(direct?.type).toBe("local");
      if (direct?.type !== "local") return;
      expect(direct.mechanism).toBe("cjs-module-value");
      expect(direct.target.range.start.index).toBe(tokenIndex(directCjsWidget, 5, "Widget"));
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
      expect(
        fixture.index.byFile
          .get(fileIdentityKey(file))
          ?.exports.some((entry) => entry.type === "local" && entry.mechanism === "cjs-module-value"),
      ).toBe(false);
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
  it.each(["ts", "tsx", "js"] as const)("resolves lexical private class names in %s", async (extension) => {
    const lines = [
      "export class Example {",
      "  #field = 1;",
      "  get #value() { return this.#field; }",
      "  set #value(v) { this.#field = v; }",
      "  static #make(x) { return x; }",
      "  #push(x) { return x; }",
      "  run(obj) {",
      "    return this.#push(1) + this.#push(2) + obj.#push(3);",
      "  }",
      "  has(obj) { return #field in obj; }",
      "  read() { return this.#value; }",
      "  write(v) { this.#value = v; }",
      "  static make(v) { return Example.#make(v); }",
      "  nested() {",
      "    return class Inner {",
      "      callOuter(obj) { return obj.#\\u0070ush(4); }",
      "      hasOuter(obj) { return #field in obj; }",
      "    };",
      "  }",
      "  shadow() {",
      "    return class Shadow {",
      "      callBefore(obj) { return obj.#push(8); }",
      "      #push(x) { return -x; }",
      "      callInner(obj) { return obj.#push(5); }",
      "    };",
      "  }",
      "  static #slot = 0;",
      "  static get #reading() { return Example.#slot; }",
      "  static set #reading(v) { Example.#slot = v; }",
      "  static useReading(v) { Example.#reading = v; return Example.#reading; }",
      "  get plain() { return 1; }",
      "  set plain(v) { void v; }",
      "  readPlain() { return this.plain; }",
      "  writePlain(v) { this.plain = v; }",
      "  static get plainStatic() { return 1; }",
      "  static set plainStatic(v) { void v; }",
      "  static readPlainStatic() { return Example.plainStatic; }",
      "  static writePlainStatic(v) { Example.plainStatic = v; }",
      ...(extension === "tsx" ? ["  render() { return <span>{this.#push(7)}</span>; }"] : []),
      "}",
      "class Decoy {",
      "  #field = 0;",
      "  #push(x) { return -x; }",
      "  decoyRun() { return this.#push(6); }",
      "  get #value() { return 0; }",
      "  set #value(v) { void v; }",
      "  readDecoy() { return this.#value; }",
      "  static get #reading() { return 0; }",
      "  static set #reading(v) { void v; }",
      "  static useDecoy() { return Decoy.#reading; }",
      "}",
      "",
    ];
    const source = lines.join("\n");
    const name = `private.${extension}`;
    const fixture = await project({ [name]: source });
    try {
      const file = fixture.file(name);
      const lineOf = (text: string): number => {
        const index = lines.findIndex((line) => line.includes(text));
        if (index < 0) throw new Error(`missing ${text}`);
        return index + 1;
      };
      const indexOf = (line: number, token: string, occurrence = 0): number => {
        let column = -1;
        for (let count = 0; count <= occurrence; count += 1) column = lines[line - 1]!.indexOf(token, column + 1);
        if (column < 0) throw new Error(`missing ${token} on line ${line}`);
        const lineStart = line === 1 ? 0 : lines.slice(0, line - 1).join("\n").length + 1;
        return lineStart + column;
      };
      const checkRefs = async (declarationLine: number, token: string, expected: number[]): Promise<void> => {
        const result = await findReferences(fixture.index, {
          file,
          line: declarationLine,
          column: columnOf(source, declarationLine, token),
        });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.referenceCoverage?.state).toBe("complete");
        expect(result.references.map((reference) => reference.range.start.index).sort((a, b) => a! - b!)).toEqual(
          [...expected].sort((a, b) => a - b),
        );
      };
      const checkGoto = async (line: number, token: string, expectedIndex: number, occurrence = 0): Promise<void> => {
        const offset = indexOf(line, token, occurrence);
        const column = offset - (source.lastIndexOf("\n", offset - 1) + 1) + 1;
        const result = await goToDefinition(fixture.index, { file, line, column });
        expect(result.status).toBe("ok");
        if (result.status === "ok") expect(result.definition.range.start.index).toBe(expectedIndex);
      };

      const pushLine = lineOf("  #push(x)");
      const runLine = lineOf("return this.#push(1)");
      const outerLine = lineOf("callOuter");
      const innerDeclaration = lineOf("      #push(x)");
      const innerUse = lineOf("callInner");
      const innerBefore = lineOf("callBefore");
      const decoyDeclaration = lineOf("class Decoy") + 2;
      const pushIndex = indexOf(pushLine, "#push");
      const pushSites = [
        pushIndex,
        indexOf(runLine, "#push", 0),
        indexOf(runLine, "#push", 1),
        indexOf(runLine, "#push", 2),
        indexOf(outerLine, "#\\u0070ush"),
      ];
      if (extension === "tsx") pushSites.push(indexOf(lineOf("render()"), "#push"));
      await checkRefs(pushLine, "#push", pushSites);
      await checkRefs(outerLine, "#\\u0070ush", pushSites);
      for (let occurrence = 0; occurrence < 3; occurrence += 1)
        await checkGoto(runLine, "#push", pushIndex, occurrence);
      await checkGoto(outerLine, "#\\u0070ush", pushIndex);
      if (extension === "tsx") await checkGoto(lineOf("render()"), "#push", pushIndex);
      await checkGoto(innerUse, "#push", indexOf(innerDeclaration, "#push"));
      await checkGoto(innerBefore, "#push", indexOf(innerDeclaration, "#push"));
      await checkRefs(innerDeclaration, "#push", [
        indexOf(innerBefore, "#push"),
        indexOf(innerDeclaration, "#push"),
        indexOf(innerUse, "#push"),
      ]);
      await checkRefs(decoyDeclaration, "#push", [
        indexOf(decoyDeclaration, "#push"),
        indexOf(lineOf("decoyRun"), "#push"),
      ]);

      const field = indexOf(2, "#field");
      const fieldSites = [
        field,
        indexOf(3, "#field"),
        indexOf(4, "#field"),
        indexOf(10, "#field"),
        indexOf(17, "#field"),
      ];
      await checkRefs(2, "#field", fieldSites);
      for (const line of [3, 4, 10, 17]) await checkGoto(line, "#field", field);
      await checkRefs(lineOf("  #field = 0"), "#field", [indexOf(lineOf("  #field = 0"), "#field")]);

      const accessorSites = [indexOf(3, "#value"), indexOf(4, "#value"), indexOf(11, "#value"), indexOf(12, "#value")];
      await checkRefs(3, "#value", accessorSites);
      await checkRefs(4, "#value", accessorSites);
      for (const [privateLine, publicLine] of [
        [11, lineOf("readPlain()")],
        [12, lineOf("writePlain(")],
      ]) {
        const privateResult = await goToDefinition(fixture.index, {
          file,
          line: privateLine,
          column: columnOf(source, privateLine, "#value"),
        });
        const publicResult = await goToDefinition(fixture.index, {
          file,
          line: publicLine,
          column: columnOf(source, publicLine, ".plain") + 1,
        });
        expect(publicResult.status).toBe("not_found");
        expect(privateResult).toEqual(publicResult);
      }
      await checkRefs(5, "#make", [indexOf(5, "#make"), indexOf(13, "#make")]);
      await checkGoto(13, "#make", indexOf(5, "#make"));
      const slotLine = lineOf("static #slot");
      const getReading = lineOf("static get #reading");
      const setReading = lineOf("static set #reading");
      const useReading = lineOf("static useReading");
      await checkRefs(slotLine, "#slot", [
        indexOf(slotLine, "#slot"),
        indexOf(getReading, "#slot"),
        indexOf(setReading, "#slot"),
      ]);
      await checkGoto(getReading, "#slot", indexOf(slotLine, "#slot"));
      await checkGoto(setReading, "#slot", indexOf(slotLine, "#slot"));
      const readingSites = [
        indexOf(getReading, "#reading"),
        indexOf(setReading, "#reading"),
        indexOf(useReading, "#reading", 0),
        indexOf(useReading, "#reading", 1),
      ];
      await checkRefs(getReading, "#reading", readingSites);
      await checkRefs(setReading, "#reading", readingSites);
      for (const [occurrence, publicLine] of [
        [0, lineOf("writePlainStatic(")],
        [1, lineOf("readPlainStatic()")],
      ]) {
        const privateOffset = indexOf(useReading, "#reading", occurrence);
        const privateColumn = privateOffset - (source.lastIndexOf("\n", privateOffset - 1) + 1) + 1;
        const privateResult = await goToDefinition(fixture.index, { file, line: useReading, column: privateColumn });
        const publicResult = await goToDefinition(fixture.index, {
          file,
          line: publicLine,
          column: columnOf(source, publicLine, ".plainStatic") + 1,
        });
        expect(publicResult.status).toBe("not_found");
        expect(privateResult).toEqual(publicResult);
      }

      const graph = await buildSymbolGraphDetailed(fixture.index);
      const outerId = `${file}::#push::${pushIndex}`;
      const innerId = `${file}::#push::${indexOf(innerDeclaration, "#push")}`;
      expect(callTargetIds(graph, "run")).toEqual([outerId, outerId, outerId]);
      expect(callTargetIds(graph, "callOuter")).toEqual([outerId]);
      expect(callTargetIds(graph, "callInner")).toEqual([innerId]);
      expect(callTargetIds(graph, "callBefore")).toEqual([innerId]);
      expect(callTargetIds(graph, "make")).toEqual([`${file}::#make::${indexOf(5, "#make")}`]);
      if (extension === "tsx") expect(callTargetIds(graph, "render")).toEqual([outerId]);
      expect(callTargetIds(graph, "decoyRun")).not.toContain(outerId);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["ts", "tsx"] as const)("resolves private overloads to their implementation in %s", async (extension) => {
    const source = [
      "export class Overloaded {",
      "  #m(x: string): number;",
      "  #m(x: number): number;",
      "  #m(x: string | number): number { return typeof x === 'string' ? x.length : x; }",
      "  run() { return this.#m('a') + this.#m(1); }",
      "  static #s(x: string): string;",
      "  static #s(x: number): string;",
      "  static #s(x: string | number): string { return String(x); }",
      "  static runStatic() { return Overloaded.#s(1); }",
      "}",
      "class Decoy {",
      "  #m(x: number) { return x; }",
      "  decoy() { return this.#m(2); }",
      "}",
      "",
    ].join("\n");
    const name = `overloads.${extension}`;
    const fixture = await project({ [name]: source });
    try {
      const file = fixture.file(name);
      for (const [line, column, expected] of [
        [5, columnOf(source, 5, "#m"), 4],
        [5, source.split("\n")[4]!.lastIndexOf("#m") + 1, 4],
        [9, columnOf(source, 9, "#s"), 8],
      ]) {
        const result = await goToDefinition(fixture.index, { file, line, column });
        expect(result.status).toBe("ok");
        if (result.status === "ok") expect(result.definition.range.start.line).toBe(expected);
      }
      for (const line of [2, 3, 4]) {
        const refs = await findReferences(fixture.index, { file, line, column: columnOf(source, line, "#m") });
        expect(refs.status).toBe("ok");
        if (refs.status === "ok") {
          expect(refs.referenceCoverage?.state).toBe("complete");
          expect(refs.references.map((reference) => reference.range.start.line)).toEqual([2, 3, 4, 5, 5]);
        }
      }
      const staticRefs = await findReferences(fixture.index, { file, line: 8, column: columnOf(source, 8, "#s") });
      expect(staticRefs.status).toBe("ok");
      if (staticRefs.status === "ok") {
        expect(staticRefs.referenceCoverage?.state).toBe("complete");
        expect(staticRefs.references.map((reference) => reference.range.start.line)).toEqual([6, 7, 8, 9]);
      }
      const graph = await buildSymbolGraphDetailed(fixture.index);
      expect(callTargetIds(graph, "run")).toEqual([
        `${file}::#m::${tokenIndex(source, 4, "#m")}`,
        `${file}::#m::${tokenIndex(source, 4, "#m")}`,
      ]);
      expect(callTargetIds(graph, "runStatic")).toEqual([`${file}::#s::${tokenIndex(source, 8, "#s")}`]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["ts", "tsx", "js"] as const)("records calls to private arrow fields in %s", async (extension) => {
    const source = [
      "export class Holder {",
      "  run() { return this.#fn(); }",
      "  static runStatic() { return Holder.#sfn(); }",
      "  #fn = () => 1;",
      "  static #sfn = () => 2;",
      "}",
      "class Decoy {",
      "  #fn = () => 3;",
      "  static #sfn = () => 4;",
      "}",
      "",
    ].join("\n");
    const name = `arrows.${extension}`;
    const fixture = await project({ [name]: source });
    try {
      const file = fixture.file(name);
      for (const [useLine, token, definitionLine] of [
        [2, "#fn", 4],
        [3, "#sfn", 5],
      ] as const) {
        const result = await goToDefinition(fixture.index, {
          file,
          line: useLine,
          column: columnOf(source, useLine, token),
        });
        expect(result.status).toBe("ok");
        if (result.status === "ok") expect(result.definition.range.start.line).toBe(definitionLine);
        const refs = await findReferences(fixture.index, {
          file,
          line: definitionLine,
          column: columnOf(source, definitionLine, token),
        });
        expect(refs.status).toBe("ok");
        if (refs.status === "ok") {
          expect(refs.referenceCoverage?.state).toBe("complete");
          expect(refs.references.map((reference) => reference.range.start.line)).toEqual([useLine, definitionLine]);
        }
      }
      const graph = await buildSymbolGraphDetailed(fixture.index);
      expect(callTargetIds(graph, "run")).toEqual([`${file}::#fn::${tokenIndex(source, 4, "#fn")}`]);
      expect(callTargetIds(graph, "runStatic")).toEqual([`${file}::#sfn::${tokenIndex(source, 5, "#sfn")}`]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps private ranges correct after non-ASCII characters on the same line", async () => {
    const source = [
      "export class Unicode {",
      "  #m() { return 1; }",
      '  run() { const text = "\u65e5\u{1f600}"; return this.#m(); }',
      "  #\u00e9 = 2;",
      "  read() { return this.#\u00e9; }",
      "}",
      "class Decoy { #m() {} }",
      "",
    ].join("\n");
    const fixture = await project({ "unicode.ts": source });
    try {
      const file = fixture.file("unicode.ts");
      const use = { file, line: 3, column: columnOf(source, 3, "#m") };
      const result = await goToDefinition(fixture.index, use);
      expect(result.status).toBe("ok");
      if (result.status === "ok") expect(result.definition.range.start.line).toBe(2);
      const refs = await findReferences(fixture.index, { file, line: 2, column: columnOf(source, 2, "#m") });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        expect(refs.references.map((reference) => reference.range.start.index)).toEqual([
          tokenIndex(source, 2, "#m"),
          tokenIndex(source, 3, "#m"),
        ]);
        expect(refs.referenceCoverage?.state).toBe("complete");
      }
      const unicode = await goToDefinition(fixture.index, { file, line: 5, column: columnOf(source, 5, "#\u00e9") });
      expect(unicode.status).toBe("ok");
      if (unicode.status === "ok") expect(unicode.definition.range.start.line).toBe(4);
      const graph = await buildSymbolGraphDetailed(fixture.index);
      const call = graph.edges.find((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === "run");
      expect(call?.site?.range.start.column).toBe(use.column);
      expect(call?.site?.range.start.index).toBe(tokenIndex(source, 3, "#m"));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps same-named private placeholders in sibling declaration classes separate", async () => {
    const source = ["export declare class First { #private; }", "export declare class Second { #private; }", ""].join(
      "\n",
    );
    const fixture = await project({ "types.d.ts": source });
    try {
      const file = fixture.file("types.d.ts");
      const symbols = listSymbols(fixture.index, { file }).filter((symbol) => symbol.name === "#private");
      expect(symbols.map((symbol) => symbol.range?.start.line)).toEqual([1, 2]);
      for (const line of [1, 2]) {
        const refs = await findReferences(fixture.index, { file, line, column: columnOf(source, line, "#private") });
        expect(refs.status).toBe("ok");
        if (refs.status === "ok") {
          expect(refs.referenceCoverage?.state).toBe("complete");
          expect(refs.references.map((reference) => reference.range.start.line)).toEqual([line]);
        }
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("reports partial private-name references when duplicate declarations prevent resolution", async () => {
    const source = [
      "class Broken {",
      "  #method() {}",
      "  #method() {}",
      "  run() { this.#method(); }",
      "}",
      "class Mixed {",
      "  #mixed(x: string): void;",
      "  static #mixed(x: string): void {}",
      "  runMixed() { this.#mixed('x'); }",
      "}",
      "",
    ].join("\n");
    const fixture = await project({ "broken.ts": source });
    try {
      const file = fixture.file("broken.ts");
      for (const [declarationLine, useLine, token] of [
        [2, 4, "#method"],
        [7, 9, "#mixed"],
      ] as const) {
        const use = await goToDefinition(fixture.index, {
          file,
          line: useLine,
          column: columnOf(source, useLine, token),
        });
        expect(use.status).toBe("not_found");
        const refs = await findReferences(fixture.index, {
          file,
          line: declarationLine,
          column: columnOf(source, declarationLine, token),
        });
        expect(refs.status).toBe("ok");
        if (refs.status === "ok") {
          expect(refs.referenceCoverage?.state).toBe("partial");
          expect(refs.referenceCoverage?.reasons).toContain("strategy_unavailable");
          expect(referenceSites(refs)).not.toContain(`broken.ts:${useLine}`);
        }
      }
      const graph = await buildSymbolGraphDetailed(fixture.index);
      expect(callTargetIds(graph, "run")).toEqual([]);
      expect(callTargetIds(graph, "runMixed")).toEqual([]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("retains private name navigation and call edges after a disk-cache reload", async () => {
    const source = [
      "export class Owner {",
      "  #field = 1;",
      "  #run() { return this.#field; }",
      "  call() { return this.#run(); }",
      "}",
      "class Decoy { #field = 2; #run() { return this.#field; } }",
      "",
    ].join("\n");
    const fixture = await project({ "cached.ts": source });
    const options = { cache: "disk" as const, cacheLocation: "project", threads: 1 };
    try {
      const file = fixture.file("cached.ts");
      const observe = async (index: ProjectIndex) => {
        const result = await goToDefinition(index, { file, line: 4, column: columnOf(source, 4, "#run") });
        const refs = await findReferences(index, { file, line: 3, column: columnOf(source, 3, "#run") });
        const fields = await findReferences(index, { file, line: 2, column: columnOf(source, 2, "#field") });
        const graph = await buildSymbolGraphDetailed(index);
        return {
          definition: result.status === "ok" ? result.definition.range.start.index : result.status,
          references: referenceSites(refs),
          coverage: refs.status === "ok" ? refs.referenceCoverage?.state : refs.status,
          fields: referenceSites(fields),
          calls: callTargetIds(graph, "call"),
        };
      };
      const cold = await buildProjectIndexIncremental(fixture.root, options);
      const expected = await observe(cold);
      expect(expected).toEqual({
        definition: tokenIndex(source, 3, "#run"),
        references: ["cached.ts:3", "cached.ts:4"],
        coverage: "complete",
        fields: ["cached.ts:2", "cached.ts:3"],
        calls: [`${file}::#run::${tokenIndex(source, 3, "#run")}`],
      });
      closeDiskCacheDatabase(fixture.root, options);
      const report: BuildReport = { timings: {} };
      const warm = await buildProjectIndexIncremental(fixture.root, { ...options, report });
      expect(report.files?.parsed).toBe(0);
      expect(await observe(warm)).toEqual(expected);
    } finally {
      closeDiskCacheDatabase(fixture.root, options);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
