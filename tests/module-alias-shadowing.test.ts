import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed } from "../src/graphs/symbol-graph-detailed.js";
import { buildProjectIndex, findReferences, goToDefinition } from "../src/index.js";
import { mkTmpDir } from "./helpers/filesystem.js";

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
});
