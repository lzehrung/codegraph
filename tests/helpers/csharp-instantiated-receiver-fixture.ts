import { expect } from "vitest";
import { buildSymbolGraphDetailed, findReferences, goToDefinition, type ProjectIndex } from "../../src/index.js";
import { columnOf } from "../languages/callable-consumer-fixtures.js";
import { defNodeId } from "../../src/graphs/symbol-graph.js";
import { fileIdentityKey } from "../../src/util/paths.js";

export const CSHARP_INSTANTIATED_RECEIVER_SCOPES = ["peer", "using", "same-file", "qualified", "nested"] as const;
type ReceiverScope = (typeof CSHARP_INSTANTIATED_RECEIVER_SCOPES)[number];

export type CsharpInstantiatedReceiverFixture = {
  files: Record<string, string>;
  lines: string[];
  sites: { line: number; caller: string; target: string }[];
  targets: { file: string; line: number; source: string }[];
};

export function csharpInstantiatedReceiverFixture(scope: ReceiverScope): CsharpInstantiatedReceiverFixture {
  const declarations = {
    "Prompt.cs":
      "public class Prompt<T> { public Prompt() {} public int PageSize { get; set; } public int Count() => 1; }",
    "Pair.cs":
      "public class Prompt<T, U> { public Prompt() {} public int PageSize { get; set; } public int Count() => 2; }",
    "Plain.cs": "public class Prompt { public Prompt() {} public int PageSize { get; set; } public int Count() => 0; }",
  };
  let prefix = "";
  if (scope === "qualified") prefix = "Models.";
  if (scope === "nested") prefix = "Outer.";
  const colocated = scope === "same-file" || scope === "nested";
  const lines: string[] = [];
  if (scope === "using") lines.push("using Models;");
  lines.push(scope === "using" || scope === "qualified" ? "namespace Client;" : "namespace Models;");
  if (scope === "nested") lines.push("public class Outer {");
  const targets = Object.entries(declarations).map(([file, source]) => {
    if (!colocated) return { file, line: 2, source };
    lines.push(source);
    return { file: "Use.cs", line: lines.length, source };
  });
  if (scope === "nested") lines.push("}");
  lines.push("public class Use {");
  const methods = [
    ["Open<T>", `${prefix}Prompt<T>`, "Prompt.cs"],
    ["Closed", `${prefix}Prompt<int>`, "Prompt.cs"],
    ["Nested", `${prefix}Prompt<${prefix}Prompt<int>>`, "Prompt.cs"],
    ["Pair", `${prefix}Prompt<int, string>`, "Pair.cs"],
    ["Plain", `${prefix}Prompt`, "Plain.cs"],
  ] as const;
  const sites = methods.map(([method, type, target]) => {
    lines.push(`  public int ${method}(${type} obj) { obj.PageSize = 3; return obj.Count() + obj.PageSize; }`);
    return { line: lines.length, caller: method.split("<")[0]!, target };
  });
  for (const [method, declaration] of [
    ["Declared", `${prefix}Prompt<int> obj = new ${prefix}Prompt<int>();`],
    ["Constructed", `var obj = new ${prefix}Prompt<${prefix}Prompt<int>>();`],
  ] as const) {
    lines.push(`  public int ${method}() { ${declaration} obj.PageSize = 3; return obj.Count() + obj.PageSize; }`);
    sites.push({ line: lines.length, caller: method, target: "Prompt.cs" });
  }
  lines.push("}", "");
  const files: Record<string, string> = { "Use.cs": lines.join("\n") };
  if (!colocated) {
    for (const [file, source] of Object.entries(declarations)) files[file] = `namespace Models;\n${source}\n`;
  }
  return { files, lines, sites, targets };
}

type Paths = Readonly<Record<string, string>>;

export async function expectInstantiatedReceiverGoto(
  index: ProjectIndex,
  files: Paths,
  fixture: CsharpInstantiatedReceiverFixture,
) {
  for (const site of fixture.sites) {
    const target = fixture.targets[targetIndex(site.target)]!;
    for (const token of ["Count", "PageSize"] as const) {
      const line = fixture.lines[site.line - 1]!;
      for (const match of line.matchAll(new RegExp(`\\b${token}\\b`, "gu"))) {
        const result = await goToDefinition(index, {
          file: files["Use.cs"]!,
          line: site.line,
          column: match.index + 1,
        });
        expect(result.status, `${site.caller}: ${token}`).toBe("ok");
        if (result.status !== "ok") continue;
        expect(result.definition.file).toBe(files[target.file]);
        expect(result.definition.range.start.line).toBe(target.line);
        expect(result.definition.range.start.column).toBe(target.source.indexOf(token) + 1);
      }
    }
    const type = await goToDefinition(index, {
      file: files["Use.cs"]!,
      line: site.line,
      column: columnOf(fixture.lines, site.line, "Prompt"),
    });
    expect(type.status, `${site.caller}: generic type name`).toBe("ok");
    if (type.status === "ok") {
      expect(type.definition.file).toBe(files[target.file]);
      expect(type.definition.range.start.line).toBe(target.line);
    }
  }
}

function targetIndex(file: string): number {
  return ["Prompt.cs", "Pair.cs", "Plain.cs"].indexOf(file);
}

export async function expectInstantiatedReceiverReferences(
  index: ProjectIndex,
  files: Paths,
  fixture: CsharpInstantiatedReceiverFixture,
) {
  for (const [targetNumber, target] of fixture.targets.entries()) {
    const typeRefs = await findReferences(index, {
      file: files[target.file]!,
      line: target.line,
      column: target.source.indexOf("Prompt") + 1,
    });
    expect(typeRefs.status).toBe("ok");
    if (typeRefs.status === "ok") {
      const constructorColumn = target.source.indexOf("Prompt()") + 1;
      expect(
        typeRefs.references.some(
          (ref) =>
            ref.file === files[target.file] &&
            ref.range.start.line === target.line &&
            ref.range.start.column === constructorColumn,
        ),
      ).toBe(true);
    }
    for (const token of ["Count", "PageSize"] as const) {
      const refs = await findReferences(index, {
        file: files[target.file]!,
        line: target.line,
        column: target.source.indexOf(token) + 1,
      });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") continue;
      const expected = fixture.sites.flatMap((site) => {
        if (targetIndex(site.target) !== targetNumber) return [];
        return [...fixture.lines[site.line - 1]!.matchAll(new RegExp(`\\b${token}\\b`, "gu"))].map(
          (match) => `${site.line}:${match.index + 1}`,
        );
      });
      const actual = refs.references
        .filter(
          (ref) => ref.file === files["Use.cs"] && fixture.sites.some((site) => site.line === ref.range.start.line),
        )
        .map((ref) => `${ref.range.start.line}:${ref.range.start.column}`);
      expect(actual.sort()).toEqual(expected.sort());
      expect(refs.referenceCoverage.state).toBe("complete");
    }
  }
}

export async function expectInstantiatedReceiverEdges(
  index: ProjectIndex,
  files: Paths,
  fixture: CsharpInstantiatedReceiverFixture,
) {
  const graph = await buildSymbolGraphDetailed(index);
  const actual = graph.edges.flatMap((edge) => {
    const from = graph.nodes.get(edge.from);
    const to = graph.nodes.get(edge.to);
    if (edge.label !== "calls" || from?.file !== files["Use.cs"] || to?.name !== "Count") return [];
    const site = fixture.sites.find((candidate) => candidate.caller === from.name);
    expect(site).toBeDefined();
    const target = fixture.targets[targetIndex(site!.target)]!;
    expect(to.file).toBe(files[target.file]);
    const definition = index.byFile
      .get(fileIdentityKey(files[target.file]!))
      ?.locals.find(
        (def) =>
          def.localName === "Count" &&
          def.range.start.line === target.line &&
          def.range.start.column === target.source.indexOf("Count") + 1,
      );
    expect(definition).toBeDefined();
    expect(edge.to).toBe(defNodeId(definition!));
    return [from.name];
  });
  expect(actual.sort()).toEqual(fixture.sites.map((site) => site.caller).sort());
}

export async function expectInstantiatedReceiverConsumers(
  index: ProjectIndex,
  files: Paths,
  fixture: CsharpInstantiatedReceiverFixture,
) {
  for (const module of index.byFile.values()) {
    expect(module.nativeOutcome).toBe("used");
    expect(module.parseErrorRanges).toEqual([]);
  }
  await expectInstantiatedReceiverGoto(index, files, fixture);
  await expectInstantiatedReceiverReferences(index, files, fixture);
  await expectInstantiatedReceiverEdges(index, files, fixture);
}
