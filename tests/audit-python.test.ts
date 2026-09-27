import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildProjectIndex, buildProjectIndexIncremental } from "../src/indexer.js";
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

        const sites = result.references.map(
          (reference) => `${fileIdentityKey(reference.file)}:${reference.range.start.line}`,
        );
        expect(sites).toContain(`${fileIdentityKey(f("pkg/__init__.py"))}:1`);
        expect(sites).toContain(`${fileIdentityKey(f("main.py"))}:1`);
        expect(sites).toContain(`${fileIdentityKey(f("main.py"))}:3`);
        expect(
          result.references.some(
            (reference) => fileIdentityKey(reference.file) === fileIdentityKey(f("decoy_pkg/widget.py")),
          ),
        ).toBe(false);
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
        const sites = result.references.map(
          (reference) => `${fileIdentityKey(reference.file)}:${reference.range.start.line}`,
        );
        expect(sites).toContain(`${fileIdentityKey(f("main.py"))}:3`);
        expect(
          result.references.some((reference) => fileIdentityKey(reference.file) === fileIdentityKey(f("other.py"))),
        ).toBe(false);
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
        const sites = result.references.map(
          (reference) => `${fileIdentityKey(reference.file)}:${reference.range.start.line}`,
        );
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
        const result = await findReferences(index, {
          file: f("a.py"),
          line: 1,
          column: columnOf(aSource, 1, "helper"),
        });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;
        expect(result.referenceCoverage.state).toBe("complete");
        const bFileSites = result.references
          .filter((reference) => fileIdentityKey(reference.file) === fileIdentityKey(f("b.py")))
          .map((reference) => reference.range.start.column);
        expect(bFileSites).toContain(columnOf(bSource, 1, "helper"));
        expect(bFileSites).toContain(columnOf(bSource, 1, "helper_alias"));
        expect(
          result.references.some((reference) => fileIdentityKey(reference.file) === fileIdentityKey(f("decoy.py"))),
        ).toBe(false);
      },
    );
  });

  it("never resolves the aliased import's source spelling as a bare, unbound identifier elsewhere in the file", async () => {
    // `from a import helper as h` binds only `h`; a bare `helper()` anywhere else in the file is
    // unbound (a NameError at runtime) and must stay not_found, even though `helper` is exactly
    // the import's own source-side spelling.
    const source = "from a import helper as h\n\nh()\nhelper()\n";
    await withFixture("cg-audit-h11-unbound-", { "a.py": aSource, "b.py": source }, async (_root, f) => {
      const index = await buildProjectIndex(_root, { cache: "off" });
      const importToken = await goToDefinition(index, {
        file: f("b.py"),
        line: 1,
        column: columnOf(source, 1, "helper"),
      });
      expect(importToken.status).toBe("ok");
      const aliasUse = await goToDefinition(index, { file: f("b.py"), line: 3, column: columnOf(source, 3, "h") });
      expect(aliasUse.status).toBe("ok");
      const unboundUse = await goToDefinition(index, {
        file: f("b.py"),
        line: 4,
        column: columnOf(source, 4, "helper"),
      });
      expect(unboundUse.status).toBe("not_found");

      const refs = await findReferences(index, { file: f("a.py"), line: 1, column: columnOf(aSource, 1, "helper") });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") return;
      expect(
        refs.references.some(
          (reference) =>
            fileIdentityKey(reference.file) === fileIdentityKey(f("b.py")) && reference.range.start.line === 4,
        ),
      ).toBe(false);
    });
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
    const derivedSource =
      "from base import Base\n\nclass Derived(Base):\n    def greet(self):\n        return super().greet()\n";
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
            (reference) =>
              fileIdentityKey(reference.file) === fileIdentityKey(f("derived.py")) && reference.range.start.line === 5,
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

describe("Python import rebinding in member resolution", () => {
  it("uses the last explicit named import for a static member and excludes the shadowed member", async () => {
    const aSource = "class Thing:\n    @staticmethod\n    def hit():\n        return 'a'\n";
    const bSource = "class Thing:\n    @staticmethod\n    def hit():\n        return 'b'\n";
    const mainSource = "from a import Thing\nfrom b import Thing\n\nThing.hit()\n";
    await withFixture(
      "cg-audit-python-explicit-rebinding-",
      { "a.py": aSource, "b.py": bSource, "main.py": mainSource },
      async (_root, f) => {
        const index = await buildProjectIndex(_root, { cache: "off" });
        const goto = await goToDefinition(index, {
          file: f("main.py"),
          line: 4,
          column: columnOf(mainSource, 4, "hit"),
        });
        expect(goto.status).toBe("ok");
        if (goto.status === "ok") expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(f("b.py")));

        const bReferences = await findReferences(index, {
          file: f("b.py"),
          line: 3,
          column: columnOf(bSource, 3, "hit"),
        });
        expect(bReferences.status).toBe("ok");
        if (bReferences.status === "ok") {
          expect(bReferences.referenceCoverage.state).toBe("complete");
          expect(
            bReferences.references.some(
              (reference) =>
                fileIdentityKey(reference.file) === fileIdentityKey(f("main.py")) && reference.range.start.line === 4,
            ),
          ).toBe(true);
        }

        const aReferences = await findReferences(index, {
          file: f("a.py"),
          line: 3,
          column: columnOf(aSource, 3, "hit"),
        });
        expect(aReferences.status).toBe("ok");
        if (aReferences.status === "ok") {
          expect(
            aReferences.references.some(
              (reference) =>
                fileIdentityKey(reference.file) === fileIdentityKey(f("main.py")) && reference.range.start.line === 4,
            ),
          ).toBe(false);
        }
      },
    );
  });

  it("uses the last namespace alias for a member and excludes the shadowed module", async () => {
    const aSource = "def hit():\n    return 'a'\n";
    const bSource = "def hit():\n    return 'b'\n";
    const mainSource = "import a as x\nimport b as x\n\nx.hit()\n";
    await withFixture(
      "cg-audit-python-namespace-rebinding-",
      { "a.py": aSource, "b.py": bSource, "main.py": mainSource },
      async (_root, f) => {
        const index = await buildProjectIndex(_root, { cache: "off" });
        const goto = await goToDefinition(index, {
          file: f("main.py"),
          line: 4,
          column: columnOf(mainSource, 4, "hit"),
        });
        expect(goto.status).toBe("ok");
        if (goto.status === "ok") expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(f("b.py")));

        const bReferences = await findReferences(index, {
          file: f("b.py"),
          line: 1,
          column: columnOf(bSource, 1, "hit"),
        });
        expect(bReferences.status).toBe("ok");
        if (bReferences.status === "ok") {
          expect(bReferences.referenceCoverage.state).toBe("complete");
          expect(
            bReferences.references.some(
              (reference) =>
                fileIdentityKey(reference.file) === fileIdentityKey(f("main.py")) && reference.range.start.line === 4,
            ),
          ).toBe(true);
        }

        const aReferences = await findReferences(index, {
          file: f("a.py"),
          line: 1,
          column: columnOf(aSource, 1, "hit"),
        });
        expect(aReferences.status).toBe("ok");
        if (aReferences.status === "ok") {
          expect(
            aReferences.references.some(
              (reference) =>
                fileIdentityKey(reference.file) === fileIdentityKey(f("main.py")) && reference.range.start.line === 4,
            ),
          ).toBe(false);
        }
      },
    );
  });

  it("uses the last star-imported namespace for a member and excludes the shadowed submodule", async () => {
    const initSource = "from . import mod\n\n__all__ = ['mod']\n";
    const aModSource = "def hit():\n    return 'a'\n";
    const bModSource = "def hit():\n    return 'b'\n";
    const mainSource = "from a import *\nfrom b import *\n\nmod.hit()\n";
    await withFixture(
      "cg-audit-python-star-namespace-rebinding-",
      {
        "a/__init__.py": initSource,
        "a/mod.py": aModSource,
        "b/__init__.py": initSource,
        "b/mod.py": bModSource,
        "main.py": mainSource,
      },
      async (_root, f) => {
        const index = await buildProjectIndex(_root, { cache: "off" });
        const goto = await goToDefinition(index, {
          file: f("main.py"),
          line: 4,
          column: columnOf(mainSource, 4, "hit"),
        });
        expect(goto.status).toBe("ok");
        if (goto.status === "ok") expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(f("b/mod.py")));

        const bReferences = await findReferences(index, {
          file: f("b/mod.py"),
          line: 1,
          column: columnOf(bModSource, 1, "hit"),
        });
        expect(bReferences.status).toBe("ok");
        if (bReferences.status === "ok") {
          expect(bReferences.referenceCoverage.state).toBe("complete");
          expect(
            bReferences.references.some(
              (reference) =>
                fileIdentityKey(reference.file) === fileIdentityKey(f("main.py")) && reference.range.start.line === 4,
            ),
          ).toBe(true);
        }

        const aReferences = await findReferences(index, {
          file: f("a/mod.py"),
          line: 1,
          column: columnOf(aModSource, 1, "hit"),
        });
        expect(aReferences.status).toBe("ok");
        if (aReferences.status === "ok") {
          expect(
            aReferences.references.some(
              (reference) =>
                fileIdentityKey(reference.file) === fileIdentityKey(f("main.py")) && reference.range.start.line === 4,
            ),
          ).toBe(false);
        }
      },
    );
  });

  it("uses the last imported base for inherited member lookup and excludes the shadowed base member", async () => {
    const aSource = "class Base:\n    def hit(self):\n        return 'a'\n";
    const bSource = "class Base:\n    def hit(self):\n        return 'b'\n";
    const mainSource = [
      "from a import Base",
      "from b import Base",
      "",
      "class Child(Base):",
      "    def call(self):",
      "        return super().hit()",
      "",
    ].join("\n");
    await withFixture(
      "cg-audit-python-inherited-rebinding-",
      { "a.py": aSource, "b.py": bSource, "main.py": mainSource },
      async (_root, f) => {
        const index = await buildProjectIndex(_root, { cache: "off" });
        const goto = await goToDefinition(index, {
          file: f("main.py"),
          line: 6,
          column: columnOf(mainSource, 6, "hit"),
        });
        expect(goto.status).toBe("ok");
        if (goto.status === "ok") expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(f("b.py")));

        const bReferences = await findReferences(index, {
          file: f("b.py"),
          line: 2,
          column: columnOf(bSource, 2, "hit"),
        });
        expect(bReferences.status).toBe("ok");
        if (bReferences.status === "ok") {
          expect(bReferences.referenceCoverage.state).toBe("complete");
          expect(
            bReferences.references.some(
              (reference) =>
                fileIdentityKey(reference.file) === fileIdentityKey(f("main.py")) && reference.range.start.line === 6,
            ),
          ).toBe(true);
        }

        const aReferences = await findReferences(index, {
          file: f("a.py"),
          line: 2,
          column: columnOf(aSource, 2, "hit"),
        });
        expect(aReferences.status).toBe("ok");
        if (aReferences.status === "ok") {
          expect(
            aReferences.references.some(
              (reference) =>
                fileIdentityKey(reference.file) === fileIdentityKey(f("main.py")) && reference.range.start.line === 6,
            ),
          ).toBe(false);
        }
      },
    );
  });
});

describe("Python package attributes before submodules", () => {
  const mainSource = "from pkg import name\n\ndef run():\n    return name()\n";
  const relativeSource = "from . import name\n\ndef use():\n    return name()\n";
  const initSource = "def name():\n    return 1\n";
  const submoduleSource = "def name():\n    return 2\n";

  it("resolves the package function over a same-named submodule for navigation, references, and calls", async () => {
    await withFixture(
      "cg-audit-py-attribute-",
      {
        "pkg/__init__.py": initSource,
        "pkg/name.py": submoduleSource,
        "pkg/user.py": relativeSource,
        "main.py": mainSource,
      },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        for (const [file, source] of [
          ["main.py", mainSource],
          ["pkg/user.py", relativeSource],
        ] as const) {
          expect(index.byFile.get(fileIdentityKey(f(file)))?.imports).toMatchObject([
            { kind: "named", resolved: f("pkg/__init__.py") },
          ]);
          for (const line of [1, 4]) {
            const goto = await goToDefinition(index, {
              file: f(file),
              line,
              column: columnOf(source, line, "name"),
            });
            expect(goto.status).toBe("ok");
            if (goto.status === "ok") {
              expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(f("pkg/__init__.py")));
              expect(goto.definition.range.start.line).toBe(1);
            }
          }
        }
        const refs = await findReferences(index, {
          file: f("pkg/__init__.py"),
          line: 1,
          column: columnOf(initSource, 1, "name"),
        });
        expect(refs.status).toBe("ok");
        if (refs.status === "ok") {
          expect(refs.referenceCoverage.state).toBe("complete");
          for (const file of ["main.py", "pkg/user.py"]) {
            expect(
              refs.references
                .filter((ref) => fileIdentityKey(ref.file) === fileIdentityKey(f(file)))
                .map((ref) => ref.range.start.line)
                .sort(),
            ).toEqual([1, 4]);
          }
          expect(refs.references.some((ref) => fileIdentityKey(ref.file) === fileIdentityKey(f("pkg/name.py")))).toBe(
            false,
          );
        }
        const graph = await buildSymbolGraphDetailed(index);
        for (const [file, functionName] of [
          ["main.py", "run"],
          ["pkg/user.py", "use"],
        ] as const) {
          const owner = [...graph.nodes.values()].find(
            (node) => node.name === functionName && fileIdentityKey(node.file) === fileIdentityKey(f(file)),
          );
          const calls = graph.edges.filter((edge) => edge.label === "calls" && edge.from === owner?.id);
          expect(calls.map((edge) => fileIdentityKey(graph.nodes.get(edge.to)!.file))).toEqual([
            fileIdentityKey(f("pkg/__init__.py")),
          ]);
        }
      },
    );
  });

  it.each([
    ["no package attribute", ""],
    ["nested function is not a package attribute", "def outer():\n    def name():\n        pass\n"],
    ["relative import of the submodule", initSource + "from . import name\n"],
    ["relative import through the submodule", initSource + "from .name import value\n"],
    ["absolute import of the submodule", initSource + "import pkg.name\n"],
  ])("keeps %s bound to the submodule", async (_label, packageSource) => {
    const source = "from pkg import name\n\ndef run():\n    return name.value()\n";
    await withFixture(
      "cg-audit-py-submodule-control-",
      { "pkg/__init__.py": packageSource, "pkg/name.py": "def value():\n    return 2\n", "main.py": source },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        expect(index.byFile.get(fileIdentityKey(f("main.py")))?.imports).toMatchObject([
          { kind: "namespace", resolved: f("pkg/name.py") },
        ]);
        const goto = await goToDefinition(index, {
          file: f("main.py"),
          line: 4,
          column: columnOf(source, 4, "value"),
        });
        expect(goto.status).toBe("ok");
        if (goto.status === "ok") expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(f("pkg/name.py")));
      },
    );
  });

  it.each([
    ["class", "pkg/__init__.py", "class name:\n    pass\n"],
    ["assignment", "pkg/__init__.py", "name = lambda: 1\n"],
    ["stub initializer", "pkg/__init__.pyi", "def name() -> int: ...\n"],
  ])("finds the %s attribute in the package initializer", async (_label, initializer, packageSource) => {
    await withFixture(
      "cg-audit-py-other-attribute-",
      { [initializer]: packageSource, "pkg/name.py": submoduleSource, "main.py": mainSource },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        expect(index.byFile.get(fileIdentityKey(f("main.py")))?.imports).toMatchObject([
          { kind: "named", resolved: f(initializer) },
        ]);
        const goto = await goToDefinition(index, {
          file: f("main.py"),
          line: 4,
          column: columnOf(mainSource, 4, "name"),
        });
        expect(goto.status).toBe("ok");
        if (goto.status === "ok") expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(f(initializer)));
      },
    );
  });

  it("treats a package re-export as its attribute over the same-named submodule", async () => {
    const helperSource = "def name():\n    return 3\n";
    await withFixture(
      "cg-audit-py-reexport-",
      {
        "pkg/__init__.py": "from .helpers import name\n",
        "pkg/helpers.py": helperSource,
        "pkg/name.py": submoduleSource,
        "main.py": mainSource,
      },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        expect(index.byFile.get(fileIdentityKey(f("main.py")))?.imports).toMatchObject([
          { kind: "named", resolved: f("pkg/__init__.py") },
        ]);
        const goto = await goToDefinition(index, {
          file: f("main.py"),
          line: 4,
          column: columnOf(mainSource, 4, "name"),
        });
        expect(goto.status).toBe("ok");
        if (goto.status === "ok")
          expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(f("pkg/helpers.py")));
      },
    );
  });

  it("uses an explicitly aliased submodule member as a package attribute", async () => {
    await withFixture(
      "cg-audit-py-submodule-member-",
      {
        "pkg/__init__.py": "from .name import value as name\n",
        "pkg/name.py": "def value():\n    return 2\n",
        "main.py": mainSource,
      },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        expect(index.byFile.get(fileIdentityKey(f("main.py")))?.imports).toMatchObject([
          { kind: "named", resolved: f("pkg/__init__.py") },
        ]);
        const goto = await goToDefinition(index, {
          file: f("main.py"),
          line: 4,
          column: columnOf(mainSource, 4, "name"),
        });
        expect(goto.status).toBe("ok");
        if (goto.status === "ok") {
          expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(f("pkg/name.py")));
          expect(goto.definition.range.start.line).toBe(1);
        }
      },
    );
  });

  it("keeps an imported top-level module attribute ahead of the package submodule", async () => {
    const source = "from pkg import name\n\ndef run():\n    return name.value()\n";
    await withFixture(
      "cg-audit-py-imported-module-",
      {
        "pkg/__init__.py": "import name\n",
        "pkg/name.py": "def value():\n    return 2\n",
        "name.py": "def value():\n    return 3\n",
        "main.py": source,
      },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        expect(index.byFile.get(fileIdentityKey(f("main.py")))?.imports).toMatchObject([
          { kind: "named", resolved: f("pkg/__init__.py") },
        ]);
        const goto = await goToDefinition(index, { file: f("main.py"), line: 4, column: columnOf(source, 4, "value") });
        expect(goto.status).toBe("ok");
        if (goto.status === "ok") expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(f("name.py")));
      },
    );
  });

  it("re-resolves unchanged importers on warm disk builds when a package attribute is added and removed", async () => {
    await withFixture(
      "cg-audit-py-attribute-cache-",
      { "pkg/__init__.py": "", "pkg/name.py": submoduleSource, "main.py": mainSource },
      async (root, f) => {
        const initial = await buildProjectIndexIncremental(root, { cache: "disk" });
        expect(
          initial.graph.edges.some(
            (edge) =>
              fileIdentityKey(edge.from) === fileIdentityKey(f("main.py")) &&
              edge.to.type === "file" &&
              fileIdentityKey(edge.to.path) === fileIdentityKey(f("pkg/__init__.py")),
          ),
        ).toBe(true);
        for (const [packageSource, expectedKind, expectedFile] of [
          [initSource, "named", "pkg/__init__.py"],
          ["", "namespace", "pkg/name.py"],
        ] as const) {
          await fsp.writeFile(f("pkg/__init__.py"), packageSource, "utf8");
          const warm = await buildProjectIndexIncremental(root, { cache: "disk" });
          const cold = await buildProjectIndex(root, { cache: "off" });
          for (const index of [warm, cold]) {
            expect(index.byFile.get(fileIdentityKey(f("main.py")))?.imports).toMatchObject([
              { kind: expectedKind, resolved: f(expectedFile) },
            ]);
            const goto = await goToDefinition(index, {
              file: f("main.py"),
              line: 4,
              column: columnOf(mainSource, 4, "name"),
            });
            expect(goto.status).toBe("ok");
            if (goto.status === "ok")
              expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(f(expectedFile)));
            if (expectedKind === "named") {
              const refs = await findReferences(index, {
                file: f("pkg/__init__.py"),
                line: 1,
                column: columnOf(initSource, 1, "name"),
              });
              expect(refs.status).toBe("ok");
              if (refs.status === "ok") {
                expect(refs.referenceCoverage.state).toBe("complete");
                expect(
                  refs.references
                    .filter((ref) => fileIdentityKey(ref.file) === fileIdentityKey(f("main.py")))
                    .map((ref) => ref.range.start.line)
                    .sort(),
                ).toEqual([1, 4]);
              }
              const graph = await buildSymbolGraphDetailed(index);
              const run = [...graph.nodes.values()].find(
                (node) => node.name === "run" && fileIdentityKey(node.file) === fileIdentityKey(f("main.py")),
              );
              expect(
                graph.edges
                  .filter((edge) => edge.label === "calls" && edge.from === run?.id)
                  .map((edge) => fileIdentityKey(graph.nodes.get(edge.to)!.file)),
              ).toEqual([fileIdentityKey(f("pkg/__init__.py"))]);
            }
          }
          expect(warm.byFile.get(fileIdentityKey(f("main.py")))?.imports).toEqual(
            cold.byFile.get(fileIdentityKey(f("main.py")))?.imports,
          );
        }
      },
    );
  });
});
