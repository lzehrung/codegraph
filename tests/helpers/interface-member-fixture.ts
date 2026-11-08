import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { buildSymbolGraphDetailed } from "../../src/graphs/symbol-graph-detailed.js";
import { buildProjectIndex, findReferences, goToDefinition } from "../../src/index.js";
import { columnOf, writeFixtureFiles } from "../languages/callable-consumer-fixtures.js";

type Site = { file: string; line: number; token: string };

/**
 * A member declared in a parent interface and called through a receiver typed as a child interface, beside a same-named
 * member of an unrelated type. The C#, Java, Kotlin, and TypeScript sources compile with Roslyn, javac, kotlinc, and tsc.
 */
export type InterfaceMemberFixture = {
  language: string;
  files: Readonly<Record<string, string>>;
  use: Site;
  declaration: Site;
  /** The unrelated type's same-named member; no answer may reach it. */
  decoy: { file: string };
  /** Name of the function that holds the call, whose graph `calls` edge must reach the declaration. */
  caller: string;
};

export const INTERFACE_MEMBER_FIXTURES: readonly InterfaceMemberFixture[] = [
  {
    language: "C#",
    files: {
      "A/IParent.cs": [
        "namespace A",
        "{",
        "    public interface IParent",
        "    {",
        "        int Run();",
        "    }",
        "}",
        "",
      ].join("\n"),
      "B/IChild.cs": [
        "using A;",
        "",
        "namespace B",
        "{",
        "    public interface IChild : IParent",
        "    {",
        "    }",
        "}",
        "",
      ].join("\n"),
      "C/Use.cs": [
        "using B;",
        "",
        "namespace C",
        "{",
        "    public class Use",
        "    {",
        "        public int F(IChild c)",
        "        {",
        "            return c.Run();",
        "        }",
        "    }",
        "}",
        "",
      ].join("\n"),
      "Z/Decoy.cs": [
        "namespace Z",
        "{",
        "    public class Decoy",
        "    {",
        "        public int Run() { return 0; }",
        "    }",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "C/Use.cs", line: 9, token: "Run" },
    declaration: { file: "A/IParent.cs", line: 5, token: "Run" },
    decoy: { file: "Z/Decoy.cs" },
    caller: "F",
  },
  {
    language: "Java",
    files: {
      "a/Parent.java": ["package a;", "", "public interface Parent {", "    int run();", "}", ""].join("\n"),
      "b/Child.java": [
        "package b;",
        "",
        "import a.Parent;",
        "",
        "public interface Child extends Parent {",
        "}",
        "",
      ].join("\n"),
      "c/Use.java": [
        "package c;",
        "",
        "import b.Child;",
        "",
        "public class Use {",
        "    public int f(Child c) {",
        "        return c.run();",
        "    }",
        "}",
        "",
      ].join("\n"),
      "z/Decoy.java": [
        "package z;",
        "",
        "public class Decoy {",
        "    public int run() {",
        "        return 0;",
        "    }",
        "}",
        "",
      ].join("\n"),
    },
    use: { file: "c/Use.java", line: 7, token: "run" },
    declaration: { file: "a/Parent.java", line: 4, token: "run" },
    decoy: { file: "z/Decoy.java" },
    caller: "f",
  },
  {
    language: "TypeScript",
    files: {
      "parent.ts": ["export interface Parent {", "  run(): number;", "}", ""].join("\n"),
      "child.ts": ['import { Parent } from "./parent";', "", "export interface Child extends Parent {}", ""].join("\n"),
      "use.ts": [
        'import { Child } from "./child";',
        "",
        "export function f(c: Child): number {",
        "  return c.run();",
        "}",
        "",
      ].join("\n"),
      "decoy.ts": ["export class Decoy {", "  run(): number {", "    return 0;", "  }", "}", ""].join("\n"),
    },
    use: { file: "use.ts", line: 4, token: "run" },
    declaration: { file: "parent.ts", line: 2, token: "run" },
    decoy: { file: "decoy.ts" },
    caller: "f",
  },
  {
    language: "Kotlin",
    files: {
      "a/Parent.kt": ["package a", "", "interface Parent {", "    fun run(): Int", "}", ""].join("\n"),
      "b/Child.kt": ["package b", "", "import a.Parent", "", "interface Child : Parent", ""].join("\n"),
      "c/Use.kt": [
        "package c",
        "",
        "import b.Child",
        "",
        "class Use {",
        "    fun f(c: Child): Int {",
        "        return c.run()",
        "    }",
        "}",
        "",
      ].join("\n"),
      "z/Decoy.kt": ["package z", "", "class Decoy {", "    fun run(): Int = 0", "}", ""].join("\n"),
    },
    use: { file: "c/Use.kt", line: 7, token: "run" },
    declaration: { file: "a/Parent.kt", line: 4, token: "run" },
    decoy: { file: "z/Decoy.kt" },
    caller: "f",
  },
];

async function withProject(
  fixture: InterfaceMemberFixture,
  run: (root: string, files: Record<string, string>) => Promise<void>,
): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-interface-member-"));
  try {
    await run(root, await writeFixtureFiles(root, fixture.files));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

const columnAt = (fixture: InterfaceMemberFixture, site: Site): number =>
  columnOf(fixture.files[site.file]!.split("\n"), site.line, site.token);

/** Go-to-definition and the detailed graph both reach the parent's member, never the same-named decoy. */
export async function expectInterfaceMemberGoto(fixture: InterfaceMemberFixture): Promise<void> {
  await withProject(fixture, async (root, files) => {
    const index = await buildProjectIndex(root, { cache: "off" });
    const result = await goToDefinition(index, {
      file: files[fixture.use.file]!,
      line: fixture.use.line,
      column: columnAt(fixture, fixture.use),
    });
    expect(result.status, fixture.language).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.definition.file, fixture.language).toBe(files[fixture.declaration.file]);
    expect(result.definition.range.start.line, fixture.language).toBe(fixture.declaration.line);
    const graph = await buildSymbolGraphDetailed(index);
    const calls = graph.edges
      .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === fixture.caller)
      .map((edge) => graph.nodes.get(edge.to)?.file);
    expect(calls, fixture.language).toEqual([files[fixture.declaration.file]]);
  });
}

/** References to the parent's member include the child-interface call, complete, and never reach the decoy. */
export async function expectInterfaceMemberReferences(fixture: InterfaceMemberFixture): Promise<void> {
  await withProject(fixture, async (root, files) => {
    const index = await buildProjectIndex(root, { cache: "off" });
    const refs = await findReferences(index, {
      file: files[fixture.declaration.file]!,
      line: fixture.declaration.line,
      column: columnAt(fixture, fixture.declaration),
    });
    if (refs.status !== "ok") throw new Error(`Expected ${fixture.language} references`);
    expect(refs.referenceCoverage, fixture.language).toEqual({ scope: "indexed_candidates", state: "complete" });
    const found = refs.references
      .map((reference) => `${path.relative(root, reference.file).replace(/\\/g, "/")}:${reference.range.start.line}`)
      .sort();
    expect(found, fixture.language).toEqual(
      [`${fixture.declaration.file}:${fixture.declaration.line}`, `${fixture.use.file}:${fixture.use.line}`].sort(),
    );
    expect(
      refs.references.some((reference) => reference.file === files[fixture.decoy.file]),
      fixture.language,
    ).toBe(false);
  });
}
