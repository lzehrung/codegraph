import path from "node:path";
import { expect } from "vitest";
import { buildSymbolGraphDetailed } from "../../src/graphs/symbol-graph-detailed.js";
import { findReferences, goToDefinition, type ProjectIndex } from "../../src/index.js";
import {
  CSHARP_INHERITED_TYPE_LINES,
  CSHARP_INHERITED_TYPE_SITES,
  type CsharpInheritedAliasCase,
  type CsharpInheritedAliasCallCase,
  type CsharpInheritedTypeCase,
} from "./csharp-inherited-alias-fixture.js";

/** Project-relative fixture path to the absolute path `writeFixtureFiles` returned. */
type FixturePaths = Readonly<Record<string, string>>;

function columnOfToken(testCase: CsharpInheritedAliasCase, token: RegExp | string): number {
  const text = testCase.lines[testCase.line - 1]!;
  const at = typeof token === "string" ? text.indexOf(token) : text.search(token);
  if (at < 0) throw new Error(`${String(token)} not found on line ${testCase.line}: ${text}`);
  return at + 1;
}

/** The site of the `Run` token of the case's one call. */
export function inheritedAliasRunColumn(testCase: CsharpInheritedAliasCase): number {
  return columnOfToken(testCase, "Run");
}

/** Go-to-definition on `Run`: the alias target, the type of the member that hides the alias, or `not_found`. */
export async function expectInheritedAliasGoto(
  index: ProjectIndex,
  files: FixturePaths,
  testCase: CsharpInheritedAliasCase,
): Promise<void> {
  const result = await goToDefinition(index, {
    file: files["Use.cs"]!,
    line: testCase.line,
    column: inheritedAliasRunColumn(testCase),
  });
  const label = `${testCase.name}: goToDefinition(Run)`;
  if (testCase.outcome === "unresolved") {
    expect(result.status, label).toBe("not_found");
    return;
  }
  expect(result.status, label).toBe("ok");
  if (result.status !== "ok") return;
  expect(result.definition.file, label).toBe(files[testCase.outcome === "alias" ? "N.cs" : "Decoy.cs"]);
  expect(result.definition.localName, label).toBe("Run");
}

/** Go-to-definition on the alias-named receiver: the hiding member, `not_found` while a base is unproven, or the alias. */
export async function expectInheritedAliasName(
  index: ProjectIndex,
  files: FixturePaths,
  testCase: CsharpInheritedAliasCase,
): Promise<void> {
  if (testCase.outcome === "alias") return;
  const result = await goToDefinition(index, {
    file: files["Use.cs"]!,
    line: testCase.line,
    column: columnOfToken(testCase, new RegExp(`\\b${testCase.alias}\\b`)),
  });
  const label = `${testCase.name}: goToDefinition(${testCase.alias})`;
  if (!testCase.memberFile) {
    expect(result.status, label).toBe("not_found");
    return;
  }
  expect(result.status, label).toBe("ok");
  if (result.status === "ok") expect(result.definition.file, label).toBe(files[testCase.memberFile]);
}

/** The lines of `Use.cs` that `findReferences` lists for `Run` of one target file, and its coverage. */
async function runReferences(
  index: ProjectIndex,
  files: FixturePaths,
  testCase: CsharpInheritedAliasCase,
  target: "N.cs" | "Decoy.cs",
): Promise<{ lines: number[]; state: string }> {
  const refs = await findReferences(index, {
    file: files[target]!,
    line: 1,
    column: testCase.files[target]!.indexOf("Run") + 1,
  });
  expect(refs.status, `${testCase.name}: findReferences(${target})`).toBe("ok");
  if (refs.status !== "ok") return { lines: [], state: refs.status };
  const lines = refs.references
    .filter((site) => site.file === files["Use.cs"])
    .map((site) => site.range.start.line)
    .sort((left, right) => left - right);
  return { lines, state: refs.referenceCoverage.state };
}

/**
 * References of the alias target's `Run` and of the decoy's `Run`. The use is listed only where it resolves, and a use
 * that cannot be placed keeps coverage partial instead of claiming the alias target was fully checked.
 */
export async function expectInheritedAliasReferences(
  index: ProjectIndex,
  files: FixturePaths,
  testCase: CsharpInheritedAliasCase,
): Promise<void> {
  const aliasTarget = await runReferences(index, files, testCase, "N.cs");
  const decoy = await runReferences(index, files, testCase, "Decoy.cs");
  const label = testCase.name;
  const only = [testCase.line];
  if (testCase.outcome === "alias") {
    expect(aliasTarget, `${label}: references of N.Target.Run`).toEqual({ lines: only, state: "complete" });
    expect(decoy, `${label}: references of Decoy.Target.Run`).toEqual({ lines: [], state: "complete" });
  } else if (testCase.outcome === "member") {
    expect(aliasTarget, `${label}: references of N.Target.Run`).toEqual({ lines: [], state: "complete" });
    expect(decoy, `${label}: references of Decoy.Target.Run`).toEqual({ lines: only, state: "complete" });
  } else {
    expect(aliasTarget, `${label}: references of N.Target.Run`).toEqual({ lines: [], state: "partial" });
    expect(decoy.lines, `${label}: references of Decoy.Target.Run`).toEqual([]);
  }
}

/** The `calls` and `uses` edges from `Use.cs` to either target, as `label file::name`. */
export async function inheritedAliasEdges(
  index: ProjectIndex,
  files: FixturePaths,
  fromFile: string = files["Use.cs"]!,
): Promise<string[]> {
  const graph = await buildSymbolGraphDetailed(index);
  return graph.edges
    .flatMap((edge) => {
      const from = graph.nodes.get(edge.from);
      const to = graph.nodes.get(edge.to);
      if (from?.file !== fromFile || !to) return [];
      if (to.file !== files["N.cs"] && to.file !== files["Decoy.cs"]) return [];
      if (edge.label !== "calls" && edge.label !== "uses") return [];
      return [`${edge.label} ${path.basename(to.file)}::${to.name}`];
    })
    .sort();
}

/** Detailed-graph edges: the alias target's call and type use, the member type's call, or neither. */
export async function expectInheritedAliasEdges(
  index: ProjectIndex,
  files: FixturePaths,
  testCase: CsharpInheritedAliasCase,
): Promise<void> {
  const edges = await inheritedAliasEdges(index, files);
  const label = `${testCase.name}: detailed graph edges ${JSON.stringify(edges)}`;
  if (testCase.outcome === "alias") {
    expect(edges, label).toContain("calls N.cs::Run");
    expect(
      edges.filter((edge) => edge.includes("Decoy.cs")),
      label,
    ).toEqual([]);
  } else if (testCase.outcome === "member") {
    expect(edges, label).toEqual(["calls Decoy.cs::Run"]);
  } else {
    expect(edges, label).toEqual([]);
  }
}

/** Every consumer of one case against one built index. */
export async function expectInheritedAliasConsumers(
  index: ProjectIndex,
  files: FixturePaths,
  testCase: CsharpInheritedAliasCase,
): Promise<void> {
  await expectInheritedAliasGoto(index, files, testCase);
  await expectInheritedAliasName(index, files, testCase);
  await expectInheritedAliasReferences(index, files, testCase);
  await expectInheritedAliasEdges(index, files, testCase);
}

/** Type positions and `nameof` agree through navigation, references, and detailed type-use/construction edges. */
export async function expectInheritedTypeConsumers(
  index: ProjectIndex,
  files: FixturePaths,
  testCase: CsharpInheritedTypeCase,
): Promise<void> {
  const label = testCase.name;
  const expectedFile = testCase.outcome === "alias" ? files["N.cs"] : files["Base.cs"];
  const expectedName = testCase.outcome === "alias" ? "Target" : "A";
  for (const line of CSHARP_INHERITED_TYPE_SITES) {
    const result = await goToDefinition(index, {
      file: files["Use.cs"]!,
      line,
      column: CSHARP_INHERITED_TYPE_LINES[line - 1]!.indexOf("A") + 1,
    });
    if (testCase.outcome === "unresolved") {
      expect(result.status, `${label}: type line ${line}`).toBe("not_found");
    } else {
      expect(result.status, `${label}: type line ${line}`).toBe("ok");
      if (result.status === "ok") {
        expect(result.definition.file, label).toBe(expectedFile);
        expect(result.definition.localName, label).toBe(expectedName);
      }
    }
  }
  if (testCase.outcome !== "unresolved") {
    const nameOf = await goToDefinition(index, {
      file: files["Use.cs"]!,
      line: 15,
      column: CSHARP_INHERITED_TYPE_LINES[14].indexOf("A") + 1,
    });
    expect(nameOf.status, `${label}: nameof`).toBe("ok");
    if (nameOf.status === "ok") expect(nameOf.definition.file, label).toBe(files["Base.cs"]);
  }
  for (const target of ["N.cs", "Base.cs"] as const) {
    if (target === "Base.cs" && testCase.outcome === "unresolved") continue;
    const line = target === "N.cs" ? 1 : 2;
    const sourceLine = testCase.files[target]!.split("\n")[line - 1]!;
    const token = target === "N.cs" ? "Target" : "A";
    const refs = await findReferences(index, {
      file: files[target]!,
      line,
      column: sourceLine.indexOf(token === "A" ? " A" : token) + (token === "A" ? 2 : 1),
    });
    expect(refs.status, `${label}: ${target} references`).toBe("ok");
    if (refs.status !== "ok") continue;
    const typeLines = refs.references
      .filter(
        (site) =>
          site.file === files["Use.cs"] && CSHARP_INHERITED_TYPE_SITES.some((line) => line === site.range.start.line),
      )
      .map((site) => site.range.start.line);
    const ownsTypes = testCase.outcome !== "unresolved" && files[target] === expectedFile;
    expect(typeLines, `${label}: ${target} type references`).toEqual(ownsTypes ? [...CSHARP_INHERITED_TYPE_SITES] : []);
    expect(refs.referenceCoverage.state, label).toBe(testCase.outcome === "unresolved" ? "partial" : "complete");
  }
  const graph = await buildSymbolGraphDetailed(index);
  const typeEdges = graph.edges.flatMap((edge) => {
    const from = graph.nodes.get(edge.from);
    const to = graph.nodes.get(edge.to);
    if (from?.file !== files["Use.cs"] || !to || (to.name !== "Target" && to.name !== "A")) return [];
    if (edge.label !== "uses" && edge.label !== "instantiates") return [];
    return [{ label: edge.label, caller: from.name, file: to.file, name: to.name }];
  });
  if (testCase.outcome === "unresolved") {
    expect(typeEdges, label).toEqual([]);
  } else {
    expect(typeEdges, label).toEqual(
      expect.arrayContaining([
        { label: "uses", caller: "Create", file: expectedFile, name: expectedName },
        { label: "uses", caller: "Types", file: expectedFile, name: expectedName },
        { label: "instantiates", caller: "Types", file: expectedFile, name: expectedName },
      ]),
    );
    expect(
      typeEdges.filter((edge) => edge.file !== expectedFile),
      label,
    ).toEqual([]);
  }
}

/** Bare calls use the same inherited overload target in navigation, references, and graph edges. */
export async function expectInheritedAliasCallConsumers(
  index: ProjectIndex,
  files: FixturePaths,
  testCase: CsharpInheritedAliasCallCase,
): Promise<void> {
  const label = testCase.name;
  const useLine = testCase.files["Use.cs"]!.split("\n")[1]!;
  const result = await goToDefinition(index, {
    file: files["Use.cs"]!,
    line: 2,
    column: useLine.indexOf("A(") + 1,
  });
  expect(result.status, label).toBe(testCase.outcome === "base" ? "ok" : "not_found");
  if (result.status === "ok") {
    expect(result.definition.file, label).toBe(files["Base.cs"]);
    expect(result.definition.localName, label).toBe("A");
  }
  for (const target of ["Base.cs", "Mid.cs"] as const) {
    const sourceLine = testCase.files[target]!.split("\n")[1]!;
    const refs = await findReferences(index, {
      file: files[target]!,
      line: 2,
      column: sourceLine.indexOf("A(") + 1,
    });
    expect(refs.status, label).toBe("ok");
    if (refs.status !== "ok") continue;
    const calls = refs.references.filter((site) => site.file === files["Use.cs"]).map((site) => site.range.start.line);
    expect(calls, `${label}: ${target} references`).toEqual(
      testCase.outcome === "base" && target === "Base.cs" ? [2] : [],
    );
    expect(refs.referenceCoverage.state, `${label}: ${target} coverage`).toBe(
      testCase.outcome === "base" ? "complete" : "partial",
    );
  }
  const graph = await buildSymbolGraphDetailed(index);
  const calls = graph.edges.flatMap((edge) => {
    const from = graph.nodes.get(edge.from);
    const to = graph.nodes.get(edge.to);
    if (edge.label !== "calls" || from?.file !== files["Use.cs"] || from.name !== "F" || !to) return [];
    return [`${path.basename(to.file)}::${to.name}`];
  });
  expect(calls, label).toEqual(testCase.outcome === "base" ? ["Base.cs::A"] : []);
}
