import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed } from "../src/graphs/symbol-graph-detailed.js";
import { buildProjectIndex, goToDefinition } from "../src/index.js";
import { mkTmpDir } from "./helpers/filesystem.js";

const fixtures = [
  {
    language: "C#",
    base: "Base.cs",
    derived: "Derived.cs",
    baseSource: [
      "public class Base {",
      "  public virtual int M(int x = 0) => 1;",
      "  public int Inherited() => 3;",
      "}",
    ].join("\n"),
    derivedSource: [
      "public class Derived : Base {",
      "  public override int M(int x) => 2;",
      "  public int Valid() => M(1);",
      "  public int Invalid() => M();",
      "  public int Other() => Inherited();",
      "}",
    ].join("\n"),
  },
  {
    language: "Java",
    base: "Base.java",
    derived: "Derived.java",
    baseSource: [
      "package demo; class Base {",
      "  int M(int x) { return 1; }",
      "  int Inherited() { return 3; }",
      "}",
    ].join("\n"),
    derivedSource: [
      "package demo; class Derived extends Base {",
      "  @Override int M(int x) { return 2; }",
      "  int Valid() { return M(1); }",
      "  int Invalid() { return M(); }",
      "  int Other() { return Inherited(); }",
      "}",
    ].join("\n"),
  },
] as const;

describe("override hiding before arity", () => {
  for (const fixture of fixtures) {
    it(`${fixture.language} does not call the hidden base method after an invalid derived call`, async () => {
      const root = await mkTmpDir("cg-override-hiding-");
      try {
        const baseFile = path.join(root, fixture.base).replace(/\\/g, "/");
        const derivedFile = path.join(root, fixture.derived).replace(/\\/g, "/");
        await fs.writeFile(baseFile, fixture.baseSource);
        await fs.writeFile(derivedFile, fixture.derivedSource);
        const index = await buildProjectIndex(root, { cache: "off", native: "on" });
        const at = async (line: number, name: string) =>
          await goToDefinition(index, {
            file: derivedFile,
            line,
            column: fixture.derivedSource.split("\n")[line - 1]!.lastIndexOf(name) + 1,
          });
        const valid = await at(3, "M");
        const invalid = await at(4, "M");
        const inherited = await at(5, "Inherited");
        expect(valid.status).toBe("ok");
        if (valid.status === "ok") expect(valid.definition.file).toBe(derivedFile);
        if (invalid.status === "ok") expect(invalid.definition.file).not.toBe(baseFile);
        expect(inherited.status).toBe("ok");
        if (inherited.status === "ok") expect(inherited.definition.file).toBe(baseFile);

        const graph = await buildSymbolGraphDetailed(index);
        const callees = (caller: string) =>
          graph.edges
            .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === caller)
            .map((edge) => graph.nodes.get(edge.to)?.file);
        expect(callees("Valid")).toContain(derivedFile);
        expect(callees("Valid")).not.toContain(baseFile);
        expect(callees("Invalid")).not.toContain(baseFile);
        expect(callees("Other")).toContain(baseFile);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }

  it("C# hides the base method when the only call has a count the override rejects", async () => {
    const root = await mkTmpDir("cg-override-hiding-only-");
    try {
      const baseFile = path.join(root, "Base.cs").replace(/\\/g, "/");
      const derivedFile = path.join(root, "Derived.cs").replace(/\\/g, "/");
      const useFile = path.join(root, "Use.cs").replace(/\\/g, "/");
      await fs.writeFile(baseFile, fixtures[0].baseSource);
      await fs.writeFile(
        derivedFile,
        ["public class Derived : Base {", "  public override int M(int x) => 2;", "}"].join("\n"),
      );
      await fs.writeFile(
        useFile,
        [
          "public class Use {",
          "  public int Invalid() => new Derived().M();",
          "  public int Other() => new Derived().Inherited();",
          "}",
        ].join("\n"),
      );
      const index = await buildProjectIndex(root, { cache: "off", native: "on" });
      const graph = await buildSymbolGraphDetailed(index);
      const callees = (caller: string) =>
        graph.edges
          .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === caller)
          .map((edge) => graph.nodes.get(edge.to)?.file);
      expect(callees("Invalid")).not.toContain(baseFile);
      expect(callees("Other")).toContain(baseFile);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
