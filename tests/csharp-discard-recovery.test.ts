import { describe, expect, it } from "vitest";
import { formatAgentSymbolHandle } from "../src/agent/handles.js";
import { previewRenameWithSession } from "../src/agent/rename-preview.js";
import { createAgentSession } from "../src/agent/session.js";
import { buildSymbolGraphDetailed, findReferences, goToDefinition, type ProjectIndex } from "../src/index.js";
import { fileIdentityKey } from "../src/util/paths.js";
import { eachIndexMode, withBatch3Fixture, type Batch3Fixture } from "./helpers/csharp-java-batch3-fixture.js";
import {
  CSHARP_DISCARD_FIELD_SITES,
  CSHARP_DISCARD_NONREFERENCES,
  CSHARP_DISCARD_REVIEW_SOURCE,
  CSHARP_NESTED_DISCARD_FIELD_SITES,
  CSHARP_NESTED_DISCARD_SOURCE,
} from "./helpers/csharp-discard-review-fixture.js";

type Position = readonly [line: number, column: number];
const key = ([line, column]: Position): string => `${line}:${column}`;

async function expectDefinition(index: ProjectIndex, file: string, use: Position, definition: Position): Promise<void> {
  const result = await goToDefinition(index, { file, line: use[0], column: use[1] });
  expect(result.status, key(use)).toBe("ok");
  if (result.status === "ok") {
    expect([result.definition.range.start.line, result.definition.range.start.column], key(use)).toEqual(definition);
  }
}

async function expectReferenceSites(
  index: ProjectIndex,
  file: string,
  definition: Position,
  sites: readonly Position[],
  coverage: "complete" | "partial",
): Promise<void> {
  const result = await findReferences(index, { file, line: definition[0], column: definition[1] });
  expect(result.status).toBe("ok");
  if (result.status !== "ok") return;
  expect(result.referenceCoverage.state).toBe(coverage);
  expect(result.references.map((ref) => `${ref.range.start.line}:${ref.range.start.column}`).sort()).toEqual(
    sites.map(key).sort(),
  );
}

async function expectRename(
  fixture: Batch3Fixture,
  filename: string,
  name: string,
  definition: Position,
  sites: readonly Position[],
  safe: boolean,
): Promise<void> {
  const session = createAgentSession({
    root: fixture.root,
    buildOptions: { cache: "off", threads: 1 },
    freshness: { policy: "check" },
  });
  try {
    const handle = formatAgentSymbolHandle({ file: filename, name, line: definition[0], column: definition[1] });
    const preview = await previewRenameWithSession(session, { root: fixture.root, handle, newName: "Renamed" });
    expect(preview.safe).toBe(safe);
    expect(preview.edits.map((edit) => `${edit.range.start.line}:${edit.range.start.column}`).sort()).toEqual(
      sites.map(key).sort(),
    );
  } finally {
    session.invalidate();
  }
}

describe("C# discards and recovered names", () => {
  it.each([
    {
      name: "typed, out, lambda, ordinary, and escaped names",
      filename: "DiscardShapes.cs",
      source: CSHARP_DISCARD_REVIEW_SOURCE,
      sites: CSHARP_DISCARD_FIELD_SITES,
      nonreferences: CSHARP_DISCARD_NONREFERENCES,
    },
    {
      name: "nested and foreach deconstruction",
      filename: "Discards.cs",
      source: CSHARP_NESTED_DISCARD_SOURCE,
      sites: CSHARP_NESTED_DISCARD_FIELD_SITES,
      nonreferences: [
        [7, 28],
        [8, 30],
        [9, 34],
        [9, 49],
      ] as const,
    },
  ])("excludes Roslyn discard designations: $name", async ({ filename, source, sites, nonreferences }) => {
    await withBatch3Fixture("cg-csharp-discard-review-", { [filename]: source }, async (fixture) => {
      const file = fixture.files[filename]!;
      const definition = sites[0]!;
      await eachIndexMode(fixture, async (index) => {
        expect(index.byFile.get(fileIdentityKey(file))?.parseErrorRanges).toEqual([]);
        for (const use of sites.slice(1)) await expectDefinition(index, file, use, definition);
        await expectReferenceSites(index, file, definition, sites, "complete");
        const captured = index.byFile.get(fileIdentityKey(file))!.locals;
        for (const [line, column] of nonreferences) {
          expect(captured.some((local) => local.range.start.line === line && local.range.start.column === column)).toBe(
            false,
          );
        }
        const graph = await buildSymbolGraphDetailed(index);
        expect([...graph.nodes.values()].filter((node) => node.name === "_")).toHaveLength(2);
        for (const [line, column] of nonreferences) {
          expect(
            graph.edges.some((edge) => edge.site?.range.start.line === line && edge.site.range.start.column === column),
          ).toBe(false);
        }
        if (filename === "DiscardShapes.cs") {
          await expectDefinition(index, file, [10, 46], [10, 41]);
          await expectDefinition(index, file, [13, 34], [13, 20]);
          await expectDefinition(index, file, [14, 51], [14, 23]);
          for (const use of [
            [5, 21],
            [6, 33],
            [11, 44],
            [11, 47],
            [12, 49],
            [12, 56],
          ] as const) {
            expect((await goToDefinition(index, { file, line: use[0], column: use[1] })).status, key(use)).toBe(
              "not_found",
            );
          }
        }
      });
      await expectRename(fixture, filename, "_", definition, sites, true);
    });
  });

  it("keeps recursive-pattern discards separate from an escaped designation", async () => {
    const filename = "Probe.cs";
    const source = `public class Probe {
 public int _ = 7;
 public int F(object x) { if (x is {} _) return _; return _; }
 public int G(object x) => x is Probe {} _ ? _ : this._;
 public int H(object x) { switch (x) { case Probe {} _: return _; default: return _; } }
 public int I(object x) => x switch { Probe {} _ => _, _ => _ };
 public int J(object x) => x is { } @_ ? @_ .GetHashCode() : this._;
}
`;
    const sites: Position[] = [
      [2, 13],
      [3, 49],
      [3, 59],
      [4, 46],
      [4, 55],
      [5, 64],
      [5, 83],
      [6, 53],
      [6, 61],
      [7, 67],
    ];
    await withBatch3Fixture("cg-csharp-recursive-discard-", { [filename]: source }, async (fixture) => {
      const file = fixture.files[filename]!;
      await eachIndexMode(fixture, async (index) => {
        for (const use of sites.slice(1)) await expectDefinition(index, file, use, sites[0]!);
        await expectDefinition(index, file, [7, 42], [7, 37]);
        await expectReferenceSites(index, file, sites[0]!, sites, "complete");
        const graph = await buildSymbolGraphDetailed(index);
        expect([...graph.nodes.values()].filter((node) => node.name === "_")).toHaveLength(1);
      });
      await expectRename(fixture, filename, "_", sites[0]!, sites, true);
    });
  });

  it("excludes a positional-pattern discard parsed as a declaration expression", async () => {
    const filename = "Probe.cs";
    const source = `public record Pair(int X, int Y);
public class Probe {
 int _ = 7;
 int F(object value) => value is Pair(var _, var p) ? _ + p : this._;
}
`;
    const sites: Position[] = [
      [3, 6],
      [4, 55],
      [4, 68],
    ];
    await withBatch3Fixture("cg-csharp-positional-discard-", { [filename]: source }, async (fixture) => {
      const file = fixture.files[filename]!;
      await eachIndexMode(fixture, async (index) => {
        expect((await goToDefinition(index, { file, line: 4, column: 43 })).status).toBe("not_found");
        await expectDefinition(index, file, [4, 59], [4, 50]);
        await expectReferenceSites(index, file, sites[0]!, sites, "complete");
        const graph = await buildSymbolGraphDetailed(index);
        expect([...graph.nodes.values()].filter((node) => node.name === "_")).toHaveLength(1);
      });
      await expectRename(fixture, filename, "_", sites[0]!, sites, true);
    });
  });

  it("does not resolve an unbound out discard to an unrelated field", async () => {
    const filename = "Probe.cs";
    const source = `public class Unrelated { public int _ = 1; public int Read() => _; }
public class Consumer { public bool F() => int.TryParse("1", out _); }
`;
    const sites: Position[] = [
      [1, 37],
      [1, 65],
    ];
    await withBatch3Fixture("cg-csharp-out-discard-", { [filename]: source }, async (fixture) => {
      const file = fixture.files[filename]!;
      await eachIndexMode(fixture, async (index) => {
        expect((await goToDefinition(index, { file, line: 2, column: 66 })).status).toBe("not_found");
        await expectReferenceSites(index, file, sites[0]!, sites, "complete");
      });
      await expectRename(fixture, filename, "_", sites[0]!, sites, true);
    });
  });

  it("retains a query range variable recovered as a declaration expression", async () => {
    const filename = "Probe.cs";
    const source = `using System;
using System.Linq;
class Probe {
 public static string F(int length) => new string((
  from _ in Enumerable.Range(0, length)
  select (char)('0' + _)).ToArray());
}
`;
    const sites: Position[] = [
      [5, 8],
      [6, 23],
    ];
    await withBatch3Fixture("cg-csharp-recovered-query-", { [filename]: source }, async (fixture) => {
      const file = fixture.files[filename]!;
      await eachIndexMode(fixture, async (index) => {
        await expectDefinition(index, file, sites[1]!, sites[0]!);
        await expectReferenceSites(index, file, sites[0]!, sites, "partial");
        const graph = await buildSymbolGraphDetailed(index);
        expect([...graph.nodes.values()].some((node) => node.name === "_" && node.kind === "variable")).toBe(true);
      });
      await expectRename(fixture, filename, "_", sites[0]!, sites, false);
    });
  });

  it("retains a field read following a recovered query range", async () => {
    const filename = "Probe.cs";
    const source = `using System.Linq;
public class Probe {
 public int _ = 7;
 public int Query(int[] values) {
  var q = from _ in values where _ > 0 select _;
  return q.Sum() + _;
 }
}
`;
    await withBatch3Fixture("cg-csharp-recovered-query-field-", { [filename]: source }, async (fixture) => {
      const file = fixture.files[filename]!;
      await eachIndexMode(fixture, async (index) => {
        expect(index.byFile.get(fileIdentityKey(file))?.parseErrorRanges?.length).toBeGreaterThan(0);
        await expectDefinition(index, file, [6, 20], [3, 13]);
        const refs = await findReferences(index, { file, line: 3, column: 13 });
        expect(refs.status).toBe("ok");
        if (refs.status !== "ok") return;
        expect(refs.referenceCoverage.state).toBe("partial");
        expect(refs.references.some((ref) => ref.range.start.line === 6 && ref.range.start.column === 20)).toBe(true);
      });
      const session = createAgentSession({
        root: fixture.root,
        buildOptions: { cache: "off", threads: 1 },
        freshness: { policy: "check" },
      });
      try {
        const handle = formatAgentSymbolHandle({ file: filename, name: "_", line: 3, column: 13 });
        const preview = await previewRenameWithSession(session, { root: fixture.root, handle, newName: "Renamed" });
        expect(preview.safe).toBe(false);
        expect(preview.edits.some((edit) => edit.range.start.line === 6 && edit.range.start.column === 20)).toBe(true);
      } finally {
        session.invalidate();
      }
    });
  });

  it.each([
    {
      name: "parsed",
      query: "from value in values let x = value + 1 select x",
      coverage: "complete",
      safe: true,
    },
    {
      name: "recovered",
      query: "from _ in values let x = _ + 1 select x",
      coverage: "partial",
      safe: false,
    },
  ] as const)("retains the outer field after a $name let query", async ({ name, query, coverage, safe }) => {
    const filename = "Probe.cs";
    const source = `using System.Linq;
public class Probe {
 public int x = 7;
 public int Query(int[] values) {
  var q = ${query};
  return q.Sum() + x;
 }
}
`;
    const sites: Position[] = [
      [3, 13],
      [6, 20],
    ];
    await withBatch3Fixture("cg-csharp-query-let-field-", { [filename]: source }, async (fixture) => {
      const file = fixture.files[filename]!;
      await eachIndexMode(fixture, async (index) => {
        await expectDefinition(index, file, sites[1]!, sites[0]!);
        await expectReferenceSites(index, file, sites[0]!, sites, coverage);
        if (name === "parsed") await expectDefinition(index, file, [5, 57], [5, 36]);
      });
      await expectRename(fixture, filename, "x", sites[0]!, sites, safe);
    });
  });

  it("keeps a recovered typed slice local out of field references and rename edits", async () => {
    // Roslyn binds 4:49 to the slice designation at 4:44, not the field at 2:13.
    const filename = "Probe.cs";
    const source = `public class Probe {
 public int p = 7, a = 8, rest = 9;
 public int Control() => p + a + rest;
 public int F(int[] xs) => xs is [.. int[] p] ? p.Length : this.p;
}
`;
    const sites: Position[] = [
      [2, 13],
      [3, 26],
      [4, 65],
    ];
    await withBatch3Fixture("cg-csharp-typed-slice-", { [filename]: source }, async (fixture) => {
      const file = fixture.files[filename]!;
      await eachIndexMode(fixture, async (index) => {
        for (const use of [
          [4, 44],
          [4, 49],
        ] as const) {
          expect((await goToDefinition(index, { file, line: use[0], column: use[1] })).status).toBe("not_found");
        }
        await expectDefinition(index, file, sites[2]!, sites[0]!);
        await expectReferenceSites(index, file, sites[0]!, sites, "partial");
        const graph = await buildSymbolGraphDetailed(index);
        expect(
          graph.edges.some((edge) => edge.site?.range.start.line === 4 && edge.site.range.start.column === 49),
        ).toBe(false);
      });
      await expectRename(fixture, filename, "p", sites[0]!, sites, false);
    });
  });

  it.each([
    {
      name: "lambda",
      source: `using System;
class Probe { int p=7; int F(int[] xs) { Func<int> f = () => xs is [1, .. var p] ? p.Length : 0; return p + f(); } }
`,
      definition: [2, 19],
      binder: [2, 79],
      inner: [2, 84],
      outer: [2, 105],
    },
    {
      name: "local function",
      source:
        "class Probe { int p=7; int F(int[] xs) { int Inner() => xs is [1, .. var p] ? p.Length : 0; return p + Inner(); } }\n",
      definition: [1, 19],
      binder: [1, 74],
      inner: [1, 79],
      outer: [1, 100],
    },
  ] as const)("keeps outer values outside the recovered $name body", async (testCase) => {
    const filename = "Probe.cs";
    await withBatch3Fixture("cg-csharp-recovered-nested-", { [filename]: testCase.source }, async (fixture) => {
      const file = fixture.files[filename]!;
      const sites = [testCase.definition, testCase.outer];
      await eachIndexMode(fixture, async (index) => {
        await expectDefinition(index, file, testCase.outer, testCase.definition);
        for (const use of [testCase.binder, testCase.inner]) {
          expect((await goToDefinition(index, { file, line: use[0], column: use[1] })).status).toBe("not_found");
        }
        await expectReferenceSites(index, file, testCase.definition, sites, "partial");
        const graph = await buildSymbolGraphDetailed(index);
        expect(
          graph.edges.some(
            (edge) =>
              edge.site?.range.start.line === testCase.inner[0] && edge.site.range.start.column === testCase.inner[1],
          ),
        ).toBe(false);
      });
      await expectRename(fixture, filename, "p", testCase.definition, sites, false);
    });
  });

  it("keeps captured recovered names unresolved without hiding nearer lambda parameters", async () => {
    const filename = "Probe.cs";
    const source = `using System;
class Probe {
 int p = 7;
 Func<int> F(int[] xs) => xs is [.. var p] ? (() => p.Length) : (() => this.p);
 int H(int[] xs) { Func<int,int> f = p => p + 1; return xs is [.. var p] ? f(1) : this.p; }
}
`;
    const fieldSites: Position[] = [
      [3, 6],
      [4, 77],
      [5, 88],
    ];
    await withBatch3Fixture("cg-csharp-recovered-capture-", { [filename]: source }, async (fixture) => {
      const file = fixture.files[filename]!;
      await eachIndexMode(fixture, async (index) => {
        expect((await goToDefinition(index, { file, line: 4, column: 53 })).status).toBe("not_found");
        await expectDefinition(index, file, [5, 43], [5, 38]);
        await expectReferenceSites(index, file, fieldSites[0]!, fieldSites, "partial");
        await expectReferenceSites(
          index,
          file,
          [5, 38],
          [
            [5, 38],
            [5, 43],
          ],
          "partial",
        );
      });
      await expectRename(fixture, filename, "p", fieldSites[0]!, fieldSites, false);
    });
  });

  it("retains type-only names beside a recovered value designation", async () => {
    const filename = "Probe.cs";
    const source = `public class p { public int Value; }
public class Probe {
 public int F(int[] xs) {
  p before = new p();
  if (xs is [1, .. var p]) return p.Length;
  p after = new p();
  return before.Value + after.Value;
 }
}
`;
    const sites: Position[] = [
      [1, 14],
      [4, 3],
      [4, 18],
      [6, 17],
    ];
    await withBatch3Fixture("cg-csharp-recovered-types-", { [filename]: source }, async (fixture) => {
      const file = fixture.files[filename]!;
      await eachIndexMode(fixture, async (index) => {
        for (const use of sites.slice(1)) await expectDefinition(index, file, use, sites[0]!);
        expect((await goToDefinition(index, { file, line: 5, column: 35 })).status).toBe("not_found");
        await expectReferenceSites(index, file, sites[0]!, sites, "partial");
        const graph = await buildSymbolGraphDetailed(index);
        expect([...graph.nodes.values()].some((node) => node.name === "p" && node.kind === "class")).toBe(true);
      });
      await expectRename(fixture, filename, "p", sites[0]!, sites, false);
    });
  });
});
