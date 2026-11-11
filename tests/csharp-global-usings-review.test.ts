import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  buildSymbolGraphDetailed,
  findReferences,
  goToDefinition,
  listSymbols,
  resolveSymbolId,
  type ProjectIndex,
} from "../src/index.js";
import { clearMemoryCache } from "../src/indexer/build-cache.js";
import { findImplementations, findTypeHierarchy } from "../src/indexer/type-hierarchy.js";
import { createAgentSession } from "../src/agent/session.js";
import { previewRenameInSnapshot } from "../src/agent/rename-preview.js";
import { workspaceSymbolsInSnapshot } from "../src/agent/workspace-symbols.js";
import { fileIdentityKey } from "../src/util/paths.js";
import { createTempRootRegistry, isSymlinkUnavailable } from "./helpers/filesystem.js";

const roots = createTempRootRegistry();
afterEach(async () => {
  vi.restoreAllMocks();
  clearMemoryCache();
  await roots.cleanup();
});

async function project(sources: Record<string, string>) {
  const root = (await roots.create("cg-global-using-review-")).replace(/\\/g, "/");
  for (const [file, source] of Object.entries(sources)) {
    const target = path.join(root, file);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, source);
  }
  return root;
}
async function position(root: string, file: string, needle: string) {
  const lines = (await fsp.readFile(path.join(root, file), "utf8")).split(/\r?\n/u);
  const line = lines.findIndex((text) => text.includes(needle));
  if (line < 0) throw new Error(`Missing ${needle} in ${file}`);
  return { file: path.join(root, file).replace(/\\/g, "/"), line: line + 1, column: lines[line]!.indexOf(needle) + 1 };
}
async function target(index: ProjectIndex, root: string, file: string, needle: string) {
  const result = await goToDefinition(index, await position(root, file, needle));
  if (result.status !== "ok") return result.status;
  return `${path.relative(root, result.definition.file).replace(/\\/g, "/")}:${result.definition.range.start.line}`;
}
function definition(index: ProjectIndex, root: string, file: string, name: string) {
  const key = fileIdentityKey(path.join(root, file));
  const symbol = listSymbols(index).find((item) => item.name === name && fileIdentityKey(item.file) === key);
  const def = symbol && resolveSymbolId(index, symbol.id);
  if (!def) throw new Error(`Missing ${name} in ${file}`);
  return def;
}
async function references(index: ProjectIndex, root: string, file: string, name: string) {
  const result = await findReferences(index, { def: definition(index, root, file, name) });
  if (result.status !== "ok") throw new Error(`Missing references for ${name}`);
  return result;
}
function relativeFiles(root: string, refs: readonly { file: string }[]) {
  return refs.map((ref) => path.relative(root, ref.file).replace(/\\/g, "/"));
}
async function indexProject(root: string) {
  return await buildProjectIndex(root, { cache: "off", threads: 1 });
}

const LIBRARY = "namespace Lib;\npublic class Target {}\npublic static class Tools { public static int Run() => 1; }";

describe("C# global using review acceptance", () => {
  it.each(["using", "global using"])("binds a global-namespace static owner through %s", async (directive) => {
    const root = await project({
      "App.csproj": "<Project/>",
      "Tools.cs": "public static class Tools { public static int Run() => 1; }",
      "Decoy.cs": "namespace Other; public static class Tools { public static int Run() => 2; }",
      "Use.cs": `${directive} static Tools;\npublic class Use { public int Call() => Run(); }`,
    });
    const index = await indexProject(root);
    expect(await target(index, root, "Use.cs", "Run();")).toBe("Tools.cs:1");
    const refs = await references(index, root, "Tools.cs", "Run");
    expect(refs.referenceCoverage.state).toBe("complete");
    expect(relativeFiles(root, refs.references)).toContain("Use.cs");
    expect(relativeFiles(root, (await references(index, root, "Decoy.cs", "Run")).references)).not.toContain("Use.cs");
    const graph = await buildSymbolGraphDetailed(index);
    expect(
      graph.edges.some(
        (edge) =>
          edge.label === "calls" &&
          graph.nodes.get(edge.from)?.name === "Call" &&
          graph.nodes.get(edge.to)?.file.endsWith("/Tools.cs"),
      ),
    ).toBe(true);
  });

  it("keeps namespace-block aliases, same-namespace peers, and redundant imports ahead of globals", async () => {
    const root = await project({
      "App.csproj": "<Project/>",
      "G.cs": "global using A = Left.Target;\nglobal using Lib;\nglobal using Lib;",
      "Left.cs": "namespace Left { public class Target { public int L; } }",
      "Right.cs": "namespace Right { public class Target { public int R; } }",
      "Lib.cs": "namespace Lib { public class Target {} public class OnlyLib {} }",
      "Peer.cs": "namespace App { public class Target { public int P; } }",
      "Use.cs":
        "using Lib;\nnamespace App {\nusing A = Right.Target;\npublic class Use {\npublic A a;\npublic Target t;\npublic OnlyLib o;\n}\n}",
    });
    const index = await indexProject(root);
    expect(await target(index, root, "Use.cs", "A a")).toBe("Right.cs:1");
    expect(await target(index, root, "Use.cs", "Target t")).toBe("Peer.cs:1");
    expect(await target(index, root, "Use.cs", "OnlyLib o")).toBe("Lib.cs:1");
    for (const file of ["Peer.cs", "Right.cs"]) {
      const refs = await references(index, root, file, "Target");
      expect(refs.referenceCoverage.state).toBe("complete");
      expect(relativeFiles(root, refs.references)).toContain("Use.cs");
    }
    for (const file of ["Left.cs", "Lib.cs"])
      expect(relativeFiles(root, (await references(index, root, file, "Target")).references)).not.toContain("Use.cs");
  });

  it("lets a namespace-block using beat a compilation-global namespace import", async () => {
    const root = await project({
      "G.cs": "global using Left;",
      "Left.cs": "namespace Left; public class Target {}",
      "Right.cs": "namespace Right; public class Target {}",
      "Use.cs": "namespace App { using Right; public class Use { public Target field; } }",
    });
    const index = await indexProject(root);
    expect(await target(index, root, "Use.cs", "Target field")).toBe("Right.cs:1");
    expect(relativeFiles(root, (await references(index, root, "Left.cs", "Target")).references)).not.toContain(
      "Use.cs",
    );
  });

  it("coalesces namespace and static directives across files, project items, and local usings", async () => {
    const root = await project({
      "App.csproj":
        '<Project><ItemGroup><Using Include="Lib"/><Using Include="Lib.Tools" Static="true"/></ItemGroup></Project>',
      "G1.cs": "global using Lib;\nglobal using static Lib.Tools;\nglobal using W = Lib.Widget;",
      "G2.cs": "global using Lib;\nglobal using static Lib.Tools;",
      "Lib.cs":
        "namespace Lib;\npublic class Widget { public static int Make() => 1; }\npublic static class Tools { public static int Run() => 1; }",
      "Use.cs":
        "using Lib;\nusing static Lib.Tools;\nnamespace App;\npublic class Use { public Widget w; public W x; public int F() => Run() + Widget.Make() + W.Make(); }",
    });
    const index = await indexProject(root);
    for (const needle of ["Widget w", "W x", "Run() +", "Make() +"])
      expect(await target(index, root, "Use.cs", needle)).toMatch(/^Lib\.cs:/u);
    for (const name of ["Widget", "Make", "Run"]) {
      const refs = await references(index, root, "Lib.cs", name);
      expect(refs.referenceCoverage.state).toBe("complete");
      expect(relativeFiles(root, refs.references)).toContain("Use.cs");
    }
  });

  it.each(["namespace", "alias", "static", "project"])("accepts global:: in a global %s import", async (form) => {
    const directives: Record<string, string> = {
      namespace: "global using global::Lib;",
      alias: "global using A = global::Lib.Target;",
      static: "global using static global::Lib.Tools;",
      project: "",
    };
    const typeName = form === "alias" ? "A" : "Target";
    const use = form === "static" ? "public int F() => Run();" : `public ${typeName} field;`;
    const root = await project({
      "App.csproj":
        form === "project" ? '<Project><ItemGroup><Using Include="global::Lib"/></ItemGroup></Project>' : "<Project/>",
      "G.cs": directives[form]!,
      "Lib.cs": LIBRARY,
      "Use.cs": `namespace App; public class Use { ${use} }`,
    });
    const index = await indexProject(root);
    const needle = form === "static" ? "Run();" : `${typeName} field`;
    expect(await target(index, root, "Use.cs", needle)).toMatch(/^Lib\.cs:/u);
  });

  it("imports every nominal type kind and distinguishes generic type arities", async () => {
    const declarations = [
      "public enum E { Value }",
      "public struct S {}",
      "public delegate void D();",
      "public record R;",
      "public record class RC;",
      "public record struct RS;",
      "public readonly record struct RRS;",
      "public interface I {}",
      "public abstract class AC {}",
      "public class Box {}",
      "public class Box<T> {}",
      "public class Box<T,U> {}",
    ];
    const types = ["E", "S", "D", "R", "RC", "RS", "RRS", "I", "AC", "Box", "Box<int>", "Box<int,string>"];
    const root = await project({
      "G.cs": "global using Lib;",
      "Types.cs": ["namespace Lib;", ...declarations].join("\n"),
      "Decoy.cs": "namespace Other; public class Box<T> {}",
      "Use.cs": [
        "namespace App; public class Use {",
        ...types.map((name, at) => `public ${name} field${at};`),
        "}",
      ].join("\n"),
    });
    const index = await indexProject(root);
    for (let at = 0; at < types.length; at += 1)
      expect(await target(index, root, "Use.cs", `${types[at]} field${at}`)).toBe(`Types.cs:${at + 2}`);
  });

  it.each([
    ["namespace", false],
    ["namespace", true],
    ["static", false],
    ["static", true],
  ] as const)("keeps %s ambiguity identical for local/global placement (%s)", async (form, global) => {
    const imports =
      form === "static" ? "using static Left.Target;\nusing static Right.Target;" : "using Left;\nusing Right;";
    const declaration =
      form === "static" ? "public static class Target { public static int Run() => 1; }" : "public class Target {}";
    const member = form === "static" ? "public int F() => Run();" : "public Target F() => new Target();";
    const root = await project({
      "G.cs": global ? imports.replaceAll("using ", "global using ") : "",
      "Left.cs": `namespace Left; ${declaration}`,
      "Right.cs": `namespace Right; ${declaration}`,
      "Use.cs": `${global ? "" : imports}\nnamespace App; public class Use { ${member} }`,
    });
    const index = await indexProject(root);
    const name = form === "static" ? "Run" : "Target";
    expect(await target(index, root, "Use.cs", form === "static" ? "Run();" : "Target F")).toBe("not_found");
    for (const file of ["Left.cs", "Right.cs"]) {
      const refs = await references(index, root, file, name);
      expect(refs.referenceCoverage.state).toBe("partial");
      expect(relativeFiles(root, refs.references)).not.toContain("Use.cs");
    }
    const graph = await buildSymbolGraphDetailed(index);
    const hasAmbiguousTypeEdge = graph.edges.some((edge) => {
      if (!edge.label) return false;
      if (!["calls", "uses", "instantiates"].includes(edge.label)) return false;
      if (!graph.nodes.get(edge.from)?.file.endsWith("/Use.cs")) return false;
      const target = graph.nodes.get(edge.to);
      return ["Left.cs", "Right.cs"].some((file) => target?.file.endsWith(`/${file}`));
    });
    expect(hasAmbiguousTypeEdge).toBe(false);
  });

  it("collects source globals under unevaluated preprocessor wrappers", async () => {
    const root = await project({
      "G.cs": "#if NEVER\nglobal using Lib;\n#endif",
      "Lib.cs": LIBRARY,
      "Use.cs": "namespace App; public class Use { public Target field; }",
    });
    expect(await target(await indexProject(root), root, "Use.cs", "Target field")).toBe("Lib.cs:2");
  });

  it.each(["type alias", "namespace alias", "static"])("honors SDK child metadata for a %s", async (form) => {
    const include = form === "type alias" ? "Lib.Target" : "Lib";
    const item =
      form === "static"
        ? '<Using Include="Lib.Tools"><Static>true</Static></Using>'
        : `<Using Include="${include}"><Alias>A</Alias></Using>`;
    const typeName = form === "namespace alias" ? "A.Target" : "A";
    const member = form === "static" ? "public int F() => Run();" : `public ${typeName} field; public Target excluded;`;
    const root = await project({
      "App.csproj": `<Project><ItemGroup>${item}</ItemGroup></Project>`,
      "Lib.cs": LIBRARY,
      "Use.cs": `namespace App; public class Use { ${member} }`,
    });
    const index = await indexProject(root);
    const needle = form === "static" ? "Run();" : `${typeName} field`;
    expect(await target(index, root, "Use.cs", needle)).toMatch(/^Lib\.cs:/u);
    if (form !== "static") expect(await target(index, root, "Use.cs", "Target excluded")).toBe("not_found");
  });

  it("uses only the nearest props file, inherited by nested projects", async () => {
    const sources: Record<string, string> = {
      "Directory.Build.props": '<Project><ItemGroup><Using Include="Props.Root"/></ItemGroup></Project>',
      "Parent/Directory.Build.props": '<Project><ItemGroup><Using Include="Props.Parent"/></ItemGroup></Project>',
    };
    for (const folder of ["Parent", "Parent/Nested", "Other"]) {
      sources[`${folder}/App.csproj`] =
        '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Using Include="Own.Project"/></ItemGroup></Project>';
      sources[`${folder}/Decl.cs`] =
        "namespace Props.Root { public class RootType {} } namespace Props.Parent { public class ParentType {} } namespace Own.Project { public class OwnType {} }";
      sources[`${folder}/Use.cs`] =
        "namespace App; public class Use { public RootType root; public ParentType parent; public OwnType own; }";
    }
    const root = await project(sources);
    const index = await indexProject(root);
    for (const folder of ["Parent", "Parent/Nested", "Other"]) {
      expect(await target(index, root, `${folder}/Use.cs`, "OwnType own")).toBe(`${folder}/Decl.cs:1`);
      expect(await target(index, root, `${folder}/Use.cs`, "ParentType parent")).toBe(
        folder === "Other" ? "not_found" : `${folder}/Decl.cs:1`,
      );
      expect(await target(index, root, `${folder}/Use.cs`, "RootType root")).toBe(
        folder === "Other" ? `${folder}/Decl.cs:1` : "not_found",
      );
    }
  });

  it.each([
    { items: '<Using Remove="Lib"/><Using Include="Lib"/>', present: true, alias: false },
    { items: '<Using Include="Lib"/><Using Remove="Lib"/><Using Include="Lib"/>', present: true, alias: false },
    { items: '<Using Include="Lib"/><Using Remove="Lib"/>', present: false, alias: false },
    { items: '<Using Include="Lib.Target" Alias="A"/><Using Remove="Lib.Target"/>', present: false, alias: true },
  ])("applies item identity and source order: $items", async ({ items, present, alias }) => {
    const root = await project({
      "App.csproj": `<Project><ItemGroup>${items}</ItemGroup></Project>`,
      "Lib.cs": LIBRARY,
      "Use.cs": `namespace App; public class Use { public ${alias ? "A" : "Target"} field; }`,
    });
    const index = await indexProject(root);
    expect(await target(index, root, "Use.cs", `${alias ? "A" : "Target"} field`)).toBe(
      present ? "Lib.cs:2" : "not_found",
    );
    expect(relativeFiles(root, (await references(index, root, "Lib.cs", "Target")).references).includes("Use.cs")).toBe(
      present,
    );
  });

  it.each([
    '<ItemGroup><Using Include="Lib" Condition="false"/></ItemGroup>',
    '<ItemGroup Condition="true"><Using Include="Lib"/></ItemGroup>',
    '<ItemGroup><Using Include="$(RootNs)"/></ItemGroup>',
    '<ItemGroup><Using Include="@(List)"/></ItemGroup>',
    '<Target Name="Build"><ItemGroup><Using Include="Lib"/></ItemGroup></Target>',
    '<Choose><When Condition="true"><ItemGroup><Using Include="Lib"/></ItemGroup></When></Choose>',
  ])("does not invent an unconditional import from %s", async (unsupported) => {
    const root = await project({
      "App.csproj": `<Project>${unsupported}<ItemGroup><Using Include="Known"/></ItemGroup></Project>`,
      "Lib.cs": LIBRARY,
      "Known.cs": "namespace Known; public class Control {}",
      "Use.cs": "namespace App; public class Use { public Target missing; public Control control; }",
    });
    const index = await indexProject(root);
    expect(await target(index, root, "Use.cs", "Target missing")).toBe("not_found");
    expect(await target(index, root, "Use.cs", "Control control")).toBe("Known.cs:1");
    const refs = await references(index, root, "Lib.cs", "Target");
    expect(refs.referenceCoverage.state).toBe("complete");
    expect(relativeFiles(root, refs.references)).not.toContain("Use.cs");
  });

  it.each(["", "App/"])(
    "keeps nested project declarations out of explicit project alias shadowing at %s",
    async (prefix) => {
      const root = await project({
        [`${prefix}Root.csproj`]: "<Project/>",
        [`${prefix}Usings.cs`]: "global using A = Lib.T;\nglobal using Models = Lib.Models;",
        [`${prefix}Lib.cs`]: "namespace Lib { public class T {} } namespace Lib.Models { public class M {} }",
        [`${prefix}Use.cs`]: "namespace App { public class Use { public A a; public Models.M m; } }",
        [`${prefix}Nested/Nested.csproj`]: "<Project/>",
        [`${prefix}Nested/Shadow.cs`]:
          "namespace App { public class A {} } namespace App.Models { public class M2 {} }",
      });
      const index = await indexProject(root);
      expect(await target(index, root, `${prefix}Use.cs`, "A a")).toBe(`${prefix}Lib.cs:1`);
      expect(await target(index, root, `${prefix}Use.cs`, "M m")).toBe(`${prefix}Lib.cs:1`);
      expect(
        relativeFiles(root, (await references(index, root, `${prefix}Nested/Shadow.cs`, "A")).references),
      ).not.toContain(`${prefix}Use.cs`);
    },
  );

  it("keeps an implicit parent compilation and a nested project separate in both directions", async () => {
    const root = await project({
      "G.cs": "global using N;",
      "N.cs": "namespace N; public class RootType {}",
      "Loose.cs": "public class Loose { public RootType root; public InnerType inner; }",
      "App/App.csproj": "<Project/>",
      "App/G.cs": "global using Inner;",
      "App/Inner.cs": "namespace Inner; public class InnerType {}",
      "App/Use.cs": "public class Use { public RootType root; public InnerType inner; }",
    });
    const index = await indexProject(root);
    expect(await target(index, root, "Loose.cs", "RootType root")).toBe("N.cs:1");
    expect(await target(index, root, "Loose.cs", "InnerType inner")).toBe("not_found");
    expect(await target(index, root, "App/Use.cs", "RootType root")).toBe("not_found");
    expect(await target(index, root, "App/Use.cs", "InnerType inner")).toBe("App/Inner.cs:1");
  });

  it.each(["memory", "disk"] as const)("refreshes bare project additions/removals with %s cache", async (cache) => {
    const root = await project({
      "A/N.cs": "namespace N; public class Target {}",
      "B/N.cs": "namespace N; public class Target {}",
      "A/Use.cs": "using N; public class UseA { public Target field; }",
      "B/Use.cs": "using N; public class UseB { public Target field; }",
    });
    const options = { cache, cacheDir: path.join(root, ".cache"), threads: 1 };
    await buildProjectIndexIncremental(root, options);
    const answers = async (index: ProjectIndex) =>
      await Promise.all(["A", "B"].map((folder) => target(index, root, `${folder}/Use.cs`, "Target field")));
    expect(await answers(await buildProjectIndexIncremental(root, options))).toEqual(["not_found", "not_found"]);
    const manifests = ["A/A.csproj", "B/B.csproj"].map((file) => path.join(root, file));
    for (const present of [true, false]) {
      for (const manifest of manifests) {
        if (present) await fsp.writeFile(manifest, "<Project />");
        else await fsp.rm(manifest);
      }
      const warm = await buildProjectIndexIncremental(root, { ...options, files: manifests });
      const actual = await answers(warm);
      expect(actual).toEqual(await answers(await indexProject(root)));
      expect(actual).toEqual(present ? ["A/N.cs:1", "B/N.cs:1"] : ["not_found", "not_found"]);
      if (cache === "disk") {
        clearMemoryCache();
        expect(await answers(await buildProjectIndex(root, options))).toEqual(actual);
      }
    }
  });

  for (const manifest of ["App.csproj", "Directory.Build.props"]) {
    it(`does not read a symlinked-out ${manifest}`, async (context) => {
      const root = await project({
        ...(manifest === "Directory.Build.props" ? { "App.csproj": "<Project/>" } : {}),
        "Lib.cs": LIBRARY,
        "Use.cs": "namespace App; public class Use { public Target field; }",
        "Control.cs": "using Lib; namespace App; public class Control { public Target field; }",
      });
      const outside = await roots.create("cg-global-using-external-");
      const external = path.join(outside, "external.xml");
      const link = path.join(root, manifest);
      await fsp.writeFile(external, '<Project><ItemGroup><Using Include="Lib"/></ItemGroup></Project>');
      try {
        await fsp.symlink(external, link, "file");
      } catch (error) {
        if (isSymlinkUnavailable(error)) return context.skip();
        throw error;
      }
      const reads = vi.spyOn(fsp, "readFile");
      const index = await indexProject(root);
      expect(
        reads.mock.calls.some(
          ([file]) =>
            typeof file === "string" &&
            [fileIdentityKey(link), fileIdentityKey(external)].includes(fileIdentityKey(file)),
        ),
      ).toBe(false);
      expect(index.csharpProjectUsings?.some((fact) => fact.file === manifest && fact.directives.length) ?? false).toBe(
        false,
      );
      expect(await target(index, root, "Use.cs", "Target field")).toBe("not_found");
      expect(await target(index, root, "Control.cs", "Target field")).toBe("Lib.cs:2");
    });
  }

  it.each(["memory", "disk"] as const)(
    "refreshes declaring-file namespace/type/static ownership edits with %s cache",
    async (cache) => {
      const initial =
        "namespace One;\npublic class Target {}\npublic static class Tools { public static int Run() => 1; }";
      const root = await project({
        "App.csproj": "<Project/>",
        "G.cs": "global using One;\nglobal using static One.Tools;\nglobal using A = One.Target;",
        "Lib.cs": initial,
        "Use.cs":
          "namespace App; public class Use { public Target t; public A a; public int F() => Run(); public Added x; }",
      });
      const options = { cache, cacheDir: path.join(root, ".cache"), threads: 1 };
      await buildProjectIndexIncremental(root, options);
      const answers = async (index: ProjectIndex) => {
        const navigation = await Promise.all(
          ["Target t", "A a", "Run();", "Added x"].map((needle) => target(index, root, "Use.cs", needle)),
        );
        const refs: string[] = [];
        for (const symbol of listSymbols(index).filter(
          (item) => item.file.endsWith("/Lib.cs") && ["Target", "Run", "Added"].includes(item.name),
        )) {
          const def = resolveSymbolId(index, symbol.id);
          if (!def) throw new Error("Missing declaring symbol");
          const result = await findReferences(index, { def });
          if (result.status !== "ok") throw new Error("Missing declaring references");
          for (const ref of result.references)
            if (ref.file.endsWith("/Use.cs"))
              refs.push(`${symbol.name}:${ref.range.start.line}:${ref.range.start.column}`);
        }
        const graph = await buildSymbolGraphDetailed(index);
        const calls = graph.edges
          .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.file.endsWith("/Use.cs"))
          .map((edge) => graph.nodes.get(edge.to)?.name)
          .sort();
        return { navigation, refs: refs.sort(), calls };
      };
      const added = initial + "\npublic class Added {}";
      const steps = [
        { source: initial.replace("namespace One", "namespace Two"), found: [false, false, false, false] },
        { source: initial, found: [true, true, true, false] },
        { source: added, found: [true, true, true, true] },
        { source: added.replace("class Target", "class Renamed"), found: [false, false, true, true] },
        { source: added.replace("int Run()", "int RenamedRun()"), found: [true, true, false, true] },
        { source: "namespace One;\npublic class Target {}\npublic class Added {}", found: [true, true, false, true] },
      ];
      for (const step of steps) {
        await fsp.writeFile(path.join(root, "Lib.cs"), step.source);
        const warm = await buildProjectIndexIncremental(root, { ...options, files: [path.join(root, "Lib.cs")] });
        const actual = await answers(warm);
        expect(actual).toEqual(await answers(await indexProject(root)));
        expect(actual.navigation.map((value) => value !== "not_found")).toEqual(step.found);
        if (cache === "disk") {
          clearMemoryCache();
          expect(await answers(await buildProjectIndex(root, options))).toEqual(actual);
        }
      }
    },
  );

  it("preserves extends, implements, overrides, calls, and hierarchy consumers through globals", async () => {
    const root = await project({
      "G.cs": "global using Lib;\nglobal using Contract = Lib.IThing;",
      "Lib.cs":
        "namespace Lib;\npublic interface IThing { void Run(); }\npublic class Base { public virtual void Run() {} }",
      "Use.cs": "namespace App; public class Live : Base, Contract { public override void Run() { base.Run(); } }",
      "Decoy.cs": "namespace Other; public interface IThing {}",
    });
    const index = await indexProject(root);
    const graph = await buildSymbolGraphDetailed(index);
    const edges = graph.edges.map(
      (edge) => `${graph.nodes.get(edge.from)?.name}:${edge.label}:${graph.nodes.get(edge.to)?.name}`,
    );
    for (const relation of ["Live:extends:Base", "Live:implements:IThing", "Run:overrides:Run", "Run:calls:Run"])
      expect(edges).toContain(relation);
    const live = [...graph.nodes.values()].find((node) => node.name === "Live");
    const contract = [...graph.nodes.values()].find((node) => node.name === "IThing" && node.file.endsWith("/Lib.cs"));
    if (!live || !contract) throw new Error("Missing hierarchy symbols");
    const hierarchy = findTypeHierarchy(graph, live.id, "super", { depth: 2 });
    expect(hierarchy.status).toBe("ok");
    if (hierarchy.status !== "ok") throw new Error("Missing global type hierarchy");
    expect(hierarchy.relations.map((relation) => graph.nodes.get(relation.targetId)?.name).sort()).toEqual([
      "Base",
      "IThing",
    ]);
    const implementations = findImplementations(index, graph, contract.id);
    expect(implementations.status).toBe("ok");
    if (implementations.status !== "ok") throw new Error("Missing global implementation");
    expect(implementations.implementations.map((item) => graph.nodes.get(item.symbolId)?.name)).toEqual(["Live"]);
  });

  it.each(["namespace", "alias", "static"])(
    "has complete declaration/usage reference agreement for global %s",
    async (form) => {
      const aliasTarget = form === "alias" ? "A = Lib.Target" : "static Lib.Tools";
      const directive = form === "namespace" ? "global using Lib;" : `global using ${aliasTarget};`;
      const typeName = form === "alias" ? "A" : "Target";
      const use = form === "static" ? "public int F() => Run();" : `public ${typeName} field;`;
      const root = await project({
        "G.cs": directive,
        "Lib.cs": LIBRARY,
        "Use.cs": `namespace App; public class Use { ${use} }`,
      });
      const index = await indexProject(root);
      const refs = await references(index, root, "Lib.cs", form === "static" ? "Run" : "Target");
      expect(refs.referenceCoverage.state).toBe("complete");
      const needle = form === "static" ? "Run();" : `${typeName} field`;
      const usage = await findReferences(index, await position(root, "Use.cs", needle));
      expect(usage.status).toBe("ok");
      if (usage.status !== "ok") throw new Error("Missing usage-started references");
      expect(usage.referenceCoverage.state).toBe("complete");
      expect(usage.references).toEqual(refs.references);
    },
  );

  it.each(["namespace", "alias", "static", "project"])(
    "previews safe semantic rename through a global %s",
    async (form) => {
      const aliasTarget = form === "alias" ? "A = Lib.Widget" : "static Lib.Tools";
      const directive = form === "namespace" ? "global using Lib;" : `global using ${aliasTarget};`;
      const typeName = form === "alias" ? "A" : "Widget";
      const member = form === "static" ? "public void F() => Run();" : `public ${typeName} field;`;
      const root = await project({
        "App.csproj":
          form === "project" ? '<Project><ItemGroup><Using Include="Lib"/></ItemGroup></Project>' : "<Project/>",
        "G.cs": form === "project" ? "" : directive,
        "Lib.cs": "namespace Lib;\npublic class Widget {}\npublic static class Tools { public static void Run() {} }",
        "Decoy.cs": "namespace Other; public class Widget {} public static class Tools { public static void Run() {} }",
        "Use.cs": `namespace App; public class Use { ${member} }`,
      });
      const session = createAgentSession({ root, freshness: { policy: "check" } });
      try {
        const snapshot = await session.loadProject();
        const symbols = await workspaceSymbolsInSnapshot(snapshot, { query: form === "static" ? "Run" : "Widget" });
        const symbol = symbols.symbols.find((item) => item.location.file === "Lib.cs");
        if (!symbol) throw new Error("Missing rename target");
        const result = await previewRenameInSnapshot(snapshot, { root, handle: symbol.handle, newName: "Renamed" });
        expect(result.safe).toBe(true);
        expect(result.conflicts).toEqual([]);
        expect(result.unsafeSites).toEqual([]);
        expect(new Set(result.edits.map((edit) => edit.file))).toEqual(
          new Set(form === "alias" ? ["G.cs", "Lib.cs"] : ["Lib.cs", "Use.cs"]),
        );
        expect(result.edits.some((edit) => edit.file === "Decoy.cs")).toBe(false);
      } finally {
        session.invalidate();
      }
    },
  );

  it.each([
    "record R",
    "record class R",
    "record struct R",
    "readonly record struct R",
    "abstract record R",
    "sealed record R",
    "record R<T>",
    "partial record R",
    "nested",
  ])("keeps body members inside their %s owner for local and peer lookups", async (head) => {
    const body =
      "public int Height { get; init; } public static void Build() {} public int Read() => Height; public static void Call() => Build();";
    const declaration =
      head === "nested" ? `public class Outer { public record R { ${body} } }` : `public ${head} { ${body} }`;
    const root = await project({
      "Rec.cs": `namespace Rendering;\n${declaration}`,
      "Use.cs": "using Rendering;\nnamespace App; public class Use { public void F() { var bare = Height; Build(); } }",
      "Peer.cs": "namespace Rendering; public class Peer { public void F() { var bare = Height; Build(); } }",
    });
    const index = await indexProject(root);
    for (const file of ["Use.cs", "Peer.cs"])
      for (const needle of ["Height;", "Build();"]) expect(await target(index, root, file, needle)).toBe("not_found");
    expect(await target(index, root, "Rec.cs", "Height;")).toBe("Rec.cs:2");
    expect(await target(index, root, "Rec.cs", "Build();")).toBe("Rec.cs:2");
    for (const name of ["Height", "Build"]) expect(definition(index, root, "Rec.cs", name).isMember).toBe(true);
  });
});
