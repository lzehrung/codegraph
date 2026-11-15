import { expect } from "vitest";
import { buildSymbolGraphDetailed, findReferences, goToDefinition, type ProjectIndex } from "../../src/index.js";
import { defNodeId } from "../../src/graphs/symbol-graph.js";
import { columnOf } from "../languages/callable-consumer-fixtures.js";

const models = [
  "enum ColorMode { case warm; case cool }",
  "enum OtherMode { case warm; case cool }",
  "struct Labelled {",
  '  func send(to value: String) -> String { "to" }',
  '  func send(_ value: String) -> String { "unlabeled" }',
  "}",
];
const uses = [
  "func invoke(_ value: Labelled) -> String {",
  "  let selected: ColorMode = .warm",
  '  let first = value.send(to: "x")',
  '  let second = value.send("x")',
  '  return first + second + (selected == .warm ? "warm" : "cool")',
  "}",
];
export const SWIFT_ACCURACY_SOURCES = {
  "Models.swift": `${models.join("\n")}\n`,
  "Use.swift": `${uses.join("\n")}\n`,
};

function site(paths: Record<string, string>, file: "Models.swift" | "Use.swift", line: number, token: string) {
  return { file: paths[file]!, line, column: columnOf(file === "Models.swift" ? models : uses, line, token) };
}

export async function expectSwiftAccuracyGoto(index: ProjectIndex, paths: Record<string, string>): Promise<void> {
  for (const [use, declaration] of [
    [site(paths, "Use.swift", 2, "warm"), site(paths, "Models.swift", 1, "warm")],
    [site(paths, "Use.swift", 3, "send"), site(paths, "Models.swift", 4, "send")],
    [site(paths, "Use.swift", 4, "send"), site(paths, "Models.swift", 5, "send")],
  ] as const) {
    const result = await goToDefinition(index, use);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") continue;
    expect([result.definition.file, result.definition.range.start.line, result.definition.range.start.column]).toEqual([
      declaration.file,
      declaration.line,
      declaration.column,
    ]);
  }
}

export async function expectSwiftAccuracyReferences(index: ProjectIndex, paths: Record<string, string>): Promise<void> {
  for (const [declaration, use] of [
    [site(paths, "Models.swift", 4, "send"), site(paths, "Use.swift", 3, "send")],
    [site(paths, "Models.swift", 5, "send"), site(paths, "Use.swift", 4, "send")],
  ] as const) {
    const refs = await findReferences(index, declaration);
    expect(refs.status).toBe("ok");
    if (refs.status !== "ok") continue;
    expect(refs.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
    const key = (item: { file: string; line: number; column: number }) => `${item.file}:${item.line}:${item.column}`;
    expect(
      refs.references
        .map((ref) => key({ file: ref.file, line: ref.range.start.line, column: ref.range.start.column }))
        .sort(),
    ).toEqual([declaration, use].map(key).sort());
  }
}

export async function expectSwiftAccuracyGraph(index: ProjectIndex, paths: Record<string, string>): Promise<void> {
  const graph = await buildSymbolGraphDetailed(index);
  const caller = [...graph.nodes.values()].find((node) => node.file === paths["Use.swift"] && node.name === "invoke");
  expect(caller).toBeDefined();
  for (const line of [3, 4]) {
    const target = await goToDefinition(index, site(paths, "Use.swift", line, "send"));
    expect(target.status).toBe("ok");
    if (target.status !== "ok") continue;
    expect(
      graph.edges.some(
        (edge) => edge.from === caller!.id && edge.label === "calls" && edge.to === defNodeId(target.definition),
      ),
    ).toBe(true);
  }
}

const requirementModels = [
  "protocol Named { var title: String { get } }",
  "struct Item: Named { var title: String }",
  "struct Other { var title: String }",
];
const requirementUses = [
  "func read(_ named: Named, _ item: Item, _ other: Other) {",
  "  _ = named.title",
  "  _ = item.title",
  "  _ = other.title",
  "}",
];
export const SWIFT_REQUIREMENT_SOURCES = {
  "Named.swift": `${requirementModels.join("\n")}\n`,
  "Read.swift": `${requirementUses.join("\n")}\n`,
};

function requirementSite(paths: Record<string, string>, file: "Named.swift" | "Read.swift", line: number) {
  const lines = file === "Named.swift" ? requirementModels : requirementUses;
  return { file: paths[file]!, line, column: columnOf(lines, line, "title") };
}

/** A use through the protocol names the requirement, a use through a type names its own property, never the decoy's. */
export async function expectSwiftRequirementGoto(index: ProjectIndex, paths: Record<string, string>): Promise<void> {
  for (const [use, declaration] of [
    [requirementSite(paths, "Read.swift", 2), requirementSite(paths, "Named.swift", 1)],
    [requirementSite(paths, "Read.swift", 3), requirementSite(paths, "Named.swift", 2)],
    [requirementSite(paths, "Read.swift", 4), requirementSite(paths, "Named.swift", 3)],
  ] as const) {
    const result = await goToDefinition(index, use);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") continue;
    expect([result.definition.file, result.definition.range.start.line, result.definition.range.start.column]).toEqual([
      declaration.file,
      declaration.line,
      declaration.column,
    ]);
  }
}

/** The requirement lists its protocol-typed use, each property its own use, and the decoy's use stays with the decoy. */
export async function expectSwiftRequirementReferences(
  index: ProjectIndex,
  paths: Record<string, string>,
): Promise<void> {
  for (const [declaration, use] of [
    [requirementSite(paths, "Named.swift", 1), requirementSite(paths, "Read.swift", 2)],
    [requirementSite(paths, "Named.swift", 2), requirementSite(paths, "Read.swift", 3)],
    [requirementSite(paths, "Named.swift", 3), requirementSite(paths, "Read.swift", 4)],
  ] as const) {
    const refs = await findReferences(index, declaration);
    expect(refs.status).toBe("ok");
    if (refs.status !== "ok") continue;
    expect(refs.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
    const key = (item: { file: string; line: number; column: number }) => `${item.file}:${item.line}:${item.column}`;
    expect(
      refs.references
        .map((ref) => key({ file: ref.file, line: ref.range.start.line, column: ref.range.start.column }))
        .sort(),
    ).toEqual([declaration, use].map(key).sort());
  }
}
