import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

const project = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "accuracy", "oracles", "csharp");
const files = {
  "Types.cs": [
    "namespace Demo;",
    "public partial class Worker",
    "{",
    "    public readonly int Count;",
    "    public Worker(int value) { Count = value; }",
    "    public void Handle(int value) { }",
    "    public void Handle(string value) { }",
    "    public void Handle(Inner value) { }",
    "    public void Only(int value) { }",
    "    public class Inner",
    "    {",
    "        public int Value => 1;",
    "    }",
    "}",
    "public class DefaultCtor { }",
    "namespace Sub.One { public class Child { } }",
    "public partial class Worker",
    "{",
    "    public partial void Part() { }",
    '    public partial string PartProp => "done";',
    "    public partial event System.Action? PartEvent { add { } remove { } }",
    "}",
  ].join("\n"),
  "Extensions.cs": [
    "namespace Demo;",
    "public partial class Worker",
    "{",
    '    public string Name => "worker";',
    "}",
    "public static class Extensions",
    "{",
    "    public static string Describe(this Worker worker) => worker.Name;",
    "}",
    "public partial class Worker",
    "{",
    "    static Worker() { }",
    "    ~Worker() { }",
    "    public partial void Part();",
    "    public partial string PartProp { get; }",
    "    public partial event System.Action? PartEvent;",
    "}",
  ].join("\n"),
  "Use.cs": [
    "using Demo;",
    "using Alias = Demo.Worker;",
    "namespace Client;",
    "public class Use",
    "{",
    "    private static void Tick() { }",
    "    public string Exercise()",
    "    {",
    "        /*\ud83d\ude00*/ Worker worker = new Worker(1);",
    "        worker.Handle(1);",
    '        worker.Handle("text");',
    "        worker.Handle(null);",
    '        worker.Only("bad");',
    "        string description = worker.Describe();",
    "        var inner = new Worker.Inner();",
    "        int number = inner.Value;",
    "        List<string> list = new List<string>();",
    "        Console.WriteLine(description);",
    "        Alias alias = worker;",
    "        UnknownPackage missing = null!;",
    "        var defaultCtor = new DefaultCtor();",
    "        int absolute = System.Math.Abs(-1);",
    "        Tick();",
    "        Demo.Sub.One.Child child = new Demo.Sub.One.Child();",
    "        return worker.Name;",
    "    }",
    "}",
  ].join("\n"),
};

type SourceFile = keyof typeof files;
type Position = { file: string; line: number; column: number };
type Site = Position & { name: string; form: string; definitions: Position[]; external: boolean };
type Declaration = Position & { name: string; kind: string; references: Position[]; relatedDeclarations: Position[] };
type OracleResponse = {
  schemaVersion: number;
  language: string;
  oracle: { name: string; version: string };
  sites: Site[];
  declarations: Declaration[];
  diagnostics: { files: number; unresolvedSites: number; errors: string[] };
};

function position(file: SourceFile, line: number, name: string, occurrence = 0): Position {
  const text = files[file].split("\n")[line - 1];
  let offset = -1;
  for (let index = 0; index <= occurrence; index++) {
    offset = text.indexOf(name, offset + 1);
    assert.notEqual(offset, -1, `${name} not found in ${file}:${line}`);
  }
  return { file, line, column: offset + 1 };
}

function siteAt(response: OracleResponse, file: SourceFile, line: number, name: string, occurrence = 0): Site {
  const expected = position(file, line, name, occurrence);
  const site = response.sites.find(
    (item) => item.file === file && item.line === line && item.column === expected.column,
  );
  assert.ok(site, `missing site ${file}:${line}:${expected.column} ${name}`);
  assert.equal(site.name, name);
  return site;
}

function declarationAt(response: OracleResponse, file: SourceFile, line: number, name: string): Declaration {
  const expected = position(file, line, name);
  const declaration = response.declarations.find(
    (item) => item.file === file && item.line === line && item.column === expected.column,
  );
  assert.ok(declaration, `missing declaration ${file}:${line}:${expected.column} ${name}`);
  return declaration;
}

function sampled(items: readonly Position[], seed: number, count: number): Position[] {
  const result = [...items].sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.column - b.column;
  });
  let state = seed;
  for (let index = result.length - 1; index > 0; index--) {
    let value = (state += 0x6d2b79f5) >>> 0;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    const random = ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    const selected = Math.floor(random * (index + 1));
    [result[index], result[selected]] = [result[selected], result[index]];
  }
  return result.slice(0, count).map(({ file, line, column }) => ({ file, line, column }));
}

it.skipIf(process.env.CODEGRAPH_ACCURACY_ORACLES !== "1")(
  "Roslyn oracle resolves, samples, and locates real C# identifiers",
  () => {
    const root = mkdtempSync(join(tmpdir(), "codegraph-csharp-oracle-"));
    try {
      for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
      const projectFile = join(root, "Tiny.csproj");
      const projectText = (setting: string) =>
        `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><ImplicitUsings>${setting}</ImplicitUsings></PropertyGroup></Project>`;
      writeFileSync(projectFile, projectText("enable"));
      const requestPath = join(root, "request.json");
      const outputPath = join(root, "response.json");
      const request = {
        schemaVersion: 1,
        language: "csharp",
        files: Object.keys(files).sort(),
        seed: 1,
        maxSites: 1000,
        maxDeclarations: 1000,
      };
      const run = (): OracleResponse => {
        writeFileSync(requestPath, JSON.stringify(request));
        execFileSync(
          "dotnet",
          [
            "run",
            "--project",
            project,
            "-c",
            "Release",
            "--",
            "--root",
            root,
            "--request",
            requestPath,
            "--output",
            outputPath,
          ],
          { encoding: "utf8", windowsHide: true },
        );
        return JSON.parse(readFileSync(outputPath, "utf8")) as OracleResponse;
      };
      const result = run();
      assert.equal(result.schemaVersion, 1);
      assert.equal(result.language, "csharp");
      assert.deepEqual(result.oracle, { name: "roslyn", version: "5.0.0" });
      assert.equal(result.diagnostics.files, 3);
      assert.deepEqual(result.diagnostics.errors, []);
      assert.equal(
        result.diagnostics.unresolvedSites,
        result.sites.filter((site) => !site.external && !site.definitions.length).length,
      );

      const type = siteAt(result, "Use.cs", 9, "Worker");
      assert.equal(type.form, "type-reference");
      assert.deepEqual(type.definitions, [
        position("Extensions.cs", 2, "Worker"),
        position("Extensions.cs", 10, "Worker"),
        position("Types.cs", 2, "Worker"),
        position("Types.cs", 17, "Worker"),
      ]);
      const constructor = siteAt(result, "Use.cs", 9, "Worker", 1);
      assert.equal(constructor.form, "constructor");
      assert.deepEqual(constructor.definitions, [position("Types.cs", 5, "Worker")]);
      assert.equal(type.column, 16, "columns count UTF-16 code units");
      assert.deepEqual(siteAt(result, "Use.cs", 10, "Handle").definitions, [position("Types.cs", 6, "Handle")]);
      assert.deepEqual(siteAt(result, "Use.cs", 11, "Handle").definitions, [position("Types.cs", 7, "Handle")]);
      assert.deepEqual(siteAt(result, "Use.cs", 12, "Handle").definitions, []);
      assert.equal(siteAt(result, "Use.cs", 12, "Handle").external, false);
      assert.deepEqual(siteAt(result, "Use.cs", 13, "Only").definitions, [position("Types.cs", 9, "Only")]);
      const extension = siteAt(result, "Use.cs", 14, "Describe");
      assert.equal(extension.form, "member-call");
      assert.deepEqual(extension.definitions, [position("Extensions.cs", 8, "Describe")]);
      assert.deepEqual(siteAt(result, "Use.cs", 15, "Inner").definitions, [position("Types.cs", 10, "Inner")]);
      assert.equal(siteAt(result, "Use.cs", 16, "Value").form, "member-access");
      assert.deepEqual(siteAt(result, "Use.cs", 21, "DefaultCtor").definitions, [
        position("Types.cs", 15, "DefaultCtor"),
      ]);
      assert.equal(siteAt(result, "Use.cs", 23, "Tick").form, "bare-call");
      assert.equal(siteAt(result, "Use.cs", 2, "Worker").form, "import");
      assert.deepEqual(siteAt(result, "Use.cs", 24, "One").definitions, [position("Types.cs", 16, "One")]);
      assert.deepEqual(siteAt(result, "Use.cs", 24, "Child", 1).definitions, [position("Types.cs", 16, "Child")]);
      for (const [line, name, occurrence] of [
        [17, "List", 0],
        [17, "List", 1],
        [18, "Console", 0],
        [18, "WriteLine", 0],
        [22, "Abs", 0],
      ] as const) {
        const site = siteAt(result, "Use.cs", line, name, occurrence);
        assert.equal(site.external, true, `${name} should resolve to the runtime`);
        assert.deepEqual(site.definitions, []);
      }
      const missing = siteAt(result, "Use.cs", 20, "UnknownPackage");
      assert.equal(missing.external, false);
      assert.deepEqual(missing.definitions, []);
      assert.ok(!result.sites.some((site) => site.file === "Use.cs" && site.line === 2 && site.name === "Alias"));
      assert.ok(!result.sites.some((site) => site.file === "Types.cs" && site.line === 2 && site.name === "Worker"));
      assert.ok(!result.sites.some((site) => site.file === "Types.cs" && site.line === 1 && site.name === "Demo"));
      assert.ok(!result.sites.some((site) => site.name === "var"));
      assert.ok(!result.declarations.some((declaration) => declaration.name === "worker"));

      const intOverload = declarationAt(result, "Types.cs", 6, "Handle");
      const stringOverload = declarationAt(result, "Types.cs", 7, "Handle");
      assert.equal(intOverload.kind, "method");
      assert.deepEqual(intOverload.references, [position("Use.cs", 10, "Handle")]);
      assert.deepEqual(stringOverload.references, [position("Use.cs", 11, "Handle")]);
      assert.deepEqual(declarationAt(result, "Types.cs", 9, "Only").references, [position("Use.cs", 13, "Only")]);
      assert.deepEqual(declarationAt(result, "Extensions.cs", 8, "Describe").references, [
        position("Use.cs", 14, "Describe"),
      ]);
      assert.deepEqual(declarationAt(result, "Types.cs", 5, "Worker").references, [position("Use.cs", 9, "Worker", 1)]);
      const partial = declarationAt(result, "Types.cs", 2, "Worker");
      assert.ok(partial.references.some((reference) => reference.file === "Use.cs" && reference.line === 9));
      assert.ok(!partial.references.some((reference) => reference.file === "Types.cs" && reference.line === 2));
      assert.ok(!partial.references.some((reference) => reference.file === "Extensions.cs" && reference.line === 2));
      assert.deepEqual(partial.relatedDeclarations, [
        position("Extensions.cs", 2, "Worker"),
        position("Extensions.cs", 10, "Worker"),
        position("Extensions.cs", 12, "Worker"),
        position("Extensions.cs", 13, "Worker"),
        position("Types.cs", 5, "Worker"),
        position("Types.cs", 17, "Worker"),
      ]);
      assert.deepEqual(declarationAt(result, "Types.cs", 5, "Worker").relatedDeclarations, [
        position("Extensions.cs", 2, "Worker"),
        position("Extensions.cs", 10, "Worker"),
        position("Extensions.cs", 12, "Worker"),
        position("Extensions.cs", 13, "Worker"),
        position("Types.cs", 2, "Worker"),
        position("Types.cs", 17, "Worker"),
      ]);
      assert.deepEqual(declarationAt(result, "Types.cs", 15, "DefaultCtor").relatedDeclarations, []);
      assert.deepEqual(intOverload.relatedDeclarations, []);
      assert.deepEqual(declarationAt(result, "Extensions.cs", 14, "Part").relatedDeclarations, [
        position("Types.cs", 19, "Part"),
      ]);
      assert.deepEqual(declarationAt(result, "Types.cs", 19, "Part").relatedDeclarations, [
        position("Extensions.cs", 14, "Part"),
      ]);
      assert.deepEqual(declarationAt(result, "Extensions.cs", 15, "PartProp").relatedDeclarations, [
        position("Types.cs", 20, "PartProp"),
      ]);
      assert.deepEqual(declarationAt(result, "Types.cs", 20, "PartProp").relatedDeclarations, [
        position("Extensions.cs", 15, "PartProp"),
      ]);
      assert.deepEqual(declarationAt(result, "Extensions.cs", 16, "PartEvent").relatedDeclarations, [
        position("Types.cs", 21, "PartEvent"),
      ]);
      assert.deepEqual(declarationAt(result, "Types.cs", 21, "PartEvent").relatedDeclarations, [
        position("Extensions.cs", 16, "PartEvent"),
      ]);

      request.maxSites = 12;
      request.maxDeclarations = 5;
      const sample = run();
      assert.deepEqual(
        sample.sites.map(({ file, line, column }) => ({ file, line, column })),
        sampled(result.sites, 1, 12),
      );
      assert.deepEqual(
        sample.declarations.map(({ file, line, column }) => ({ file, line, column })),
        sampled(result.declarations, 1, 5),
      );
      assert.deepEqual(run(), sample, "same request must produce identical results");

      writeFileSync(projectFile, projectText("disable"));
      request.maxSites = 1000;
      request.maxDeclarations = 1000;
      const disabled = run();
      assert.equal(siteAt(disabled, "Use.cs", 17, "List").external, false);
      assert.equal(siteAt(disabled, "Use.cs", 18, "Console").external, false);
      assert.equal(siteAt(disabled, "Use.cs", 22, "Abs").external, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  120_000,
);
