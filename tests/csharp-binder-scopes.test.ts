import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatAgentSymbolHandle } from "../src/agent/handles.js";
import { previewRenameWithSession } from "../src/agent/rename-preview.js";
import { createAgentSession } from "../src/agent/session.js";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  buildSymbolGraphDetailed,
  findReferences,
  goToDefinition,
  type ProjectIndex,
} from "../src/index.js";
import { clearMemoryCache, closeDiskCacheDatabase } from "../src/indexer/build-cache.js";
import { fileIdentityKey } from "../src/util/paths.js";
import { CSHARP_BINDER_SOURCE, CSHARP_BINDERS } from "./helpers/csharp-binder-fixture.js";
import { eachIndexMode, withBatch3Fixture } from "./helpers/csharp-java-batch3-fixture.js";

const SOURCES = { "Binders.cs": CSHARP_BINDER_SOURCE };
const positionKey = ([line, column]: readonly [number, number]): string => `${line}:${column}`;

describe("C# lexical binder consumers", () => {
  it("keeps Roslyn's field, parameter, local, pattern, and query bindings separate", async () => {
    await withBatch3Fixture("cg-csharp-binder-consumers-", SOURCES, async (fixture) => {
      const file = fixture.files["Binders.cs"]!;
      await eachIndexMode(fixture, async (index) => {
        expect(index.byFile.get(fileIdentityKey(file))?.parseErrorRanges).toEqual([]);
        for (const { declaration, uses } of CSHARP_BINDERS) {
          const [line, column] = declaration;
          for (const [useLine, useColumn] of uses) {
            const goto = await goToDefinition(index, { file, line: useLine, column: useColumn });
            expect(goto.status, `${useLine}:${useColumn}`).toBe("ok");
            if (goto.status === "ok") {
              expect([goto.definition.range.start.line, goto.definition.range.start.column]).toEqual(declaration);
            }
          }
          const refs = await findReferences(index, { file, line, column });
          expect(refs.status, `${line}:${column}`).toBe("ok");
          if (refs.status !== "ok") continue;
          expect(refs.referenceCoverage.state, `${line}:${column}`).toBe("complete");
          expect(refs.references.map((ref) => `${ref.range.start.line}:${ref.range.start.column}`).sort()).toEqual(
            [declaration, ...uses].map(positionKey).sort(),
          );
        }
        const ordinaryForeach = await goToDefinition(index, { file, line: 77, column: 89 });
        expect(ordinaryForeach.status).toBe("ok");
        if (ordinaryForeach.status === "ok") {
          expect([ordinaryForeach.definition.range.start.line, ordinaryForeach.definition.range.start.column]).toEqual([
            77, 56,
          ]);
        }
        const graph = await buildSymbolGraphDetailed(index);
        const edges = graph.edges
          .filter((edge) => edge.label === "calls" || edge.label === "references" || edge.label === "instantiates")
          .map((edge) => [
            edge.label,
            graph.nodes.get(edge.from)?.name,
            graph.nodes.get(edge.to)?.name,
            edge.site?.range.start.line,
            edge.site?.range.start.column,
          ]);
        expect(edges).toEqual([["calls", "Anonymous", "f", 12, 12]]);
      });
    });
  });

  it("previews only Roslyn-bound edits and leaves unindexed binders unavailable", async () => {
    await withBatch3Fixture("cg-csharp-binder-renames-", SOURCES, async (fixture) => {
      const session = createAgentSession({
        root: fixture.root,
        buildOptions: { cache: "off", threads: 1 },
        freshness: { policy: "check" },
      });
      try {
        for (const { declaration, uses, name, unindexed } of CSHARP_BINDERS) {
          const [line, column] = declaration;
          const handle = formatAgentSymbolHandle({ file: "Binders.cs", name: name ?? "p", line, column });
          if (unindexed) {
            await expect(
              previewRenameWithSession(session, { root: fixture.root, handle, newName: "Renamed" }),
            ).rejects.toThrow("Symbol handle is stale or missing");
            continue;
          }
          const preview = await previewRenameWithSession(session, { root: fixture.root, handle, newName: "Renamed" });
          expect(preview.safe, `${line}:${column}`).toBe(true);
          expect(preview.edits.map((edit) => `${edit.range.start.line}:${edit.range.start.column}`).sort()).toEqual(
            [declaration, ...uses].map(positionKey).sort(),
          );
        }
      } finally {
        session.invalidate();
      }
    });
  });

  it("keeps unparsed slice names out of outer references and unsafe rename edits", async () => {
    // Roslyn binds each slice p to its own local; the pinned grammar reports ERROR nodes.
    const cases = [
      {
        file: "SliceConditional.cs",
        source: `public class SliceConditional {
  private int p = 4;
  private int other = 3;
  public int Direct() => p + other;
  public int Conditional(int[] input) => input is [1, .. var p] ? p.Length : this.p;
  public int Unrelated() => other;
}
`,
        declaration: [2, 15],
        blocked: [
          [5, 62],
          [5, 67],
        ],
        expected: [
          [2, 15],
          [4, 26],
          [5, 83],
        ],
        preserved: [5, 83],
      },
      {
        file: "SliceComments.cs",
        source: `public class SliceComments {
  private int p = 4;
  public int Direct() => p;
  public int Conditional(int[] input) => input is [1, .. var /* comment */ @p] ? @p.Length : this.p;
}
`,
        declaration: [2, 15],
        blocked: [
          [4, 76],
          [4, 82],
        ],
        expected: [
          [2, 15],
          [3, 26],
          [4, 99],
        ],
        preserved: [4, 99],
      },
      {
        file: "SliceSwitch.cs",
        source: `public class SliceSwitch {
  private int p = 4;
  public int Direct() => p;
  public int Switch(int[] input) {
    switch (input) {
      case [1, .. var p] when p.Length > 0: return p.Length;
      default: return p;
    }
  }
}
`,
        declaration: [2, 15],
        blocked: [
          [6, 23],
          [6, 52],
        ],
        expected: [
          [2, 15],
          [3, 26],
        ],
        preserved: [3, 26],
      },
      {
        file: "Slice.cs",
        source: `using System;
public class Slice {
  private int p = 4;
  public int Direct() => p;
  public int Conditional(int[] input) => input is [1, .. var p] ? p.Length : this.p;
  public int Branch(int[] input) {
    if (input is [1, .. var p]) return p.Length;
    return this.p;
  }
  public int Switch(int[] input) {
    switch (input) {
      case [1, .. var p] when p.Length > 0: return p.Length;
      default: return p;
    }
  }
  public int Arm(int[] input) => input switch { [1, .. var p] => p.Length, _ => p };
}
`,
        declaration: [3, 15],
        blocked: [
          [5, 62],
          [5, 67],
          [12, 23],
        ],
        expected: [
          [3, 15],
          [4, 26],
        ],
        preserved: [4, 26],
      },
    ] as const;
    for (const testCase of cases) {
      const sources = { [testCase.file]: testCase.source };
      await withBatch3Fixture("cg-csharp-slice-error-", sources, async (fixture) => {
        const file = fixture.files[testCase.file]!;
        await eachIndexMode(fixture, async (index) => {
          expect(index.byFile.get(fileIdentityKey(file))?.parseErrorRanges?.length).toBeGreaterThan(0);
          for (const [line, column] of testCase.blocked) {
            expect((await goToDefinition(index, { file, line, column })).status).toBe("not_found");
          }
          const [line, column] = testCase.declaration;
          const preserved = await goToDefinition(index, {
            file,
            line: testCase.preserved[0],
            column: testCase.preserved[1],
          });
          expect(preserved.status, testCase.file).toBe("ok");
          if (preserved.status === "ok") {
            expect([preserved.definition.range.start.line, preserved.definition.range.start.column]).toEqual(
              testCase.declaration,
            );
          }
          const refs = await findReferences(index, { file, line, column });
          expect(refs.status).toBe("ok");
          if (refs.status !== "ok") return;
          expect(refs.referenceCoverage.state).toBe("partial");
          expect(refs.references.map((ref) => `${ref.range.start.line}:${ref.range.start.column}`).sort()).toEqual(
            testCase.expected.map(positionKey).sort(),
          );
        });
        const session = createAgentSession({
          root: fixture.root,
          buildOptions: { cache: "off", threads: 1 },
          freshness: { policy: "check" },
        });
        try {
          const [line, column] = testCase.declaration;
          const handle = formatAgentSymbolHandle({ file: testCase.file, name: "p", line, column });
          const preview = await previewRenameWithSession(session, { root: fixture.root, handle, newName: "Renamed" });
          expect(preview.safe).toBe(false);
          expect(preview.edits.map((edit) => `${edit.range.start.line}:${edit.range.start.column}`).sort()).toEqual(
            testCase.expected.map(positionKey).sort(),
          );
        } finally {
          session.invalidate();
        }
      });
    }
  });

  it("retains existing parse-error coverage for an unrelated field", async () => {
    const sources = {
      "Slice.cs": "class Slice { int p; int F(int[] a) => a is [1, .. var p] ? p.Length : this.p; }\n",
      "Control.cs": "class Control {\n  int untouched = 1;\n  int Read() => untouched;\n}\n",
    };
    await withBatch3Fixture("cg-csharp-slice-control-", sources, async (fixture) => {
      const file = fixture.files["Control.cs"]!;
      const index = await buildProjectIndex(fixture.root, { cache: "off", threads: 1 });
      const refs = await findReferences(index, { file, line: 2, column: 7 });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") return;
      // Main already reports parse_error across C# member candidates in another file.
      expect(refs.referenceCoverage.state).toBe("partial");
      expect(refs.references.map((ref) => [ref.range.start.line, ref.range.start.column])).toEqual([
        [2, 7],
        [3, 17],
      ]);
      const session = createAgentSession({
        root: fixture.root,
        buildOptions: { cache: "off", threads: 1 },
        freshness: { policy: "check" },
      });
      try {
        const handle = formatAgentSymbolHandle({ file: "Control.cs", name: "untouched", line: 2, column: 7 });
        const preview = await previewRenameWithSession(session, { root: fixture.root, handle, newName: "Renamed" });
        expect(preview.safe).toBe(false);
        expect(preview.edits.map((edit) => [edit.range.start.line, edit.range.start.column])).toEqual([
          [2, 7],
          [3, 17],
        ]);
      } finally {
        session.invalidate();
      }
    });
  });

  it("keeps tuple and positional pattern variables separate from the outer field", async () => {
    const sources = {
      "Patterns.cs": `public record Pair(int X, int Y);
public class Patterns {
  private int p = 5;
  public int Direct() => p;
  public int Tuple((int, int) value) => value is (var p, var q) ? p + q : this.p;
  public int Typed((int, int) value) => value is (int p, int q) ? p + q : this.p;
  public int Positional(object value) => value is Pair(var p, var q) ? p + q : this.p;
  public int Property(object value) => value is Pair { X: var p } ? p : this.p;
}
`,
    };
    await withBatch3Fixture("cg-csharp-positional-pattern-", sources, async (fixture) => {
      const file = fixture.files["Patterns.cs"]!;
      const rows = [
        [5, 55, 67],
        [6, 55, 67],
        [7, 60, 72],
        [8, 63, 69],
      ] as const;
      await eachIndexMode(fixture, async (index) => {
        expect(index.byFile.get(fileIdentityKey(file))?.parseErrorRanges).toEqual([]);
        for (const [line, declaration, use] of rows) {
          const goto = await goToDefinition(index, { file, line, column: use });
          expect(goto.status).toBe("ok");
          if (goto.status === "ok") {
            expect([goto.definition.range.start.line, goto.definition.range.start.column]).toEqual([line, declaration]);
          }
          const refs = await findReferences(index, { file, line, column: declaration });
          expect(refs.status).toBe("ok");
          if (refs.status === "ok") {
            expect(refs.referenceCoverage.state).toBe("complete");
            expect(refs.references.map((ref) => ref.range.start.column)).toEqual([declaration, use]);
          }
        }
        const field = await findReferences(index, { file, line: 3, column: 15 });
        expect(field.status).toBe("ok");
        if (field.status === "ok") {
          expect(field.referenceCoverage.state).toBe("partial");
          expect(field.references.map((ref) => [ref.range.start.line, ref.range.start.column])).toEqual([
            [3, 15],
            [4, 26],
          ]);
        }
      });
      const session = createAgentSession({
        root: fixture.root,
        buildOptions: { cache: "off", threads: 1 },
        freshness: { policy: "check" },
      });
      try {
        for (const [line, column, use] of rows) {
          const handle = formatAgentSymbolHandle({ file: "Patterns.cs", name: "p", line, column });
          const preview = await previewRenameWithSession(session, { root: fixture.root, handle, newName: "Renamed" });
          expect(preview.safe).toBe(true);
          expect(preview.edits.map((edit) => edit.range.start.column)).toEqual([column, use]);
        }
        const handle = formatAgentSymbolHandle({ file: "Patterns.cs", name: "p", line: 3, column: 15 });
        const preview = await previewRenameWithSession(session, { root: fixture.root, handle, newName: "Renamed" });
        expect(preview.safe).toBe(false);
      } finally {
        session.invalidate();
      }
    });
  });

  it("keeps cold and reopened answers equal through edits, renames, deletion, and restoration", async () => {
    await withBatch3Fixture("cg-csharp-binder-cache-", SOURCES, async (fixture) => {
      const original = fixture.files["Binders.cs"]!;
      const renamed = path.join(fixture.root, "Renamed.cs");
      let file = original;
      let deleted = false;
      const describeIndex = async (index: ProjectIndex): Promise<unknown> => {
        if (deleted) return index.byFile.has(fileIdentityKey(file));
        const results = [];
        for (const row of [CSHARP_BINDERS[0]!, CSHARP_BINDERS[1]!, CSHARP_BINDERS[9]!, CSHARP_BINDERS[19]!]) {
          const [line, column] = row.declaration;
          const refs = await findReferences(index, { file, line, column });
          const [useLine, useColumn] = row.uses[0]!;
          const goto = await goToDefinition(index, { file, line: useLine, column: useColumn });
          results.push({
            goto:
              goto.status === "ok"
                ? [goto.definition.range.start.line, goto.definition.range.start.column]
                : goto.status,
            coverage: refs.status === "ok" ? refs.referenceCoverage.state : refs.status,
            refs:
              refs.status === "ok" ? refs.references.map((ref) => [ref.range.start.line, ref.range.start.column]) : [],
          });
        }
        const graph = await buildSymbolGraphDetailed(index);
        return {
          results,
          edges: graph.edges.map((edge) => [
            edge.label,
            graph.nodes.get(edge.from)?.name,
            graph.nodes.get(edge.to)?.name,
          ]),
        };
      };
      const check = async (): Promise<void> => {
        const cold = await buildProjectIndex(fixture.root, { cache: "off", threads: 1 });
        const warm = await buildProjectIndexIncremental(fixture.root, { cache: "disk", threads: 1 });
        clearMemoryCache();
        closeDiskCacheDatabase(fixture.root);
        const reopened = await buildProjectIndex(fixture.root, { cache: "disk", threads: 1 });
        const expected = await describeIndex(cold);
        expect(await describeIndex(warm)).toEqual(expected);
        expect(await describeIndex(reopened)).toEqual(expected);
      };
      try {
        await check();
        await fsp.writeFile(file, `${CSHARP_BINDER_SOURCE}// edit\n`);
        await check();
        await fsp.rename(original, renamed);
        file = renamed;
        await check();
        await fsp.rename(renamed, original);
        file = original;
        await check();
        await fsp.rm(file);
        deleted = true;
        await check();
        await fsp.writeFile(file, CSHARP_BINDER_SOURCE);
        deleted = false;
        await check();
      } finally {
        clearMemoryCache();
        closeDiskCacheDatabase(fixture.root);
      }
    });
  });
});
