import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed } from "../src/graphs/symbol-graph-detailed.js";
import { buildProjectIndex, findReferences, goToDefinition } from "../src/index.js";
import { mkTmpDir } from "./helpers/filesystem.js";
import {
  CSHARP_ALIAS_SHADOW_FILES,
  CSHARP_ALIAS_SHADOW_LINES,
  CSHARP_ALIAS_SHADOW_SITES,
} from "./helpers/csharp-alias-shadow-fixture.js";
import { CSHARP_ALIAS_ONLY_FILES, CSHARP_ALIAS_ONLY_LINES } from "./helpers/csharp-alias-only-shadow-fixture.js";
import { columnOf, writeFixtureFiles } from "./languages/callable-consumer-fixtures.js";

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
});
