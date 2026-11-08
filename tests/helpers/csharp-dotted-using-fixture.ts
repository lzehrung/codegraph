import path from "node:path";
import { expect } from "vitest";
import { buildSymbolGraphDetailed, findReferences, goToDefinition, type ProjectIndex } from "../../src/index.js";
import { columnOf } from "../languages/callable-consumer-fixtures.js";

const TYPES = {
  "NB.cs": "namespace N; public class B { public class Nested { public static void Run() {} } }\n",
  "OtherB.cs": "namespace Other; public class B { public class Nested { public static void Run() {} } }\n",
  "Decoy.cs": "namespace B; public class Nested { public static void Run() {} }\n",
};
const AMBIGUOUS_USINGS = ["using N;", "using Other;"];
const STATIC_TYPES = {
  "NB.cs":
    "namespace N; public class Outer { public class B { public class Nested { public static void Run() {} } } }\n",
  "OtherB.cs":
    "namespace Other; public class Outer { public class B { public class Nested { public static void Run() {} } } }\n",
};
const NEAR_NAMESPACE = { "Near.cs": "namespace A.B; public class Nested { public static void Run() {} }\n" };

export type CsharpDottedUsingCase = {
  name: string;
  files: Readonly<Record<string, string>>;
  lines: readonly string[];
  callLine: number;
  typeLine: number;
  bareLine: number;
  rootTarget: string | undefined;
  target: string | undefined;
  ambiguous: boolean;
};

function dottedUsingCase(
  name: string,
  directives: readonly string[],
  target?: string,
  options: {
    scope?: "namespace" | "unit" | "file" | "nested";
    qualifier?: string;
    extra?: Readonly<Record<string, string>>;
    ambiguous?: boolean;
    rootTarget?: string;
    namespaceRoot?: boolean;
    partialOwner?: boolean;
    innerDirectives?: readonly string[];
  } = {},
): CsharpDottedUsingCase {
  const scope = options.scope ?? "namespace";
  const lines: string[] = [];
  if (scope === "unit") lines.push(...directives);
  lines.push(scope === "file" ? "namespace A;" : "namespace A {");
  if (scope !== "unit") lines.push(...directives);
  if (scope === "nested") lines.push("namespace Inner {");
  if (options.innerDirectives) lines.push(...options.innerDirectives);
  const qualifier = options.qualifier ?? "B";
  lines.push(
    options.partialOwner ? "partial class Use {" : "class Use {",
    `  void M() { ${qualifier}.Nested.Run(); }`,
    `  ${qualifier}.Nested value;`,
    `  void Plain() { ${qualifier} bare = null; }`,
    "}",
  );
  if (scope === "nested") lines.push("}");
  if (scope !== "file") lines.push("}");
  const callLine = lines.findIndex((line) => line.includes("void M")) + 1;
  let rootTarget = options.rootTarget;
  if (!rootTarget && target && target !== "Decoy.cs" && !options.namespaceRoot) rootTarget = target;
  return {
    name,
    files: { ...TYPES, ...options.extra, "Use.cs": `${lines.join("\n")}\n` },
    lines,
    callLine,
    typeLine: callLine + 1,
    bareLine: callLine + 2,
    rootTarget,
    target,
    ambiguous: options.ambiguous ?? false,
  };
}

export const CSHARP_DOTTED_USING_CASES: readonly CsharpDottedUsingCase[] = [
  dottedUsingCase("ambiguous namespace usings", AMBIGUOUS_USINGS, undefined, { ambiguous: true }),
  dottedUsingCase("ambiguous enclosing namespace usings", AMBIGUOUS_USINGS, undefined, {
    scope: "nested",
    ambiguous: true,
  }),
  dottedUsingCase("ambiguous file-scoped namespace usings", AMBIGUOUS_USINGS, undefined, {
    scope: "file",
    ambiguous: true,
  }),
  // Global namespace members precede compilation-unit usings, unlike usings inside a namespace.
  dottedUsingCase("compilation-unit usings beside a global namespace", AMBIGUOUS_USINGS, "Decoy.cs", { scope: "unit" }),
  dottedUsingCase("one compilation-unit using beside a global namespace", ["using N;"], "Decoy.cs", { scope: "unit" }),
  dottedUsingCase("one using type", ["using N;"], "NB.cs"),
  dottedUsingCase("unbound namespace root", [], "Decoy.cs"),
  dottedUsingCase("global namespace qualifier", AMBIGUOUS_USINGS, "Decoy.cs", { qualifier: "global::B" }),
  dottedUsingCase("explicit type alias", [...AMBIGUOUS_USINGS, "using B = N.B;"], "NB.cs"),
  dottedUsingCase("enclosing namespace type", AMBIGUOUS_USINGS, "Enclosing.cs", {
    extra: { "Enclosing.cs": "namespace A; public class B { public class Nested { public static void Run() {} } }\n" },
  }),
  dottedUsingCase("enclosing type without the nested member", AMBIGUOUS_USINGS, undefined, {
    extra: { "Enclosing.cs": "namespace A; public class B {}\n" },
    rootTarget: "Enclosing.cs",
  }),
  dottedUsingCase("imported type without the nested member", ["using N;"], undefined, {
    extra: { "NB.cs": "namespace N; public class B {}\n" },
    rootTarget: "NB.cs",
  }),
  dottedUsingCase("one namespace static using", ["using static N.Outer;"], "NB.cs", { extra: STATIC_TYPES }),
  dottedUsingCase(
    "ambiguous namespace static usings",
    ["using static N.Outer;", "using static Other.Outer;"],
    undefined,
    {
      extra: STATIC_TYPES,
      ambiguous: true,
    },
  ),
  dottedUsingCase("one compilation-unit static using", ["using static N.Outer;"], "Decoy.cs", {
    scope: "unit",
    extra: STATIC_TYPES,
  }),
  dottedUsingCase(
    "two compilation-unit static usings",
    ["using static N.Outer;", "using static Other.Outer;"],
    "Decoy.cs",
    {
      scope: "unit",
      extra: STATIC_TYPES,
    },
  ),
  dottedUsingCase("near namespace before one using", ["using N;"], "Near.cs", {
    extra: NEAR_NAMESPACE,
    namespaceRoot: true,
  }),
  dottedUsingCase("near namespace before ambiguous usings", AMBIGUOUS_USINGS, "Near.cs", {
    extra: NEAR_NAMESPACE,
    namespaceRoot: true,
  }),
  dottedUsingCase("near type before one using", ["using N;"], "Enclosing.cs", {
    extra: { "Enclosing.cs": "namespace A; public class B { public class Nested { public static void Run() {} } }\n" },
  }),
  dottedUsingCase("inner using before an outer namespace member", ["using N;"], "OtherB.cs", {
    scope: "nested",
    innerDirectives: ["using Other;"],
    extra: NEAR_NAMESPACE,
  }),
  dottedUsingCase("inner namespace before an outer using", AMBIGUOUS_USINGS, "Near.cs", {
    scope: "nested",
    extra: { "Near.cs": "namespace A.Inner.B; public class Nested { public static void Run() {} }\n" },
    namespaceRoot: true,
  }),
  ...[["using N;"], AMBIGUOUS_USINGS].map((directives) =>
    dottedUsingCase(`partial owner before ${directives.length} usings`, directives, "Part.cs", {
      partialOwner: true,
      extra: {
        "Part.cs":
          "namespace A; partial class Use { public class B { public class Nested { public static void Run() {} } } }\n",
      },
    }),
  ),
];

export function csharpPartialGenericRootFixture(): {
  files: Readonly<Record<string, string>>;
  lines: string[];
  genericLine: number;
  ordinaryLine: number;
} {
  const fixture = CSHARP_DOTTED_USING_CASES.find((row) => row.name === "partial owner before 1 usings")!;
  const source = fixture.files["Use.cs"]!.replace(
    "partial class Use {",
    () => "partial class Use {\n  void Generic<B>() { B.Nested.Run(); }",
  );
  return {
    files: { ...fixture.files, "Use.cs": source },
    lines: source.split("\n"),
    genericLine: fixture.callLine,
    ordinaryLine: fixture.callLine + 1,
  };
}

type FixturePaths = Readonly<Record<string, string>>;

/** The dotted call and the field type name must follow the same root lookup. */
export async function expectDottedUsingGoto(
  index: ProjectIndex,
  files: FixturePaths,
  testCase: CsharpDottedUsingCase,
): Promise<void> {
  for (const [line, token] of [
    [testCase.callLine, "Run"],
    [testCase.callLine, "Nested"],
    [testCase.typeLine, "Nested"],
  ] as const) {
    const result = await goToDefinition(index, {
      file: files["Use.cs"]!,
      line,
      column: columnOf(testCase.lines, line, token),
    });
    const label = `${testCase.name}: ${line}:${token}`;
    expect(result.status, label).toBe(testCase.target ? "ok" : "not_found");
    if (result.status === "ok") {
      expect(result.definition.file, label).toBe(files[testCase.target!]);
      expect(result.definition.localName, label).toBe(token);
    }
  }
  for (const line of [testCase.callLine, testCase.bareLine]) {
    const result = await goToDefinition(index, {
      file: files["Use.cs"]!,
      line,
      column: columnOf(testCase.lines, line, "B"),
    });
    const label = `${testCase.name}: bare root on ${line}`;
    expect(result.status, label).toBe(testCase.rootTarget ? "ok" : "not_found");
    if (result.status === "ok") {
      expect(result.definition.file, label).toBe(files[testCase.rootTarget!]);
      expect(result.definition.localName, label).toBe("B");
    }
  }
}

/** Both imported types and the same-named namespace keep only their own proven references. */
export async function expectDottedUsingReferences(
  index: ProjectIndex,
  files: FixturePaths,
  testCase: CsharpDottedUsingCase,
): Promise<void> {
  for (const [file, source] of Object.entries(testCase.files)) {
    if (file === "Use.cs") continue;
    const tokens: string[] = [];
    if (source.includes("class B")) tokens.push("B");
    if (source.includes("Nested")) tokens.push("Run", "Nested");
    for (const token of tokens) {
      const refs = await findReferences(index, { file: files[file]!, line: 1, column: source.indexOf(token) + 1 });
      const label = `${testCase.name}: references of ${file}::${token}`;
      expect(refs.status, label).toBe("ok");
      if (refs.status !== "ok") continue;
      const useLines = refs.references
        .filter((site) => site.file === files["Use.cs"] && site.range.start.line >= testCase.callLine)
        .map((site) => site.range.start.line)
        .sort((left, right) => left - right);
      let expected: number[] = [];
      if (token === "B" && testCase.rootTarget === file) {
        expected = [testCase.callLine, testCase.typeLine, testCase.bareLine];
      } else if (token !== "B" && testCase.target === file) {
        expected = [testCase.callLine];
        if (token === "Nested") expected.push(testCase.typeLine);
      }
      expect(useLines, label).toEqual(expected);
      if (testCase.ambiguous) expect(refs.referenceCoverage.state, label).toBe("partial");
      const provenTypeRoot = token !== "B" || !!testCase.rootTarget;
      if (testCase.target && provenTypeRoot) expect(refs.referenceCoverage.state, label).toBe("complete");
    }
  }
}

/** The caller has one proven callee, or none; namespace decoys never gain type-use edges. */
export async function expectDottedUsingEdges(
  index: ProjectIndex,
  files: FixturePaths,
  testCase: CsharpDottedUsingCase,
): Promise<void> {
  const graph = await buildSymbolGraphDetailed(index);
  const calls = graph.edges.flatMap((edge) => {
    const from = graph.nodes.get(edge.from);
    const to = graph.nodes.get(edge.to);
    if (from?.file !== files["Use.cs"] || from.name !== "M" || edge.label !== "calls" || !to) return [];
    return [`${path.basename(to.file)}::${to.name}`];
  });
  expect(calls, `${testCase.name}: callees of M`).toEqual(testCase.target ? [`${testCase.target}::Run`] : []);
  const bareImportedTypes = graph.edges.flatMap((edge) => {
    if (edge.label !== "uses") return [];
    const from = graph.nodes.get(edge.from);
    const to = graph.nodes.get(edge.to);
    if (from?.file !== files["Use.cs"] || from.name !== "Plain" || to?.name !== "B") return [];
    if (to.file !== files["NB.cs"] && to.file !== files["OtherB.cs"]) return [];
    return [path.basename(to.file)];
  });
  const wrongBareImports = bareImportedTypes.filter((file) => file !== testCase.rootTarget);
  expect(wrongBareImports, `${testCase.name}: bare type import decoys`).toEqual([]);
  const ordinaryImportedRoot = testCase.rootTarget === "NB.cs" && testCase.files["NB.cs"] === TYPES["NB.cs"];
  if (ordinaryImportedRoot) expect(bareImportedTypes, `${testCase.name}: ordinary bare import use`).toContain("NB.cs");
  if (testCase.target !== "Decoy.cs") {
    const decoyUses = graph.edges.filter((edge) => {
      if (edge.label !== "uses") return false;
      return (
        graph.nodes.get(edge.from)?.file === files["Use.cs"] && graph.nodes.get(edge.to)?.file === files["Decoy.cs"]
      );
    });
    expect(decoyUses, `${testCase.name}: namespace type-use decoys`).toEqual([]);
  }
}

export async function expectDottedUsingConsumers(
  index: ProjectIndex,
  files: FixturePaths,
  testCase: CsharpDottedUsingCase,
): Promise<void> {
  await expectDottedUsingGoto(index, files, testCase);
  await expectDottedUsingReferences(index, files, testCase);
  await expectDottedUsingEdges(index, files, testCase);
}
