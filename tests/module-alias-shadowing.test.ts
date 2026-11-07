import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed } from "../src/graphs/symbol-graph-detailed.js";
import { buildProjectIndex, findReferences, goToDefinition } from "../src/index.js";
import { mkTmpDir } from "./helpers/filesystem.js";
import {
  CSHARP_ALIAS_BOUNDARIES,
  CSHARP_ALIAS_TYPE_FORMS,
  csharpAliasBoundaryFixture,
  csharpAliasTypeFixture,
  CSHARP_ALIAS_SHADOW_FILES,
  CSHARP_ALIAS_SHADOW_LINES,
  CSHARP_ALIAS_SHADOW_SITES,
} from "./helpers/csharp-alias-shadow-fixture.js";
import {
  CSHARP_ALIAS_ONLY_FILES,
  CSHARP_ALIAS_ONLY_LINES,
  CSHARP_ALIAS_VALUE_SPELLINGS,
  csharpAliasValueFixture,
} from "./helpers/csharp-alias-only-shadow-fixture.js";
import { columnOf, writeFixtureFiles } from "./languages/callable-consumer-fixtures.js";
import {
  CSHARP_INHERITED_ALIAS_CASES,
  CSHARP_INHERITED_NESTED_TYPE_CASE,
  CSHARP_INHERITED_TYPE_POSITION_CASE,
} from "./helpers/csharp-inherited-alias-fixture.js";
import { expectInheritedAliasConsumers, inheritedAliasRunColumn } from "./helpers/csharp-inherited-alias-assertions.js";
import {
  CSHARP_ALIAS_CALL_SPELLINGS,
  CSHARP_GENERIC_ALIAS_CASES,
  csharpGenericAliasReceiverFixture,
  csharpUnknownAliasReceiverFixture,
} from "./helpers/csharp-alias-call-fixture.js";
import {
  CSHARP_SCOPE_READ_FILES,
  CSHARP_SCOPE_READ_LINES,
  KOTLIN_TYPE_VALUE_FILES,
  KOTLIN_TYPE_VALUE_LINES,
  KOTLIN_TYPE_VALUE_TYPE_LINES,
} from "./helpers/scope-binding-read-fixtures.js";

const fixtures = [
  {
    language: "TypeScript",
    files: {
      "api.ts": "export function run() { return 1; }\n",
      "main.ts": [
        'import * as api from "./api";',
        "export function plain() { return api.run(); }",
        "export function shadowed(api: { run: () => number }) { return api.run(); }",
        "export function nested() { const api = { run: () => 3 }; return api.run(); }",
        "",
      ].join("\n"),
    },
    main: "main.ts",
    target: "api.ts",
    plainLine: 2,
    shadowedLine: 3,
    nestedLine: 4,
  },
  {
    language: "Python",
    files: {
      "api.py": "def run():\n    return 1\n",
      "main.py": [
        "import api",
        "def plain():",
        "    return api.run()",
        "def shadowed(api):",
        "    return api.run()",
        "",
      ].join("\n"),
    },
    main: "main.py",
    target: "api.py",
    plainLine: 3,
    shadowedLine: 5,
  },
  {
    language: "Rust",
    files: {
      "Cargo.toml": '[package]\nname = "probe"\nversion = "0.1.0"\n',
      "src/lib.rs": "pub mod api;\npub mod consumer;\n",
      "src/api.rs": "pub fn run() -> i32 { 1 }\n",
      "src/consumer.rs": [
        "use crate::api as imported;",
        "struct Receiver;",
        "impl Receiver { fn run(&self) -> i32 { 2 } }",
        "fn plain() -> i32 { imported::run() }",
        "fn shadowed(imported: Receiver) -> i32 { imported.run() }",
        "",
      ].join("\n"),
    },
    main: "src/consumer.rs",
    target: "src/api.rs",
    plainLine: 4,
    shadowedLine: 5,
  },
] as const;

describe("module import alias shadowing", () => {
  for (const fixture of fixtures) {
    it(`${fixture.language} keeps the imported call but excludes a parameter receiver`, async () => {
      const root = await mkTmpDir("cg-module-shadow-");
      try {
        for (const [filename, source] of Object.entries(fixture.files)) {
          await fs.mkdir(path.dirname(path.join(root, filename)), { recursive: true });
          await fs.writeFile(path.join(root, filename), source);
        }
        const main = path.join(root, fixture.main);
        const target = path.join(root, fixture.target).replace(/\\/g, "/");
        const source = await fs.readFile(main, "utf8");
        const index = await buildProjectIndex(root, { cache: "off", logLevel: "silent" });
        const graph = await buildSymbolGraphDetailed(index);
        const moduleMember = [...graph.nodes.values()].find((node) => node.name === "run" && node.file === target);
        const plain = [...graph.nodes.values()].find(
          (node) => node.name === "plain" && node.file === main.replace(/\\/g, "/"),
        );
        const shadowed = [...graph.nodes.values()].find(
          (node) => node.name === "shadowed" && node.file === main.replace(/\\/g, "/"),
        );
        expect(moduleMember).toBeDefined();
        expect(plain).toBeDefined();
        expect(shadowed).toBeDefined();
        if (!moduleMember || !plain || !shadowed) return;
        const targetsOf = (caller: string) =>
          graph.edges.filter((edge) => edge.from === caller && edge.to === moduleMember.id && edge.label === "calls");
        expect(targetsOf(plain.id)).toHaveLength(1);
        expect(targetsOf(shadowed.id)).toHaveLength(0);
        if ("nestedLine" in fixture) {
          const nested = [...graph.nodes.values()].find(
            (node) => node.name === "nested" && node.file === main.split(path.sep).join("/"),
          );
          expect(nested).toBeDefined();
          if (nested) expect(targetsOf(nested.id)).toHaveLength(0);
        }
        const gotoCall = async (line: number) => {
          const text = source.split("\n")[line - 1]!;
          const at = text.lastIndexOf("run");
          return await goToDefinition(index, { file: main, line, column: at + 1 });
        };
        const plainResult = await gotoCall(fixture.plainLine);
        const shadowedResult = await gotoCall(fixture.shadowedLine);
        expect(plainResult.status).toBe("ok");
        if (plainResult.status === "ok") expect(plainResult.definition.file).toBe(target);
        if (shadowedResult.status === "ok") expect(shadowedResult.definition.file).not.toBe(target);
        if ("nestedLine" in fixture) {
          const nestedResult = await gotoCall(fixture.nestedLine);
          if (nestedResult.status === "ok") expect(nestedResult.definition.file).not.toBe(target);
        }
        const references = await findReferences(index, {
          file: target,
          line: 1,
          column: (await fs.readFile(target, "utf8")).indexOf("run") + 1,
        });
        expect(references.status).toBe("ok");
        if (references.status === "ok") {
          const useLines = references.references
            .filter((reference) => reference.file === main.split(path.sep).join("/"))
            .map((reference) => reference.range.start.line);
          expect(useLines).toContain(fixture.plainLine);
          expect(useLines).not.toContain(fixture.shadowedLine);
          if ("nestedLine" in fixture) expect(useLines).not.toContain(fixture.nestedLine);
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
  it("Python module reassignment hides the import without hiding a separate plain import", async () => {
    const root = await mkTmpDir("cg-python-rebound-import-");
    try {
      const sources = {
        "api.py": "def run():\n    return 1\n",
        "plain.py": "import api\ndef plain():\n    return api.run()\n",
        "rebound.py": [
          "import api",
          "class Receiver:",
          "    def run(self): return 2",
          "api = Receiver()",
          "def rebound():",
          "    return api.run()",
          "",
        ].join("\n"),
      };
      for (const [name, source] of Object.entries(sources)) await fs.writeFile(path.join(root, name), source);
      const target = path.join(root, "api.py").split(path.sep).join("/");
      const plainFile = path.join(root, "plain.py").split(path.sep).join("/");
      const reboundFile = path.join(root, "rebound.py").split(path.sep).join("/");
      const index = await buildProjectIndex(root, { cache: "off", logLevel: "silent" });
      const graph = await buildSymbolGraphDetailed(index);
      const nodes = [...graph.nodes.values()];
      const member = nodes.find((node) => node.file === target && node.name === "run");
      const plain = nodes.find((node) => node.file === plainFile && node.name === "plain");
      const rebound = nodes.find((node) => node.file === reboundFile && node.name === "rebound");
      expect(member).toBeDefined();
      expect(plain).toBeDefined();
      expect(rebound).toBeDefined();
      expect(
        graph.edges.some((edge) => edge.from === plain?.id && edge.to === member?.id && edge.label === "calls"),
      ).toBe(true);
      expect(
        graph.edges.some(
          (edge) =>
            edge.from === rebound?.id && edge.to === member?.id && (edge.label === "calls" || edge.label === "uses"),
        ),
      ).toBe(false);

      const plainLine = sources["plain.py"].split("\n")[2]!;
      const reboundLine = sources["rebound.py"].split("\n")[5]!;
      const plainGoto = await goToDefinition(index, {
        file: plainFile,
        line: 3,
        column: plainLine.lastIndexOf("run") + 1,
      });
      const reboundGoto = await goToDefinition(index, {
        file: reboundFile,
        line: 6,
        column: reboundLine.lastIndexOf("run") + 1,
      });
      expect(plainGoto.status).toBe("ok");
      if (plainGoto.status === "ok") expect(plainGoto.definition.file).toBe(target);
      if (reboundGoto.status === "ok") expect(reboundGoto.definition.file).not.toBe(target);
      const references = await findReferences(index, {
        file: target,
        line: 1,
        column: sources["api.py"].indexOf("run") + 1,
      });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        const plainSites = references.references
          .filter((site) => site.file === plainFile)
          .map((site) => site.range.start.line);
        const reboundSites = references.references
          .filter((site) => site.file === reboundFile)
          .map((site) => site.range.start.line);
        expect(plainSites).toContain(3);
        expect(reboundSites).not.toContain(6);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("TypeScript keeps same-module locals visible without treating parameters or other modules as aliases", async () => {
    const root = await mkTmpDir("cg-dynamic-module-shadow-");
    try {
      const libSource = [
        'export function make(): string { return "v"; }',
        "export function check(v: string): boolean { return !!v; }",
        "",
      ].join("\n");
      const useSource = [
        "export async function lazy(flag: boolean): Promise<boolean> {",
        '  let lib: typeof import("./lib.js") | undefined;',
        "  if (flag) {",
        '    lib = await import("./lib.js");',
        "    lib.make();",
        "  }",
        '  return !!lib && lib.check("v");',
        "}",
        "export async function eager(): Promise<string> {",
        '  const lib = await import("./lib.js");',
        "  return lib.make();",
        "}",
        "export function shadow(lib: { make(): string }): string {",
        "  return lib.make();",
        "}",
        "export async function wrong(flag: boolean): Promise<string | undefined> {",
        '  let lib: typeof import("./other.js") | undefined;',
        '  if (flag) lib = await import("./other.js");',
        "  return lib?.make();",
        "}",
        "export async function reassigned(): Promise<string> {",
        "  let lib;",
        '  lib = await import("./lib.js");',
        '  lib = { make: () => "other" };',
        "  return lib.make();",
        "}",
        "",
      ].join("\n");
      await Promise.all([
        fs.writeFile(path.join(root, "lib.ts"), libSource),
        fs.writeFile(path.join(root, "other.ts"), 'export function make(): string { return "other"; }\n'),
        fs.writeFile(path.join(root, "use.ts"), useSource),
      ]);
      const lib = path.join(root, "lib.ts").split(path.sep).join("/");
      const use = path.join(root, "use.ts").split(path.sep).join("/");
      const index = await buildProjectIndex(root, { cache: "off", logLevel: "silent" });
      const graph = await buildSymbolGraphDetailed(index);
      const nodes = [...graph.nodes.values()];
      const members = nodes.filter((node) => node.file === lib && ["make", "check"].includes(node.name));
      const callers = nodes.filter(
        (node) => node.file === use && ["lazy", "eager", "shadow", "wrong", "reassigned"].includes(node.name),
      );
      const make = await findReferences(index, { file: lib, line: 1, column: libSource.indexOf("make") + 1 });
      const check = await findReferences(index, {
        file: lib,
        line: 2,
        column: libSource.split("\n")[1]!.indexOf("check") + 1,
      });
      const sites = (result: typeof make) =>
        result.status === "ok"
          ? result.references.map((site) => `${path.basename(site.file)}:${site.range.start.line}`).sort()
          : result.status;
      expect.soft(sites(make)).toEqual(["lib.ts:1", "use.ts:11", "use.ts:5"]);
      expect.soft(sites(check)).toEqual(["lib.ts:2", "use.ts:7"]);
      const graphEdges = graph.edges
        .flatMap((edge) => {
          const from = callers.find((node) => node.id === edge.from);
          const to = members.find((node) => node.id === edge.to);
          return from && to && (edge.label === "uses" || edge.label === "calls")
            ? [`${from.name} ${edge.label} ${to.name}`]
            : [];
        })
        .sort();
      expect
        .soft(graphEdges)
        .toEqual([
          "eager calls make",
          "eager uses make",
          "lazy calls check",
          "lazy calls make",
          "lazy uses check",
          "lazy uses make",
        ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("JavaScript preserves an alias assigned from require but not a parameter or different module", async () => {
    const root = await mkTmpDir("cg-require-module-shadow-");
    try {
      const useSource = [
        "export async function eager() {",
        '  const lib = await import("./lib.js");',
        "  return lib.make();",
        "}",
        "export function assigned() {",
        "  let lib;",
        '  lib = require("./lib.js");',
        "  return lib.make();",
        "}",
        "export function shadow(lib) {",
        "  return lib.make();",
        "}",
        "export function other() {",
        "  let lib;",
        '  lib = require("./other.js");',
        "  return lib.make();",
        "}",
        "",
      ].join("\n");
      await Promise.all([
        fs.writeFile(path.join(root, "lib.js"), 'export function make() { return "lib"; }\n'),
        fs.writeFile(path.join(root, "other.js"), 'export function make() { return "other"; }\n'),
        fs.writeFile(path.join(root, "use.js"), useSource),
      ]);
      const lib = path.join(root, "lib.js").split(path.sep).join("/");
      const use = path.join(root, "use.js").split(path.sep).join("/");
      const index = await buildProjectIndex(root, { cache: "off", logLevel: "silent" });
      const references = await findReferences(index, { file: lib, line: 1, column: 17 });
      expect
        .soft(
          references.status === "ok"
            ? references.references.map((site) => `${path.basename(site.file)}:${site.range.start.line}`).sort()
            : references.status,
        )
        .toEqual(["lib.js:1", "use.js:3", "use.js:8"]);
      const graph = await buildSymbolGraphDetailed(index);
      const nodes = [...graph.nodes.values()];
      const member = nodes.find((node) => node.file === lib && node.name === "make");
      const callers = nodes.filter(
        (node) => node.file === use && ["eager", "assigned", "shadow", "other"].includes(node.name),
      );
      const edges = graph.edges
        .flatMap((edge) => {
          const from = callers.find((node) => node.id === edge.from);
          return from && edge.to === member?.id && (edge.label === "calls" || edge.label === "uses")
            ? [`${from.name} ${edge.label} make`]
            : [];
        })
        .sort();
      expect.soft(edges).toEqual(["assigned calls make", "assigned uses make", "eager calls make", "eager uses make"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("C# keeps alias graph calls and uses off shadowed parameters and block locals", async () => {
    const root = await mkTmpDir("cg-csharp-alias-shadow-");
    try {
      const paths = await writeFixtureFiles(root, CSHARP_ALIAS_SHADOW_FILES);
      const index = await buildProjectIndex(root, { cache: "off", logLevel: "silent" });
      const graph = await buildSymbolGraphDetailed(index);
      const nodes = [...graph.nodes.values()];
      const use = paths["Use.cs"]!;
      const second = paths["Second.cs"]!;
      const plain = paths["Plain.cs"]!;
      const edgesTo = (caller: string, file: string, name: string, label: "calls" | "uses") => {
        const from = nodes.find((node) => node.file === use && node.name === caller);
        const targets = nodes.filter((node) => node.file === file && node.name === name);
        expect(from, `missing caller ${caller}`).toBeDefined();
        expect(targets, `missing target ${file}::${name}`).not.toHaveLength(0);
        return graph.edges.filter(
          (edge) => edge.from === from?.id && targets.some((target) => edge.to === target.id) && edge.label === label,
        );
      };
      for (const caller of ["Visible", "Local"]) {
        expect(edgesTo(caller, second, "Run", "calls")).toHaveLength(1);
      }
      for (const caller of ["Outer", "Outside"]) {
        expect(edgesTo(caller, plain, "Run", "calls")).toHaveLength(1);
        expect(edgesTo(caller, second, "Run", "calls")).toHaveLength(0);
      }
      for (const caller of ["Parameter", "Unused"]) {
        expect(edgesTo(caller, second, "Second", "uses")).toHaveLength(0);
      }
      for (const caller of ["Parameter", "Unused"]) {
        for (const label of ["calls", "uses"] as const) {
          expect(edgesTo(caller, second, "Run", label)).toHaveLength(0);
          expect(edgesTo(caller, second, "Nested", label)).toHaveLength(0);
        }
      }
      expect(edgesTo("Typed", second, "Act", "calls")).toHaveLength(1);

      const call = await goToDefinition(index, {
        file: use,
        line: CSHARP_ALIAS_SHADOW_SITES.visible,
        column: columnOf(CSHARP_ALIAS_SHADOW_LINES, CSHARP_ALIAS_SHADOW_SITES.visible, "Run"),
      });
      expect(call.status).toBe("ok");
      if (call.status === "ok") expect(call.definition.file).toBe(second);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("C# does not turn unused same-name parameters into alias uses with only one alias", async () => {
    const root = await mkTmpDir("cg-csharp-only-alias-shadow-");
    try {
      const files = await writeFixtureFiles(root, CSHARP_ALIAS_ONLY_FILES);
      const index = await buildProjectIndex(root, { cache: "off", logLevel: "silent" });
      const graph = await buildSymbolGraphDetailed(index);
      const nodes = [...graph.nodes.values()];
      const targetFile = files["Second.cs"]!;
      const fromFile = files["Use.cs"]!;
      const edges = graph.edges.flatMap((edge) => {
        const from = nodes.find((node) => node.id === edge.from);
        const to = nodes.find((node) => node.id === edge.to);
        if (from?.file !== fromFile || to?.file !== targetFile) return [];
        if (edge.label !== "calls" && edge.label !== "uses") return [];
        return [`${from.name} ${edge.label} ${to.name}`];
      });
      expect(edges).toContain("Visible calls Run");
      expect(edges).toContain("Visible uses Second");
      expect(edges).toContain("Typed calls Act");
      expect(edges).toContain("Typed uses Second");
      for (const caller of ["Parameter", "Unused", "Local"]) {
        expect(edges.filter((edge) => edge.startsWith(`${caller} `))).toEqual([]);
      }
      const annotatedType = await goToDefinition(index, {
        file: fromFile,
        line: 7,
        column: columnOf(CSHARP_ALIAS_ONLY_LINES, 7, "B"),
      });
      expect(annotatedType.status).toBe("ok");
      if (annotatedType.status === "ok") {
        expect(annotatedType.definition.file).toBe(targetFile);
        expect(annotatedType.definition.localName).toBe("Second");
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("C# namespace alias qualification remains explicit through a same-name parameter", async () => {
    const root = await mkTmpDir("cg-csharp-qualified-namespace-shadow-");
    try {
      const files = await writeFixtureFiles(root, {
        "Second.cs": CSHARP_ALIAS_ONLY_FILES["Second.cs"],
        "Use.cs": [
          "using B = N;",
          "class Use { void Visible() { B::Second.Nested.Run(); }",
          "  void Parameter(dynamic B) { B::Second.Nested.Run(); } }",
          "",
        ].join("\n"),
      });
      const index = await buildProjectIndex(root, { cache: "off", logLevel: "silent" });
      const graph = await buildSymbolGraphDetailed(index);
      const run = [...graph.nodes.values()].find((node) => node.name === "Run" && node.file === files["Second.cs"]);
      expect(run).toBeDefined();
      for (const caller of ["Visible", "Parameter"]) {
        const from = [...graph.nodes.values()].find((node) => node.name === caller && node.file === files["Use.cs"]);
        expect(from).toBeDefined();
        expect(
          graph.edges.some((edge) => edge.from === from?.id && edge.to === run?.id && edge.label === "calls"),
        ).toBe(true);
      }
      const references = await findReferences(index, {
        file: files["Second.cs"]!,
        line: 1,
        column: CSHARP_ALIAS_ONLY_FILES["Second.cs"].indexOf("Run") + 1,
      });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        expect(
          references.references
            .filter((site) => site.file === files["Use.cs"])
            .map((site) => site.range.start.line)
            .sort(),
        ).toEqual([2, 3]);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it.each(CSHARP_ALIAS_BOUNDARIES)("C# $name shadowing respects ::", async (boundary) => {
    for (const qualified of [false, true]) {
      const root = await mkTmpDir("cg-csharp-alias-boundary-");
      try {
        const fixture = csharpAliasBoundaryFixture(boundary, qualified);
        const files = await writeFixtureFiles(root, fixture.files);
        for (const cache of ["off", "disk", "disk"] as const) {
          const index = await buildProjectIndex(root, { cache, logLevel: "silent" });
          const graph = await buildSymbolGraphDetailed(index);
          const call = async (line: number) =>
            goToDefinition(index, {
              file: files["Use.cs"]!,
              line,
              column: columnOf(fixture.lines, line, "Run"),
            });
          const visible = await call(fixture.visible);
          expect(visible.status).toBe("ok");
          if (visible.status === "ok") expect(visible.definition.file).toBe(files["Second.cs"]);
          const shadowed = await call(fixture.shadowed);
          const nestedType = !qualified && boundary.name === "nested type";
          if (qualified || nestedType) {
            expect(shadowed.status).toBe("ok");
            if (shadowed.status === "ok") {
              expect(shadowed.definition.file).toBe(nestedType ? files["Use.cs"] : files["Second.cs"]);
            }
          } else {
            expect(shadowed.status).toBe("not_found");
          }
          const targetEdges = graph.edges.filter((edge) => {
            const from = graph.nodes.get(edge.from);
            const to = graph.nodes.get(edge.to);
            return from?.file === files["Use.cs"] && to?.file === files["Second.cs"];
          });
          expect(
            targetEdges
              .filter((edge) => edge.label === "calls")
              .map((edge) => edge.site?.range.start.line)
              .sort(),
          ).toEqual(qualified ? [fixture.shadowed, fixture.visible] : [fixture.visible]);
          if (!qualified) {
            expect(targetEdges.filter((edge) => graph.nodes.get(edge.from)?.name === "Shadowed")).toEqual([]);
          }
          expect(
            graph.edges.filter(
              (edge) =>
                graph.nodes.get(edge.from)?.file === files["Use.cs"] &&
                graph.nodes.get(edge.to)?.file === files["Decoy.cs"],
            ),
          ).toEqual([]);
          if (nestedType) {
            expect(
              graph.edges.some((edge) => {
                if (edge.label !== "calls") return false;
                const from = graph.nodes.get(edge.from);
                const to = graph.nodes.get(edge.to);
                return from?.name === "Shadowed" && to?.file === files["Use.cs"] && to.name === "Run";
              }),
            ).toBe(true);
          }
          const references = await findReferences(index, {
            file: files["Second.cs"]!,
            line: 1,
            column: fixture.files["Second.cs"].indexOf("Run") + 1,
          });
          expect(references.status).toBe("ok");
          if (references.status === "ok") {
            expect(
              references.references
                .filter((site) => site.file === files["Use.cs"])
                .map((site) => site.range.start.line)
                .sort(),
            ).toEqual(qualified ? [fixture.shadowed, fixture.visible] : [fixture.visible]);
          }
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  it.each(CSHARP_ALIAS_TYPE_FORMS)("C# $name keeps alias and value uses separate", async (form) => {
    for (const shadowed of [false, true]) {
      const root = await mkTmpDir("cg-csharp-alias-type-");
      try {
        const fixture = csharpAliasTypeFixture(form, shadowed);
        const files = await writeFixtureFiles(root, fixture.files);
        const aliasUse = !shadowed || form.aliasUse;
        for (const cache of ["off", "disk", "disk"] as const) {
          const index = await buildProjectIndex(root, { cache, logLevel: "silent" });
          const result = await goToDefinition(index, {
            file: files["Use.cs"]!,
            line: fixture.use,
            column: columnOf(fixture.lines, fixture.use, form.token),
          });
          expect(result.status).toBe("ok");
          if (result.status === "ok") {
            expect(result.definition.file).toBe(aliasUse ? files["Second.cs"] : files["Use.cs"]);
          }
          const graph = await buildSymbolGraphDetailed(index);
          const uses = graph.edges.filter(
            (edge) =>
              edge.label === "uses" &&
              graph.nodes.get(edge.from)?.name === "Types" &&
              graph.nodes.get(edge.to)?.file === files["Second.cs"],
          );
          expect(uses).toHaveLength(aliasUse ? 1 : 0);
          expect(graph.edges.filter((edge) => graph.nodes.get(edge.to)?.file === files["Decoy.cs"])).toEqual([]);
          const references = await findReferences(index, {
            file: files["Second.cs"]!,
            line: 1,
            column: fixture.files["Second.cs"].indexOf("Second") + 1,
          });
          expect(references.status).toBe("ok");
          if (references.status === "ok") {
            const bodySites = references.references.filter(
              (site) => site.file === files["Use.cs"] && site.range.start.line === fixture.use,
            );
            const expectedCount = aliasUse ? 1 : 0;
            expect(bodySites).toHaveLength(expectedCount);
          }
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });
  it.each(CSHARP_ALIAS_VALUE_SPELLINGS)("C# keeps $name bound to its proven value", async (spelling) => {
    const root = await mkTmpDir("cg-csharp-alias-verbatim-value-");
    try {
      const fixture = csharpAliasValueFixture(spelling);
      const files = await writeFixtureFiles(root, fixture.files);
      for (const cache of ["off", "disk", "disk"] as const) {
        const index = await buildProjectIndex(root, { cache, logLevel: "silent" });
        for (const line of [5, 6]) {
          const result = await goToDefinition(index, {
            file: files["Use.cs"]!,
            line,
            column: columnOf(fixture.lines, line, "Run"),
          });
          expect(result.status).toBe("ok");
          if (result.status === "ok") expect(result.definition.file).toBe(files["Value.cs"]);
        }
        const graph = await buildSymbolGraphDetailed(index);
        const edges = graph.edges.filter((edge) => graph.nodes.get(edge.from)?.name === "M");
        expect(
          edges
            .filter((edge) => edge.label === "calls")
            .map((edge) => [graph.nodes.get(edge.to)?.file, edge.site?.range.start.line]),
        ).toEqual([
          [files["Value.cs"], 5],
          [files["Value.cs"], 6],
        ]);
        expect(edges.filter((edge) => graph.nodes.get(edge.to)?.file === files["Second.cs"])).toEqual([]);
        for (const target of ["Second.cs", "Value.cs"] as const) {
          const result = await findReferences(index, {
            file: files[target]!,
            line: 1,
            column: fixture.files[target].indexOf("Run") + 1,
          });
          expect(result.status).toBe("ok");
          if (result.status === "ok") {
            expect(
              result.references.filter((site) => site.file === files["Use.cs"]).map((site) => site.range.start.line),
            ).toEqual(target === "Value.cs" ? [5, 6] : []);
          }
        }
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("C# restores aliases after transient binding scopes", async () => {
    const transientNames = [
      "local",
      "lambda parameter",
      "parenthesized lambda parameter",
      "foreach variable",
      "pattern variable",
      "out variable",
      "local function",
    ];
    for (const boundary of CSHARP_ALIAS_BOUNDARIES) {
      if (!transientNames.includes(boundary.name)) continue;
      const root = await mkTmpDir("cg-csharp-alias-scope-exit-");
      try {
        const fixture = csharpAliasBoundaryFixture(boundary);
        const lines = [...fixture.lines.slice(0, 5), "    B.Nested.Run();", ...fixture.lines.slice(5)];
        const files = await writeFixtureFiles(root, { ...fixture.files, "Use.cs": lines.join("\n") + "\n" });
        const index = await buildProjectIndex(root, { cache: "off", logLevel: "silent" });
        const result = await goToDefinition(index, {
          file: files["Use.cs"]!,
          line: 6,
          column: columnOf(lines, 6, "Run"),
        });
        expect(result.status).toBe("ok");
        if (result.status === "ok") expect(result.definition.file).toBe(files["Second.cs"]);
        const graph = await buildSymbolGraphDetailed(index);
        const calls = graph.edges.filter(
          (edge) =>
            edge.label === "calls" &&
            graph.nodes.get(edge.from)?.file === files["Use.cs"] &&
            graph.nodes.get(edge.to)?.file === files["Second.cs"],
        );
        expect(calls.map((edge) => edge.site?.range.start.line).sort()).toEqual([6, 9]);
        const references = await findReferences(index, {
          file: files["Second.cs"]!,
          line: 1,
          column: fixture.files["Second.cs"].indexOf("Run") + 1,
        });
        expect(references.status).toBe("ok");
        if (references.status === "ok") {
          expect(
            references.references
              .filter((site) => site.file === files["Use.cs"])
              .map((site) => site.range.start.line)
              .sort(),
          ).toEqual([6, 9]);
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  it("C# foreach reads its collection before the iteration variable shadows the alias", async () => {
    const root = await mkTmpDir("cg-csharp-alias-foreach-collection-");
    try {
      const lines = [
        "using B = N.Second;",
        "class Use {",
        "  void Loop() {",
        "    foreach (var B in B.Items) { B.Nested.Run(); }",
        "    B.Nested.Run();",
        "  }",
        "}",
      ];
      const second =
        "namespace N; public class Second { public static dynamic[] Items; " +
        "public class Nested { public static void Run() {} } }\n";
      const files = await writeFixtureFiles(root, { "Second.cs": second, "Use.cs": lines.join("\n") + "\n" });
      const index = await buildProjectIndex(root, { cache: "off", logLevel: "silent" });
      const collection = await goToDefinition(index, {
        file: files["Use.cs"]!,
        line: 4,
        column: columnOf(lines, 4, "Items"),
      });
      expect(collection.status).toBe("ok");
      if (collection.status === "ok") {
        expect(collection.definition.file).toBe(files["Second.cs"]);
        expect(collection.definition.localName).toBe("Items");
      }
      const body = await goToDefinition(index, {
        file: files["Use.cs"]!,
        line: 4,
        column: columnOf(lines, 4, "Run"),
      });
      expect(body.status).toBe("not_found");
      const graph = await buildSymbolGraphDetailed(index);
      expect(graph.edges.filter((edge) => edge.label === "calls").map((edge) => edge.site?.range.start.line)).toEqual([
        5,
      ]);
      const references = await findReferences(index, {
        file: files["Second.cs"]!,
        line: 1,
        column: second.indexOf("Run") + 1,
      });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        expect(
          references.references.filter((site) => site.file === files["Use.cs"]).map((site) => site.range.start.line),
        ).toEqual([5]);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("C# attributes are alias type uses, not their same-named value declarations", async () => {
    const root = await mkTmpDir("cg-csharp-attribute-alias-value-");
    try {
      const lines = ["using B = N.MarkerAttribute;", "class Use {", "  dynamic B;", "  [B] void M(dynamic B) {}", "}"];
      const files = await writeFixtureFiles(root, {
        "Marker.cs": "namespace N; public class MarkerAttribute : System.Attribute {}\n",
        "Decoy.cs": "namespace Decoy; public class MarkerAttribute : System.Attribute {}\n",
        "Use.cs": lines.join("\n") + "\n",
      });
      const index = await buildProjectIndex(root, { cache: "off", logLevel: "silent" });
      const result = await goToDefinition(index, {
        file: files["Use.cs"]!,
        line: 4,
        column: columnOf(lines, 4, "B"),
      });
      expect(result.status).toBe("ok");
      if (result.status === "ok") expect(result.definition.file).toBe(files["Marker.cs"]);
      const graph = await buildSymbolGraphDetailed(index);
      const uses = graph.edges.filter((edge) => edge.label === "uses" && graph.nodes.get(edge.from)?.name === "M");
      expect(uses.map((edge) => graph.nodes.get(edge.to)?.file)).toEqual([files["Marker.cs"]]);
      const references = await findReferences(index, { file: files["Marker.cs"]!, line: 1, column: 27 });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        expect(
          references.references
            .filter((site) => site.file === files["Use.cs"] && site.range.start.line > 1)
            .map((site) => [site.range.start.line, site.range.start.column]),
        ).toEqual([[4, columnOf(lines, 4, "B")]]);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("C# leaves proven receivers alone when no using alias declares their name", async () => {
    const root = await mkTmpDir("cg-csharp-no-alias-receivers-");
    try {
      const lines = [
        "using N;",
        "class Use {",
        "  Second field;",
        "  void Param(Second s) { s.Act(); }",
        "  void Local() { var s = new Second(); s.Act(); }",
        "  void Field() { field.Act(); }",
        "  void Lambda() { System.Action<Second> f = (Second s) => s.Act(); }",
        "  void Foreach(Second[] values) { foreach (var s in values) s.Act(); }",
        "}",
      ];
      const secondSource = "namespace N; public class Second { public void Act() {} }\n";
      const files = await writeFixtureFiles(root, {
        "Second.cs": secondSource,
        "Decoy.cs": "namespace Other; public class Decoy { public void Act() {} }\n",
        "Use.cs": lines.join("\n") + "\n",
      });
      for (const cache of ["off", "disk", "disk"] as const) {
        const index = await buildProjectIndex(root, { cache, logLevel: "silent" });
        const graph = await buildSymbolGraphDetailed(index);
        const calls = graph.edges.filter((edge) => edge.label === "calls");
        expect(calls.map((edge) => [graph.nodes.get(edge.from)?.name, graph.nodes.get(edge.to)?.file]).sort()).toEqual([
          ["Lambda", files["Second.cs"]],
          ["Local", files["Second.cs"]],
          ["Param", files["Second.cs"]],
        ]);
        // Untyped foreach elements and a bare field keep the baseline's conservative graph result.
        for (const line of [4, 5, 7]) {
          const result = await goToDefinition(index, {
            file: files["Use.cs"]!,
            line,
            column: columnOf(lines, line, "Act()"),
          });
          expect(result.status).toBe("ok");
          if (result.status === "ok") expect(result.definition.file).toBe(files["Second.cs"]);
        }
        expect(
          graph.edges.filter(
            (edge) =>
              graph.nodes.get(edge.from)?.file === files["Use.cs"] &&
              graph.nodes.get(edge.to)?.file === files["Decoy.cs"],
          ),
        ).toEqual([]);
        const references = await findReferences(index, {
          file: files["Second.cs"]!,
          line: 1,
          column: secondSource.indexOf("Act") + 1,
        });
        expect(references.status).toBe("ok");
        if (references.status === "ok") {
          const callLines = references.references
            .filter((site) => site.file === files["Use.cs"])
            .map((site) => site.range.start.line);
          for (const line of [4, 5, 7]) expect(callLines).toContain(line);
        }
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("C# type-only names retain the nearest alias beside a shadowing parameter", async () => {
    const root = await mkTmpDir("cg-csharp-scoped-type-alias-");
    try {
      const lines = [
        "using B = N.Plain;",
        "namespace C {",
        "  using B = N.Second;",
        "  class Use {",
        "    void Types(dynamic B) {",
        "      B item = null;",
        "      _ = typeof(B);",
        "      B.Nested.Run();",
        "    }",
        "  }",
        "}",
        "class Outside {",
        "  void Visible() { B.Nested.Run(); }",
        "}",
      ];
      const files = await writeFixtureFiles(root, {
        ...CSHARP_ALIAS_SHADOW_FILES,
        "Use.cs": lines.join("\n") + "\n",
      });
      for (const cache of ["off", "disk", "disk"] as const) {
        const index = await buildProjectIndex(root, { cache, logLevel: "silent" });
        for (const line of [6, 7]) {
          const result = await goToDefinition(index, {
            file: files["Use.cs"]!,
            line,
            column: columnOf(lines, line, "B"),
          });
          expect(result.status).toBe("ok");
          if (result.status === "ok") expect(result.definition.file).toBe(files["Second.cs"]);
        }
        const shadowed = await goToDefinition(index, {
          file: files["Use.cs"]!,
          line: 8,
          column: columnOf(lines, 8, "Run"),
        });
        expect(shadowed.status).toBe("not_found");
        const graph = await buildSymbolGraphDetailed(index);
        const calls = graph.edges.filter((edge) => edge.label === "calls");
        expect(calls.map((edge) => [graph.nodes.get(edge.to)?.file, edge.site?.range.start.line])).toEqual([
          [files["Plain.cs"], 13],
        ]);
        const references = await findReferences(index, {
          file: files["Second.cs"]!,
          line: 1,
          column: CSHARP_ALIAS_SHADOW_FILES["Second.cs"].indexOf("Second") + 1,
        });
        expect(references.status).toBe("ok");
        if (references.status === "ok") {
          expect(
            references.references
              .filter((site) => site.file === files["Use.cs"] && site.range.start.line >= 5)
              .map((site) => site.range.start.line),
          ).toEqual([6, 7]);
        }
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("C# confines catch and for bindings while preserving their reads and subsequent alias calls", async () => {
    const root = await mkTmpDir("cg-csharp-catch-for-scope-");
    try {
      const files = await writeFixtureFiles(root, CSHARP_SCOPE_READ_FILES);
      const index = await buildProjectIndex(root, { cache: "off", logLevel: "silent" });
      const file = files["Use.cs"]!;
      for (const line of [8, 12]) {
        for (const token of ["B", "Ping"]) {
          const result = await goToDefinition(index, {
            file,
            line,
            column: columnOf(CSHARP_SCOPE_READ_LINES, line, token),
          });
          expect(result.status).toBe("ok");
          if (result.status === "ok") expect(result.definition.file).toBe(files["Second.cs"]);
        }
      }
      for (const line of [7, 11]) {
        const declarationColumn = columnOf(CSHARP_SCOPE_READ_LINES, line, "B");
        const local = await goToDefinition(index, {
          file,
          line,
          column: CSHARP_SCOPE_READ_LINES[line - 1]!.lastIndexOf("B") + 1,
        });
        expect(local.status).toBe("ok");
        if (local.status === "ok") {
          expect(local.definition.file).toBe(file);
          expect(local.definition.range.start).toMatchObject({ line, column: declarationColumn });
        }
        const references = await findReferences(index, { file, line, column: declarationColumn });
        expect(references.status).toBe("ok");
        if (references.status === "ok") {
          expect(references.referenceCoverage.state).toBe("complete");
          expect(references.references.map((site) => site.range.start.line)).toEqual(
            line === 7 ? [7, 7, 7] : [11, 11, 11, 11],
          );
        }
      }
      const references = await findReferences(index, {
        file: files["Second.cs"]!,
        line: 1,
        column: CSHARP_SCOPE_READ_FILES["Second.cs"].indexOf("Ping") + 1,
      });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        expect(references.referenceCoverage.state).toBe("complete");
        expect(references.references.filter((site) => site.file === file).map((site) => site.range.start.line)).toEqual(
          [8, 12],
        );
        expect(references.references.some((site) => site.file === files["Decoy.cs"])).toBe(false);
      }
      const graph = await buildSymbolGraphDetailed(index);
      const calls = graph.edges.filter((edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "Ping");
      expect(calls.map((edge) => [graph.nodes.get(edge.to)?.file, edge.site?.range.start.line])).toEqual([
        [files["Second.cs"], 8],
        [files["Second.cs"], 12],
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("C# lambda defaults and constant patterns remain reads of their enclosing constants", async () => {
    const root = await mkTmpDir("cg-csharp-default-pattern-reads-");
    try {
      const files = await writeFixtureFiles(root, CSHARP_SCOPE_READ_FILES);
      const index = await buildProjectIndex(root, { cache: "off", logLevel: "silent" });
      const file = files["Use.cs"]!;
      for (const [line, token, declaration] of [
        [14, "K", 3],
        [15, "Match", 4],
      ] as const) {
        const columns = [columnOf(CSHARP_SCOPE_READ_LINES, line, token)];
        if (token === "K") columns.push(CSHARP_SCOPE_READ_LINES[line - 1]!.lastIndexOf(token) + 1);
        for (const column of columns) {
          const result = await goToDefinition(index, { file, line, column });
          expect(result.status).toBe("ok");
          if (result.status === "ok") {
            expect(result.definition.file).toBe(file);
            expect(result.definition.range.start.line).toBe(declaration);
          }
        }
        const references = await findReferences(index, {
          file,
          line: declaration,
          column: columnOf(CSHARP_SCOPE_READ_LINES, declaration, token),
        });
        expect(references.status).toBe("ok");
        if (references.status === "ok") {
          expect(references.referenceCoverage.state).toBe("complete");
          expect(
            references.references.map((site) => [site.file, site.range.start.line, site.range.start.column]),
          ).toEqual([
            [file, declaration, columnOf(CSHARP_SCOPE_READ_LINES, declaration, token)],
            ...columns.map((column) => [file, line, column]),
          ]);
        }
      }
      const parameterColumn = columnOf(CSHARP_SCOPE_READ_LINES, 14, "x");
      const parameterReferences = await findReferences(index, { file, line: 14, column: parameterColumn });
      expect(parameterReferences.status).toBe("ok");
      if (parameterReferences.status === "ok") {
        expect(parameterReferences.referenceCoverage.state).toBe("complete");
        expect(parameterReferences.references.map((site) => site.range.start.column)).toEqual([
          parameterColumn,
          CSHARP_SCOPE_READ_LINES[13].lastIndexOf("x") + 1,
        ]);
      }
      const graph = await buildSymbolGraphDetailed(index);
      // The graph records imported type uses, not bare reads of local constants.
      for (const caller of ["Lambda", "Pattern"]) {
        const importedUses = graph.edges.filter((edge) => {
          if (edge.label !== "uses" || graph.nodes.get(edge.from)?.name !== caller) return false;
          return graph.nodes.get(edge.to)?.file !== file;
        });
        expect(importedUses).toEqual([]);
      }
      expect(
        graph.edges.some((edge) => {
          if (edge.label !== "uses" || graph.nodes.get(edge.from)?.name !== "Declaration") return false;
          return graph.nodes.get(edge.to)?.file === files["Second.cs"];
        }),
      ).toBe(true);
      expect(
        graph.edges.filter(
          (edge) => graph.nodes.get(edge.from)?.file === file && graph.nodes.get(edge.to)?.file === files["Decoy.cs"],
        ),
      ).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("C# foreach designations shadow only the loop body, including deconstruction and typed elements", async () => {
    const root = await mkTmpDir("cg-csharp-foreach-designations-");
    try {
      const files = await writeFixtureFiles(root, CSHARP_SCOPE_READ_FILES);
      const file = files["Use.cs"]!;
      for (const cache of ["off", "disk", "disk"] as const) {
        const index = await buildProjectIndex(root, { cache, logLevel: "silent" });
        for (const line of [17, 21, 25]) {
          const result = await goToDefinition(index, {
            file,
            line,
            column: columnOf(CSHARP_SCOPE_READ_LINES, line, "Run"),
          });
          expect(result.status).toBe("not_found");
          const receiver = await goToDefinition(index, {
            file,
            line,
            column: CSHARP_SCOPE_READ_LINES[line - 1]!.lastIndexOf("B") + 1,
          });
          expect(receiver.status).toBe("ok");
          if (receiver.status === "ok") {
            expect(receiver.definition.file).toBe(file);
            expect(receiver.definition.range.start).toMatchObject({
              line,
              column: columnOf(CSHARP_SCOPE_READ_LINES, line, "B"),
            });
          }
          const references = await findReferences(index, {
            file,
            line,
            column: columnOf(CSHARP_SCOPE_READ_LINES, line, "B"),
          });
          expect(references.status).toBe("ok");
          if (references.status === "ok") {
            expect(references.referenceCoverage.state).toBe("complete");
            expect(references.references.map((site) => site.range.start.column)).toEqual([
              columnOf(CSHARP_SCOPE_READ_LINES, line, "B"),
              CSHARP_SCOPE_READ_LINES[line - 1]!.lastIndexOf("B") + 1,
            ]);
          }
        }
        for (const [line, token] of [
          [18, "Run"],
          [21, "Rows"],
          [22, "Run"],
          [26, "Run"],
        ] as const) {
          const result = await goToDefinition(index, {
            file,
            line,
            column: columnOf(CSHARP_SCOPE_READ_LINES, line, token),
          });
          expect(result.status).toBe("ok");
          if (result.status === "ok") expect(result.definition.file).toBe(files["Second.cs"]);
        }
        const references = await findReferences(index, {
          file: files["Second.cs"]!,
          line: 1,
          column: CSHARP_SCOPE_READ_FILES["Second.cs"].indexOf("Run") + 1,
        });
        expect(references.status).toBe("ok");
        if (references.status === "ok") {
          // Dynamic element receivers cannot prove every candidate, but must not become alias references.
          expect(references.referenceCoverage).toEqual({
            scope: "indexed_candidates",
            state: "partial",
            reasons: ["strategy_unavailable"],
            affectedFiles: [file],
          });
          expect(
            references.references.filter((site) => site.file === file).map((site) => site.range.start.line),
          ).toEqual([18, 22, 26]);
        }
        const graph = await buildSymbolGraphDetailed(index);
        const calls = graph.edges.filter((edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "Run");
        expect(calls.map((edge) => [graph.nodes.get(edge.to)?.file, edge.site?.range.start.line])).toEqual([
          [files["Second.cs"], 18],
          [files["Second.cs"], 22],
          [files["Second.cs"], 26],
        ]);
        expect(
          graph.edges.filter(
            (edge) => graph.nodes.get(edge.from)?.file === file && graph.nodes.get(edge.to)?.file === files["Decoy.cs"],
          ),
        ).toEqual([]);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("Kotlin type names bypass value bindings without stealing their expression references", async () => {
    const root = await mkTmpDir("cg-kotlin-type-value-names-");
    try {
      const files = await writeFixtureFiles(root, KOTLIN_TYPE_VALUE_FILES);
      const file = files["Use.kt"]!;
      for (const cache of ["off", "disk", "disk"] as const) {
        const index = await buildProjectIndex(root, { cache, logLevel: "silent" });
        for (const line of KOTLIN_TYPE_VALUE_TYPE_LINES) {
          const column = KOTLIN_TYPE_VALUE_LINES[line - 1]!.lastIndexOf("Widget") + 1;
          const result = await goToDefinition(index, { file, line, column });
          expect(result.status).toBe("ok");
          if (result.status === "ok") expect(result.definition.file).toBe(files["Api.kt"]);
        }
        for (const [declaration, use] of [
          [3, 6],
          [9, 11],
          [15, 16],
        ] as const) {
          const column = columnOf(KOTLIN_TYPE_VALUE_LINES, declaration, "Widget");
          const result = await goToDefinition(index, {
            file,
            line: use,
            column: columnOf(KOTLIN_TYPE_VALUE_LINES, use, "Widget"),
          });
          expect(result.status).toBe("ok");
          if (result.status === "ok") {
            expect(result.definition.file).toBe(file);
            expect(result.definition.range.start).toMatchObject({ line: declaration, column });
          }
          const references = await findReferences(index, { file, line: declaration, column });
          expect(references.status).toBe("ok");
          if (references.status === "ok") {
            expect(references.referenceCoverage.state).toBe("complete");
            expect(references.references.map((site) => site.range.start.line)).toEqual([declaration, use]);
          }
        }
        const references = await findReferences(index, { file: files["Api.kt"]!, line: 2, column: 7 });
        expect(references.status).toBe("ok");
        if (references.status === "ok") {
          expect(references.referenceCoverage.state).toBe("complete");
          expect(
            references.references.filter((site) => site.file === file).map((site) => site.range.start.line),
          ).toEqual([2, ...KOTLIN_TYPE_VALUE_TYPE_LINES]);
          expect(references.references.some((site) => site.file === files["Decoy.kt"])).toBe(false);
        }
        const graph = await buildSymbolGraphDetailed(index);
        for (const caller of ["use", "local", "later"]) {
          const uses = graph.edges.filter(
            (edge) =>
              edge.label === "uses" &&
              graph.nodes.get(edge.from)?.name === caller &&
              graph.nodes.get(edge.to)?.file === files["Api.kt"],
          );
          expect(uses).toHaveLength(1);
        }
        expect(
          graph.edges.filter(
            (edge) => graph.nodes.get(edge.from)?.file === file && graph.nodes.get(edge.to)?.file === files["Decoy.kt"],
          ),
        ).toEqual([]);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
describe("C# lowercase alias receiver proof", () => {
  it.each(CSHARP_ALIAS_CALL_SPELLINGS)("does not promote dynamic %s parameters or locals to types", async (alias) => {
    const root = await mkTmpDir("cg-csharp-lowercase-alias-shadow-");
    try {
      const fixture = csharpUnknownAliasReceiverFixture(alias);
      const files = await writeFixtureFiles(root, fixture.files);
      const index = await buildProjectIndex(root, { cache: "off" });
      for (const line of [3, 4, 5]) {
        const result = await goToDefinition(index, {
          file: files["Use.cs"]!,
          line,
          column: columnOf(fixture.lines, line, "Run"),
        });
        expect(result.status).toBe(line === 5 ? "ok" : "not_found");
        if (result.status === "ok") expect(result.definition.file).toBe(files["Target.cs"]);
      }
      const graph = await buildSymbolGraphDetailed(index);
      const calls = graph.edges.filter((edge) => edge.label === "calls");
      expect(calls.map((edge) => [edge.site?.range.start.line, graph.nodes.get(edge.to)?.file])).toEqual([
        [5, files["Target.cs"]],
      ]);
      const refs = await findReferences(index, {
        file: files["Target.cs"]!,
        line: 1,
        column: fixture.files["Target.cs"].indexOf("Run") + 1,
      });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") throw new Error("Expected partial dynamic alias references");
      expect(refs.referenceCoverage.state).toBe("partial");
      expect(refs.referenceCoverage.reasons).toContain("strategy_unavailable");
      expect(
        refs.references.filter((site) => site.file === files["Use.cs"]).map((site) => site.range.start.line),
      ).toEqual([5]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(CSHARP_GENERIC_ALIAS_CASES)(
    "keeps $scope parameter $parameter ahead of alias $alias",
    async ({ alias, parameter, scope }) => {
      const root = await mkTmpDir("cg-csharp-generic-alias-shadow-");
      try {
        const fixture = csharpGenericAliasReceiverFixture(alias, parameter, scope);
        const files = await writeFixtureFiles(root, fixture.files);
        const index = await buildProjectIndex(root, { cache: "off" });
        for (const line of [...fixture.shadowedCalls, fixture.restoredCall]) {
          const result = await goToDefinition(index, {
            file: files["Use.cs"]!,
            line,
            column: columnOf(fixture.lines, line, "Run"),
          });
          expect(result.status).toBe(line === fixture.restoredCall ? "ok" : "not_found");
          if (result.status === "ok") expect(result.definition.file).toBe(files["Target.cs"]);
        }
        const graph = await buildSymbolGraphDetailed(index);
        const calls = graph.edges.filter((edge) => edge.label === "calls");
        expect(calls.map((edge) => [edge.site?.range.start.line, graph.nodes.get(edge.to)?.file])).toEqual([
          [fixture.restoredCall, files["Target.cs"]],
        ]);
        const shadowedUses = graph.edges.filter((edge) => {
          if (edge.label !== "uses" || graph.nodes.get(edge.to)?.file !== files["Target.cs"]) return false;
          const caller = graph.nodes.get(edge.from)?.name;
          return caller === "Shadowed" || caller === "Inner";
        });
        expect(shadowedUses).toEqual([]);
        for (const file of ["Target.cs", "Decoy.cs"] as const) {
          const refs = await findReferences(index, {
            file: files[file]!,
            line: 1,
            column: fixture.files[file].indexOf("Run") + 1,
          });
          expect(refs.status).toBe("ok");
          if (refs.status !== "ok") throw new Error("Expected partial generic receiver references");
          expect(refs.referenceCoverage.state).toBe("partial");
          expect(refs.referenceCoverage.reasons).toContain("strategy_unavailable");
          expect(
            refs.references.filter((site) => site.file === files["Use.cs"]).map((site) => site.range.start.line),
          ).toEqual(file === "Target.cs" ? [fixture.restoredCall] : []);
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
describe("C# members bind before using aliases", () => {
  it.each(CSHARP_INHERITED_ALIAS_CASES)("$outcome: $name", async (testCase) => {
    const root = await mkTmpDir("cg-csharp-inherited-alias-");
    try {
      const files = await writeFixtureFiles(root, testCase.files);
      for (const cache of ["off", "disk", "disk"] as const) {
        const index = await buildProjectIndex(root, { cache, logLevel: "silent" });
        await expectInheritedAliasConsumers(index, files, testCase);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("binds an inherited nested type as a type receiver, not the alias", async () => {
    const root = await mkTmpDir("cg-csharp-inherited-nested-alias-");
    try {
      const testCase = CSHARP_INHERITED_NESTED_TYPE_CASE;
      const files = await writeFixtureFiles(root, testCase.files);
      for (const cache of ["off", "disk", "disk"] as const) {
        const index = await buildProjectIndex(root, { cache, logLevel: "silent" });
        const result = await goToDefinition(index, {
          file: files["Use.cs"]!,
          line: testCase.line,
          column: inheritedAliasRunColumn(testCase),
        });
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(result.definition.file).toBe(files["Use.cs"]);
          expect(result.definition.range.start.line).toBe(2);
        }
        const references = await findReferences(index, {
          file: files["N.cs"]!,
          line: 1,
          column: testCase.files["N.cs"]!.indexOf("Run") + 1,
        });
        expect(references.status).toBe("ok");
        if (references.status === "ok") {
          expect(references.references.filter((site) => site.file === files["Use.cs"])).toEqual([]);
          expect(references.referenceCoverage.state).toBe("complete");
        }
        const graph = await buildSymbolGraphDetailed(index);
        const targets = graph.edges.flatMap((edge) => {
          const from = graph.nodes.get(edge.from);
          const to = graph.nodes.get(edge.to);
          if (edge.label !== "calls" || from?.name !== "F" || !to) return [];
          return [`${path.basename(to.file)}::${to.name}`];
        });
        expect(targets).toEqual(["Use.cs::Run"]);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the alias in type positions beside an inherited field", async () => {
    const root = await mkTmpDir("cg-csharp-inherited-type-position-");
    try {
      const testCase = CSHARP_INHERITED_TYPE_POSITION_CASE;
      const files = await writeFixtureFiles(root, testCase.files);
      for (const cache of ["off", "disk", "disk"] as const) {
        const index = await buildProjectIndex(root, { cache, logLevel: "silent" });
        const result = await goToDefinition(index, {
          file: files["Use.cs"]!,
          line: testCase.line,
          column: columnOf(testCase.lines, testCase.line, "a()"),
        });
        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(result.definition.file).toBe(files["N.cs"]);
          expect(result.definition.localName).toBe("Target");
        }
        const graph = await buildSymbolGraphDetailed(index);
        const constructed = graph.edges.flatMap((edge) => {
          const from = graph.nodes.get(edge.from);
          const to = graph.nodes.get(edge.to);
          if (edge.label !== "instantiates" || from?.name !== "F" || !to) return [];
          return [`${path.basename(to.file)}::${to.name}`];
        });
        expect(constructed).toEqual(["N.cs::Target"]);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
