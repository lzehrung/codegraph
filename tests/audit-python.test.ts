import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildProjectIndex } from "../src/indexer.js";
import { buildSymbolGraphDetailed, findReferences, goToDefinition } from "../src/index.js";
import { fileIdentityKey } from "../src/util/paths.js";

/**
 * Regressions for the 2026-09-25 accuracy audit's Python findings:
 * - W14: a class named like its own module (`widget.py` / `Widget`), reached through a package
 *   `__init__.py` re-export plus an aliased import, must not lose its consumers from findReferences.
 * - W15: `import pkg.mod` followed by `pkg.mod.foo()` must navigate and find references like the
 *   equivalent `from pkg import mod` and `import pkg.mod as m` forms already do.
 * - H11: the source-side name in `from a import helper as h` must navigate like the unaliased form.
 * - H12 (Python half): `super().m()` must resolve through a proven base class, same-file or
 *   imported, while an unproven (missing) base stays `not_found`.
 */

async function withFixture(
  prefix: string,
  files: Record<string, string>,
  run: (root: string, f: (rel: string) => string) => Promise<void>,
): Promise<void> {
  const root = (await fsp.mkdtemp(path.join(os.tmpdir(), prefix))).replace(/\\/g, "/");
  try {
    for (const [rel, text] of Object.entries(files)) {
      const target = `${root}/${rel}`;
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, text, "utf8");
    }
    await run(root, (rel: string) => `${root}/${rel}`);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

function columnOf(source: string, line: number, token: string, fromEnd = false): number {
  const text = source.split("\n")[line - 1]!;
  const index = fromEnd ? text.lastIndexOf(token) : text.indexOf(token);
  if (index < 0) throw new Error(`Expected token ${token} on line ${line} of ${JSON.stringify(text)}`);
  return index + 1;
}

describe("W14: class named like its own module through a package re-export", () => {
  const widgetSource = "class Widget:\n    def render(self):\n        return 1\n";
  const initSource = "from .widget import Widget\n";
  const mainSource = "from pkg import Widget as W\n\nW(2).render()\n";
  const decoySource = "class Widget:\n    def render(self):\n        return 999\n";

  it("navigates from the aliased usage site and the import's own source-name token", async () => {
    await withFixture(
      "cg-audit-w14-goto-",
      {
        "pkg/__init__.py": initSource,
        "pkg/widget.py": widgetSource,
        "main.py": mainSource,
        "decoy_pkg/widget.py": decoySource,
      },
      async (_root, f) => {
        const index = await buildProjectIndex(_root, { cache: "off" });

        const sourceNameClick = await goToDefinition(index, {
          file: f("main.py"),
          line: 1,
          column: columnOf(mainSource, 1, "Widget"),
        });
        expect(sourceNameClick.status).toBe("ok");
        if (sourceNameClick.status === "ok") {
          expect(fileIdentityKey(sourceNameClick.definition.file)).toBe(fileIdentityKey(f("pkg/widget.py")));
          expect(sourceNameClick.definition.range.start.line).toBe(1);
        }

        const constructorClick = await goToDefinition(index, {
          file: f("main.py"),
          line: 3,
          column: columnOf(mainSource, 3, "W"),
        });
        expect(constructorClick.status).toBe("ok");
        if (constructorClick.status === "ok") {
          expect(fileIdentityKey(constructorClick.definition.file)).toBe(fileIdentityKey(f("pkg/widget.py")));
        }
      },
    );
  });

  it("reports complete findReferences coverage including every consumer, excluding the decoy", async () => {
    await withFixture(
      "cg-audit-w14-refs-",
      {
        "pkg/__init__.py": initSource,
        "pkg/widget.py": widgetSource,
        "main.py": mainSource,
        "decoy_pkg/widget.py": decoySource,
      },
      async (_root, f) => {
        const index = await buildProjectIndex(_root, { cache: "off" });
        const result = await findReferences(index, {
          file: f("pkg/widget.py"),
          line: 1,
          column: columnOf(widgetSource, 1, "Widget"),
        });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.referenceCoverage.state).toBe("complete");

        const sites = result.references.map((reference) => `${fileIdentityKey(reference.file)}:${reference.range.start.line}`);
        expect(sites).toContain(`${fileIdentityKey(f("pkg/__init__.py"))}:1`);
        expect(sites).toContain(`${fileIdentityKey(f("main.py"))}:1`);
        expect(sites).toContain(`${fileIdentityKey(f("main.py"))}:3`);
        expect(result.references.some((reference) => fileIdentityKey(reference.file) === fileIdentityKey(f("decoy_pkg/widget.py")))).toBe(
          false,
        );
      },
    );
  });

  it("keeps the decoy Widget a distinct detailed-graph node from pkg.widget.Widget", async () => {
    await withFixture(
      "cg-audit-w14-graph-",
      {
        "pkg/__init__.py": initSource,
        "pkg/widget.py": widgetSource,
        "main.py": mainSource,
        "decoy_pkg/widget.py": decoySource,
      },
      async (_root) => {
        const index = await buildProjectIndex(_root, { cache: "off" });
        const graph = await buildSymbolGraphDetailed(index);
        const widgetNodes = [...graph.nodes.values()].filter((node) => node.name === "Widget" && node.kind === "class");
        expect(widgetNodes).toHaveLength(2);
        expect(new Set(widgetNodes.map((node) => fileIdentityKey(node.file))).size).toBe(2);
      },
    );
  });
});

describe("W15: import pkg.mod then pkg.mod.foo()", () => {
  const modSource = "def foo():\n    return 42\n";
  const mainSource = "import pkg.mod\n\npkg.mod.foo()\n";
  const decoySource = "def foo():\n    return -1\n";

  it("navigates the dotted chain to the submodule function, not the decoy", async () => {
    await withFixture(
      "cg-audit-w15-goto-",
      { "pkg/__init__.py": "", "pkg/mod.py": modSource, "main.py": mainSource, "other.py": decoySource },
      async (_root, f) => {
        const index = await buildProjectIndex(_root, { cache: "off" });
        const result = await goToDefinition(index, {
          file: f("main.py"),
          line: 3,
          column: columnOf(mainSource, 3, "foo", true),
        });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(f("pkg/mod.py")));
        expect(result.definition.range.start.line).toBe(1);
      },
    );
  });

  it("finds the dotted-chain usage in findReferences with complete coverage, excluding the decoy", async () => {
    await withFixture(
      "cg-audit-w15-refs-",
      { "pkg/__init__.py": "", "pkg/mod.py": modSource, "main.py": mainSource, "other.py": decoySource },
      async (_root, f) => {
        const index = await buildProjectIndex(_root, { cache: "off" });
        const result = await findReferences(index, {
          file: f("pkg/mod.py"),
          line: 1,
          column: columnOf(modSource, 1, "foo"),
        });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.referenceCoverage.state).toBe("complete");
        const sites = result.references.map((reference) => `${fileIdentityKey(reference.file)}:${reference.range.start.line}`);
        expect(sites).toContain(`${fileIdentityKey(f("main.py"))}:3`);
        expect(result.references.some((reference) => fileIdentityKey(reference.file) === fileIdentityKey(f("other.py")))).toBe(false);
      },
    );
  });

  it("keeps the equivalent from-import and aliased dotted-import forms working (no regression)", async () => {
    const fromImportMain = "from pkg import mod\n\nmod.foo()\n";
    const aliasedMain = "import pkg.mod as m\n\nm.foo()\n";
    await withFixture(
      "cg-audit-w15-controls-",
      {
        "pkg/__init__.py": "",
        "pkg/mod.py": modSource,
        "from_import.py": fromImportMain,
        "aliased.py": aliasedMain,
      },
      async (_root, f) => {
        const index = await buildProjectIndex(_root, { cache: "off" });
        const result = await findReferences(index, {
          file: f("pkg/mod.py"),
          line: 1,
          column: columnOf(modSource, 1, "foo"),
        });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.referenceCoverage.state).toBe("complete");
        const sites = result.references.map((reference) => `${fileIdentityKey(reference.file)}:${reference.range.start.line}`);
        expect(sites).toContain(`${fileIdentityKey(f("from_import.py"))}:3`);
        expect(sites).toContain(`${fileIdentityKey(f("aliased.py"))}:3`);
      },
    );
  });
});

describe("H11: source-side name in an aliased Python import", () => {
  const aSource = "def helper():\n    return 1\n";
  const bSource = "from a import helper as helper_alias\n\nresult = helper_alias()\n";
  const decoySource = "def helper():\n    return -1\n";

  it("navigates the source-name token to the real definition, not the decoy", async () => {
    await withFixture(
      "cg-audit-h11-goto-",
      { "a.py": aSource, "b.py": bSource, "decoy.py": decoySource },
      async (_root, f) => {
        const index = await buildProjectIndex(_root, { cache: "off" });
        const sourceNameClick = await goToDefinition(index, {
          file: f("b.py"),
          line: 1,
          column: columnOf(bSource, 1, "helper"),
        });
        expect(sourceNameClick.status).toBe("ok");
        if (sourceNameClick.status === "ok") {
          expect(fileIdentityKey(sourceNameClick.definition.file)).toBe(fileIdentityKey(f("a.py")));
          expect(sourceNameClick.definition.range.start.line).toBe(1);
        }

        const aliasClick = await goToDefinition(index, {
          file: f("b.py"),
          line: 3,
          column: columnOf(bSource, 3, "helper_alias"),
        });
        expect(aliasClick.status).toBe("ok");
        if (aliasClick.status === "ok") {
          expect(fileIdentityKey(aliasClick.definition.file)).toBe(fileIdentityKey(f("a.py")));
        }
      },
    );
  });

  it("includes both the source-name and alias tokens in findReferences, excluding the decoy", async () => {
    await withFixture(
      "cg-audit-h11-refs-",
      { "a.py": aSource, "b.py": bSource, "decoy.py": decoySource },
      async (_root, f) => {
        const index = await buildProjectIndex(_root, { cache: "off" });
        const result = await findReferences(index, { file: f("a.py"), line: 1, column: columnOf(aSource, 1, "helper") });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.referenceCoverage.state).toBe("complete");
        const bFileSites = result.references
          .filter((reference) => fileIdentityKey(reference.file) === fileIdentityKey(f("b.py")))
          .map((reference) => reference.range.start.column);
        expect(bFileSites).toContain(columnOf(bSource, 1, "helper"));
        expect(bFileSites).toContain(columnOf(bSource, 1, "helper_alias"));
        expect(result.references.some((reference) => fileIdentityKey(reference.file) === fileIdentityKey(f("decoy.py")))).toBe(false);
      },
    );
  });
});

describe("H12 (Python): super() through a proven base class", () => {
  it("resolves a same-file super() call to the base member, not an unrelated same-named decoy", async () => {
    const source = [
      "class Unrelated:",
      "    def greet(self):",
      "        return 99",
      "",
      "class Base:",
      "    def greet(self):",
      "        return 1",
      "",
      "class Derived(Base):",
      "    def greet(self):",
      "        return super().greet()",
      "",
    ].join("\n");
    await withFixture("cg-audit-h12-samefile-", { "app.py": source }, async (_root, f) => {
      const index = await buildProjectIndex(_root, { cache: "off" });
      const result = await goToDefinition(index, {
        file: f("app.py"),
        line: 11,
        column: columnOf(source, 11, "greet", true),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.definition.range.start.line).toBe(6);

      const graph = await buildSymbolGraphDetailed(index);
      const ownerId = (className: string): string => {
        const owner = [...graph.nodes.values()].find((node) => node.name === className && node.kind === "class");
        expect(owner, `expected a ${className} class node`).toBeDefined();
        return owner!.id;
      };
      const memberNamed = (ownerName: string, memberName: string): string => {
        const owner = ownerId(ownerName);
        const member = graph.edges.find(
          (edge) =>
            edge.label === "member_of" &&
            edge.to === owner &&
            graph.nodes.get(edge.from)?.name === memberName &&
            graph.nodes.get(edge.from)?.kind === "function",
        );
        expect(member, `expected ${ownerName}.${memberName} member_of edge`).toBeDefined();
        return member!.from;
      };
      const derivedGreet = memberNamed("Derived", "greet");
      const baseGreet = memberNamed("Base", "greet");
      const unrelatedGreet = memberNamed("Unrelated", "greet");
      const callsFromDerived = graph.edges.filter((edge) => edge.label === "calls" && edge.from === derivedGreet);
      expect(callsFromDerived.map((edge) => edge.to)).toEqual([baseGreet]);
      expect(callsFromDerived.map((edge) => edge.to)).not.toContain(unrelatedGreet);
    });
  });

  it("resolves a cross-file super() call to an imported base member", async () => {
    const baseSource = "class Base:\n    def greet(self):\n        return 1\n";
    const derivedSource = "from base import Base\n\nclass Derived(Base):\n    def greet(self):\n        return super().greet()\n";
    await withFixture(
      "cg-audit-h12-crossfile-",
      { "base.py": baseSource, "derived.py": derivedSource },
      async (_root, f) => {
        const index = await buildProjectIndex(_root, { cache: "off" });
        const result = await goToDefinition(index, {
          file: f("derived.py"),
          line: 5,
          column: columnOf(derivedSource, 5, "greet", true),
        });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(f("base.py")));
        expect(result.definition.range.start.line).toBe(2);

        const refs = await findReferences(index, {
          file: f("base.py"),
          line: 2,
          column: columnOf(baseSource, 2, "greet"),
        });
        expect(refs.status).toBe("ok");
        if (refs.status !== "ok") return;
        expect(refs.referenceCoverage.state).toBe("complete");
        expect(
          refs.references.some(
            (reference) => fileIdentityKey(reference.file) === fileIdentityKey(f("derived.py")) && reference.range.start.line === 5,
          ),
        ).toBe(true);
      },
    );
  });

  it("keeps super() unresolved when the enclosing class has no base at all", async () => {
    const source = "class Standalone:\n    def greet(self):\n        return super().greet()\n";
    await withFixture("cg-audit-h12-unproven-", { "app.py": source }, async (_root, f) => {
      const index = await buildProjectIndex(_root, { cache: "off" });
      const result = await goToDefinition(index, {
        file: f("app.py"),
        line: 3,
        column: columnOf(source, 3, "greet", true),
      });
      expect(result.status).toBe("not_found");

      const graph = await buildSymbolGraphDetailed(index);
      const standaloneGreet = [...graph.nodes.values()].find((node) => node.name === "greet");
      expect(standaloneGreet).toBeDefined();
      expect(graph.edges.filter((edge) => edge.label === "calls" && edge.from === standaloneGreet!.id)).toHaveLength(0);
    });
  });
});
