import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { buildSymbolGraphDetailed, findReferences, goToDefinition, type ProjectIndex } from "../../src/index.js";
import { normalizePath } from "../../src/util/paths.js";

export const CSHARP_GLOBAL_USING_FILES = {
  "App/App.csproj":
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><Compile Remove="Foreign/**/*.cs"/><Using Include="Project.Rendering"/><Using Include="Project.Helpers.ProjectTools" Static="true"/><Using Include="Project.Rendering.ProjectType" Alias="ProjectAlias"/></ItemGroup></Project>',
  "Directory.Build.props": '<Project><ItemGroup><Using Include="Props.Rendering"/></ItemGroup></Project>',
  "App/Properties/Usings.cs":
    "global using Lib.Rendering;\nglobal using static Lib.Helpers.Tools;\nglobal using A = Lib.Rendering.IRenderable;\n",
  "App/Rendering/Thing.cs": "namespace Lib.Rendering;\npublic interface IRenderable { void Render(); }\n",
  "App/Helpers/Tools.cs":
    "namespace Lib.Helpers;\npublic static class Tools { public static int Ping() => 1; public sealed class Token {} }\n",
  "App/ProjectTypes.cs":
    "namespace Project.Rendering { public sealed class ProjectType {} }\nnamespace Project.Helpers { public static class ProjectTools { public static int ProjectPing() => 2; } }\nnamespace Props.Rendering { public sealed class PropsType {} }\n",
  "App/Use.cs": [
    "namespace Lib;",
    "public sealed class Live : IRenderable {",
    "  private readonly IRenderable _target;",
    "  public Live(IRenderable target) { _target = target; }",
    "  public void Render() {}",
    "  public int Call() {",
    "    A alias = _target;",
    "    Token token = new();",
    "    ProjectAlias projectAlias = new();",
    "    ProjectType project = projectAlias;",
    "    PropsType props = new();",
    "    return Ping() + ProjectPing();",
    "  }",
    "}",
  ].join("\n"),
  "App/Shadow.cs":
    "namespace Lib.Local;\npublic sealed class IRenderable {}\npublic sealed class Shadow { private readonly IRenderable _target = new(); }\n",
  "App/Foreign/Foreign.csproj":
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
  "App/Foreign/Usings.cs": "global using Noise;\n",
  "App/Foreign/Decoy.cs":
    "namespace Noise;\npublic interface IRenderable {}\npublic static class Tools { public static int Ping() => -1; }\n",
  "App/Foreign/Shadow.cs":
    "namespace Lib { public class A {} }\nnamespace Lib.Rendering { public interface IRenderable {} }\nnamespace Lib.Helpers { public static class Tools { public static int Ping() => -1; } }\n",
} as const;

export type CsharpGlobalUsingFixture = { root: string; files: Record<string, string> };

export async function withCsharpGlobalUsingFixture(
  run: (fixture: CsharpGlobalUsingFixture) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-csharp-global-usings-"));
  try {
    const files: Record<string, string> = {};
    for (const [relative, source] of Object.entries(CSHARP_GLOBAL_USING_FILES)) {
      const file = path.join(root, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, source);
      files[relative] = normalizePath(file);
    }
    await run({ root, files });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function expectCsharpGlobalUsingNavigation(
  index: ProjectIndex,
  files: Record<string, string>,
): Promise<void> {
  const cases = [
    ["IRenderable", 3, "App/Rendering/Thing.cs"],
    ["A", 7, "App/Rendering/Thing.cs"],
    ["Token", 8, "App/Helpers/Tools.cs"],
    ["Ping", 12, "App/Helpers/Tools.cs"],
    ["ProjectAlias", 9, "App/ProjectTypes.cs"],
    ["ProjectType", 10, "App/ProjectTypes.cs"],
    ["ProjectPing", 12, "App/ProjectTypes.cs"],
    ["PropsType", 11, "App/ProjectTypes.cs"],
  ] as const;
  const lines = CSHARP_GLOBAL_USING_FILES["App/Use.cs"].split("\n");
  for (const [name, line, target] of cases) {
    const result = await goToDefinition(index, {
      file: files["App/Use.cs"]!,
      line,
      column: lines[line - 1]!.indexOf(name) + 1,
    });
    expect(result.status, `${name}:${line}`).toBe("ok");
    if (result.status !== "ok") throw new Error(`Expected global using ${name}: ${JSON.stringify(result)}`);
    expect(normalizePath(result.definition.file)).toBe(files[target]);
    expect(result.definition.file).not.toContain("Foreign");
  }
  const shadowLine = CSHARP_GLOBAL_USING_FILES["App/Shadow.cs"].split("\n")[2]!;
  const shadow = await goToDefinition(index, {
    file: files["App/Shadow.cs"]!,
    line: 3,
    column: shadowLine.indexOf("IRenderable") + 1,
  });
  expect(shadow.status).toBe("ok");
  if (shadow.status !== "ok") throw new Error("Expected nearer namespace declaration");
  expect(normalizePath(shadow.definition.file)).toBe(files["App/Shadow.cs"]);
  expect(normalizePath(shadow.definition.file)).not.toBe(files["App/Rendering/Thing.cs"]);
}

export async function expectCsharpGlobalUsingReferences(
  index: ProjectIndex,
  files: Record<string, string>,
): Promise<void> {
  const result = await findReferences(index, { file: files["App/Rendering/Thing.cs"]!, line: 2, column: 18 });
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("Expected global using references");
  const uses = result.references.filter((ref) => normalizePath(ref.file) === files["App/Use.cs"]);
  expect(uses.map((ref) => ref.range.start.line).sort((left, right) => left - right)).toEqual([2, 3, 4, 7]);
  expect(result.references.some((ref) => normalizePath(ref.file) === files["App/Shadow.cs"])).toBe(false);
  expect(result.references.some((ref) => ref.file.includes("Foreign"))).toBe(false);
  expect(result.referenceCoverage.scope).toBe("indexed_candidates");
  const decoy = await findReferences(index, { file: files["App/Foreign/Decoy.cs"]!, line: 2, column: 18 });
  expect(decoy.status).toBe("ok");
  if (decoy.status !== "ok") throw new Error("Expected decoy references");
  expect(decoy.references.some((ref) => normalizePath(ref.file) === files["App/Use.cs"])).toBe(false);
  for (const [file, line, name, useLine] of [
    ["App/Helpers/Tools.cs", 2, "Ping", 12],
    ["App/ProjectTypes.cs", 2, "ProjectPing", 12],
    ["App/ProjectTypes.cs", 1, "ProjectType", 9],
  ] as const) {
    const sourceLine = CSHARP_GLOBAL_USING_FILES[file].split("\n")[line - 1]!;
    const references = await findReferences(index, { file: files[file]!, line, column: sourceLine.indexOf(name) + 1 });
    expect(references.status, name).toBe("ok");
    if (references.status !== "ok") throw new Error(`Expected ${name} references`);
    expect(
      references.references
        .filter((ref) => normalizePath(ref.file) === files["App/Use.cs"])
        .map((ref) => ref.range.start.line),
      name,
    ).toContain(useLine);
    expect(
      references.references.some((ref) => ref.file.includes("Foreign")),
      name,
    ).toBe(false);
  }
}

export async function expectCsharpGlobalUsingGraph(index: ProjectIndex, files: Record<string, string>): Promise<void> {
  const graph = await buildSymbolGraphDetailed(index);
  const edges = graph.edges.flatMap((edge) => {
    const from = graph.nodes.get(edge.from);
    const to = graph.nodes.get(edge.to);
    if (!from || !to || normalizePath(from.file) !== files["App/Use.cs"]) return [];
    return [`${edge.label} ${to.name}@${normalizePath(to.file)}`];
  });
  expect(edges).toContain(`calls Ping@${files["App/Helpers/Tools.cs"]}`);
  expect(edges).toContain(`calls ProjectPing@${files["App/ProjectTypes.cs"]}`);
  expect(edges).toContain(`uses IRenderable@${files["App/Rendering/Thing.cs"]}`);
  expect(edges.some((edge) => edge.includes("Foreign"))).toBe(false);
}
