import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildProjectIndex, buildProjectIndexIncremental } from "../src/indexer.js";
import { buildSymbolGraphDetailed, findReferences, goToDefinition } from "../src/index.js";
import { fileIdentityKey } from "../src/util/paths.js";

/**
 * Python import navigation regressions:
 * - a class named like its own module (`widget.py` / `Widget`), reached through a package
 *   `__init__.py` re-export plus an aliased import, must not lose its consumers from findReferences.
 * - `import pkg.mod` followed by `pkg.mod.foo()` must navigate and find references like the
 *   equivalent `from pkg import mod` and `import pkg.mod as m` forms already do.
 * - the source-side name in `from a import helper as h` must navigate like the unaliased form.
 * - `super().m()` resolves through a proven base class, same-file or imported, unless `super` is
 *   lexically shadowed; an unproven (missing) base stays `not_found`.
 * - Submodule bindings target regular-package initializers and never infer the wrong case.
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

describe("class named like its own module through a package re-export", () => {
  const widgetSource = "class Widget:\n    def render(self):\n        return 1\n";
  const initSource = "from .widget import Widget\n";
  const mainSource = "from pkg import Widget as W\n\nW(2).render()\n";
  const decoySource = "class Widget:\n    def render(self):\n        return 999\n";

  it("navigates from the aliased usage site and the import's own source-name token", async () => {
    await withFixture(
      "cg-goto-",
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
      "cg-refs-",
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
      "cg-graph-",
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

describe("import pkg.mod then pkg.mod.foo()", () => {
  const modSource = "def foo():\n    return 42\n";
  const mainSource = "import pkg.mod\n\npkg.mod.foo()\n";
  const decoySource = "def foo():\n    return -1\n";

  it("navigates the dotted chain to the submodule function, not the decoy", async () => {
    await withFixture(
      "cg-goto-",
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
      "cg-refs-",
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
      "cg-controls-",
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

describe("Python package submodules need a binding", () => {
  const valueSource = "value = 7\n";
  const plainSource = "import pkg\n\ndef use():\n    return pkg.child.value\n";
  const dottedSource = "import pkg.child\n\ndef use():\n    return pkg.child.value\n";
  const fromSource = "from pkg import child\n\ndef use():\n    return child.value\n";

  it("does not infer an unimported child from its file while explicit imports still work", async () => {
    await withFixture(
      "cg-py-unimported-submodule-",
      {
        "pkg/__init__.py": "",
        "pkg/child.py": valueSource,
        "plain.py": plainSource,
        "dotted.py": dottedSource,
        "from.py": fromSource,
      },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        const plain = await goToDefinition(index, {
          file: f("plain.py"),
          line: 4,
          column: columnOf(plainSource, 4, "value"),
        });
        expect(plain.status).toBe("not_found");

        for (const [file, source] of [
          ["dotted.py", dottedSource],
          ["from.py", fromSource],
        ] as const) {
          const hit = await goToDefinition(index, { file: f(file), line: 4, column: columnOf(source, 4, "value") });
          expect(hit.status).toBe("ok");
          if (hit.status === "ok")
            expect(fileIdentityKey(hit.definition.file)).toBe(fileIdentityKey(f("pkg/child.py")));
        }

        const refs = await findReferences(index, { file: f("pkg/child.py"), line: 1, column: 1 });
        expect(refs.status).toBe("ok");
        if (refs.status === "ok") {
          const files = refs.references.map((ref) => fileIdentityKey(ref.file));
          expect(files).not.toContain(fileIdentityKey(f("plain.py")));
          expect(files).toContain(fileIdentityKey(f("dotted.py")));
          expect(files).toContain(fileIdentityKey(f("from.py")));
          expect(refs.referenceCoverage.state).toBe("partial");
          if (refs.referenceCoverage.state === "partial") {
            expect(refs.referenceCoverage.reasons).toContain("strategy_unavailable");
            expect(refs.referenceCoverage.affectedFiles?.map(fileIdentityKey)).toContain(
              fileIdentityKey(f("plain.py")),
            );
          }
        }

        const graph = await buildSymbolGraphDetailed(index);
        const hasValueEdge = (file: string) =>
          graph.edges.some(
            (edge) =>
              fileIdentityKey(graph.nodes.get(edge.from)?.file ?? "") === fileIdentityKey(f(file)) &&
              fileIdentityKey(graph.nodes.get(edge.to)?.file ?? "") === fileIdentityKey(f("pkg/child.py")) &&
              graph.nodes.get(edge.to)?.name === "value",
          );
        expect(hasValueEdge("plain.py")).toBe(false);
        expect(hasValueEdge("dotted.py")).toBe(true);
        expect(hasValueEdge("from.py")).toBe(true);
      },
    );
  });

  it("recognizes a submodule explicitly bound by the package initializer", async () => {
    const source = "import pkg\n\ndef use():\n    return pkg.child.value\n";
    await withFixture(
      "cg-py-bound-submodule-",
      { "pkg/__init__.py": "from . import child\n", "pkg/child.py": valueSource, "main.py": source },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        const goto = await goToDefinition(index, { file: f("main.py"), line: 4, column: columnOf(source, 4, "value") });
        expect(goto.status).toBe("ok");
        if (goto.status === "ok")
          expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(f("pkg/child.py")));
        const refs = await findReferences(index, { file: f("pkg/child.py"), line: 1, column: 1 });
        expect(refs.status).toBe("ok");
        if (refs.status === "ok") {
          expect(
            refs.references.some(
              (ref) => fileIdentityKey(ref.file) === fileIdentityKey(f("main.py")) && ref.range.start.line === 4,
            ),
          ).toBe(true);
        }
        const graph = await buildSymbolGraphDetailed(index);
        expect(
          graph.edges.some(
            (edge) =>
              fileIdentityKey(graph.nodes.get(edge.from)?.file ?? "") === fileIdentityKey(f("main.py")) &&
              fileIdentityKey(graph.nodes.get(edge.to)?.file ?? "") === fileIdentityKey(f("pkg/child.py")) &&
              graph.nodes.get(edge.to)?.name === "value",
          ),
        ).toBe(true);
      },
    );
  });

  it("keeps an unbound nested package path unproven", async () => {
    const source = "import pkg\n\ndef use():\n    return pkg.sub.child.value\n";
    await withFixture(
      "cg-py-nested-unimported-submodule-",
      {
        "pkg/__init__.py": "",
        "pkg/sub/__init__.py": "",
        "pkg/sub/child.py": valueSource,
        "main.py": source,
      },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        const goto = await goToDefinition(index, { file: f("main.py"), line: 4, column: columnOf(source, 4, "value") });
        expect(goto.status).toBe("not_found");
        const refs = await findReferences(index, { file: f("pkg/sub/child.py"), line: 1, column: 1 });
        expect(refs.status).toBe("ok");
        if (refs.status === "ok") {
          expect(refs.references.some((ref) => fileIdentityKey(ref.file) === fileIdentityKey(f("main.py")))).toBe(
            false,
          );
          expect(refs.referenceCoverage.state).toBe("partial");
          if (refs.referenceCoverage.state === "partial") {
            expect(refs.referenceCoverage.affectedFiles?.map(fileIdentityKey)).toContain(fileIdentityKey(f("main.py")));
          }
        }
        const graph = await buildSymbolGraphDetailed(index);
        expect(
          graph.edges.some(
            (edge) =>
              fileIdentityKey(graph.nodes.get(edge.from)?.file ?? "") === fileIdentityKey(f("main.py")) &&
              fileIdentityKey(graph.nodes.get(edge.to)?.file ?? "") === fileIdentityKey(f("pkg/sub/child.py")) &&
              graph.nodes.get(edge.to)?.name === "value",
          ),
        ).toBe(false);
      },
    );
  });
});

describe("source-side name in an aliased Python import", () => {
  const aSource = "def helper():\n    return 1\n";
  const bSource = "from a import helper as helper_alias\n\nresult = helper_alias()\n";
  const decoySource = "def helper():\n    return -1\n";

  it("navigates the source-name token to the real definition, not the decoy", async () => {
    await withFixture("cg-goto-", { "a.py": aSource, "b.py": bSource, "decoy.py": decoySource }, async (_root, f) => {
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
    });
  });

  it("includes both the source-name and alias tokens in findReferences, excluding the decoy", async () => {
    await withFixture("cg-refs-", { "a.py": aSource, "b.py": bSource, "decoy.py": decoySource }, async (_root, f) => {
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
    });
  });

  it("never resolves the aliased import's source spelling as a bare, unbound identifier elsewhere in the file", async () => {
    // `from a import helper as h` binds only `h`; a bare `helper()` anywhere else in the file is
    // unbound (a NameError at runtime) and must stay not_found, even though `helper` is exactly
    // the import's own source-side spelling.
    const source = "from a import helper as h\n\nh()\nhelper()\n";
    await withFixture("cg-unbound-", { "a.py": aSource, "b.py": source }, async (_root, f) => {
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

describe("super() through a proven base class", () => {
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
    await withFixture("cg-samefile-", { "app.py": source }, async (_root, f) => {
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
    await withFixture("cg-crossfile-", { "base.py": baseSource, "derived.py": derivedSource }, async (_root, f) => {
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
    });
  });

  it("keeps super() unresolved when the enclosing class has no base at all", async () => {
    const source = "class Standalone:\n    def greet(self):\n        return super().greet()\n";
    await withFixture("cg-unproven-", { "app.py": source }, async (_root, f) => {
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

describe("Python super() lexical shadowing", () => {
  const baseSource = "class Base:\n    def helper(self):\n        return 1\n";
  const controlSource = [
    "from base import Base",
    "class Control(Base):",
    "    super = lambda: object()",
    "    def run(self):",
    "        return super().helper()",
    "",
  ].join("\n");

  it.each([
    ["parameter", "class Derived(Base):\n    def run(self, super):\n        return super().helper()\n"],
    [
      "local assignment",
      "class Derived(Base):\n    def run(self):\n        super = lambda: object()\n        return super().helper()\n",
    ],
    [
      "module import",
      "from factory import super\nclass Derived(Base):\n    def run(self):\n        return super().helper()\n",
    ],
    [
      "module assignment",
      "super = lambda: object()\nclass Derived(Base):\n    def run(self):\n        return super().helper()\n",
    ],
    ["class-body assignment", "class Derived(Base):\n    super = lambda: object()\n    value = super().helper()\n"],
  ])("does not resolve a %s named super as the built-in receiver", async (_case, derivedBody) => {
    const derivedSource = `from base import Base\n${derivedBody}`;
    const derivedLine = derivedSource.split("\n").findIndex((line) => line.includes("super().helper()")) + 1;
    await withFixture(
      "cg-shadow-super-",
      {
        "base.py": baseSource,
        "factory.py": "def super():\n    return object()\n",
        "derived.py": derivedSource,
        "control.py": controlSource,
      },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        const shadowed = await goToDefinition(index, {
          file: f("derived.py"),
          line: derivedLine,
          column: columnOf(derivedSource, derivedLine, "helper"),
        });
        expect(shadowed.status).toBe("not_found");

        const unshadowed = await goToDefinition(index, {
          file: f("control.py"),
          line: 5,
          column: columnOf(controlSource, 5, "helper"),
        });
        expect(unshadowed.status).toBe("ok");
        if (unshadowed.status === "ok") {
          expect(fileIdentityKey(unshadowed.definition.file)).toBe(fileIdentityKey(f("base.py")));
          expect(unshadowed.definition.range.start.line).toBe(2);
        }

        const references = await findReferences(index, {
          file: f("base.py"),
          line: 2,
          column: columnOf(baseSource, 2, "helper"),
        });
        expect(references.status).toBe("ok");
        if (references.status === "ok") {
          expect(references.referenceCoverage.state).toBe("partial");
          expect(
            references.references.some(
              (ref) =>
                fileIdentityKey(ref.file) === fileIdentityKey(f("derived.py")) && ref.range.start.line === derivedLine,
            ),
          ).toBe(false);
          expect(
            references.references.some(
              (ref) => fileIdentityKey(ref.file) === fileIdentityKey(f("control.py")) && ref.range.start.line === 5,
            ),
          ).toBe(true);
        }

        const graph = await buildSymbolGraphDetailed(index);
        const baseHelper = [...graph.nodes.values()].find(
          (node) => node.name === "helper" && fileIdentityKey(node.file) === fileIdentityKey(f("base.py")),
        );
        expect(baseHelper).toBeDefined();
        const baseCalls = graph.edges.filter((edge) => edge.label === "calls" && edge.to === baseHelper?.id);
        expect(
          baseCalls.some(
            (edge) =>
              fileIdentityKey(edge.site?.file ?? "") === fileIdentityKey(f("derived.py")) &&
              edge.site?.range.start.line === derivedLine,
          ),
        ).toBe(false);
        expect(
          baseCalls.some(
            (edge) =>
              fileIdentityKey(edge.site?.file ?? "") === fileIdentityKey(f("control.py")) &&
              edge.site?.range.start.line === 5,
          ),
        ).toBe(true);
      },
    );
  });
});

describe("Python class-body bindings and graph call edges", () => {
  it("keeps a class-body assignment invisible inside methods for goto and the graph", async () => {
    const classScope = "class Box:\n    helper = lambda: 1\n\n    def run(self):\n        return helper()\n";
    const moduleScope = "helper = lambda: 1\n\n\ndef run():\n    return helper()\n";
    await withFixture(
      "cg-py-class-scope-",
      { "class_scope.py": classScope, "module_scope.py": moduleScope },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        // A class body is not an enclosing scope for its methods: the bare `helper` call
        // inside `run` cannot name the class attribute.
        const shadowed = await goToDefinition(index, {
          file: f("class_scope.py"),
          line: 5,
          column: columnOf(classScope, 5, "helper"),
        });
        expect(shadowed.status).toBe("not_found");

        const visible = await goToDefinition(index, {
          file: f("module_scope.py"),
          line: 5,
          column: columnOf(moduleScope, 5, "helper"),
        });
        expect(visible.status).toBe("ok");
        if (visible.status === "ok") {
          expect(visible.definition.localName).toBe("helper");
          expect(visible.definition.range.start.line).toBe(1);
        }

        const graph = await buildSymbolGraphDetailed(index);
        for (const [file, calls] of [
          ["class_scope.py", 0],
          ["module_scope.py", 1],
        ] as const) {
          const run = [...graph.nodes.values()].find(
            (node) => node.name === "run" && fileIdentityKey(node.file) === fileIdentityKey(f(file)),
          );
          expect(run).toBeDefined();
          const edges = graph.edges.filter((edge) => edge.label === "calls" && edge.from === run?.id);
          expect(edges).toHaveLength(calls);
          if (calls === 1) {
            const target = graph.nodes.get(edges[0]!.to);
            expect(target?.name).toBe("helper");
            expect(fileIdentityKey(target!.file)).toBe(fileIdentityKey(f(file)));
          }
        }
      },
    );
  });
});

describe("Python import rebinding in member resolution", () => {
  it("uses the last explicit named import for a static member and excludes the shadowed member", async () => {
    const aSource = "class Thing:\n    @staticmethod\n    def hit():\n        return 'a'\n";
    const bSource = "class Thing:\n    @staticmethod\n    def hit():\n        return 'b'\n";
    const mainSource = "from a import Thing\nfrom b import Thing\n\nThing.hit()\n";
    await withFixture(
      "cg-python-explicit-rebinding-",
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
      "cg-python-namespace-rebinding-",
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
      "cg-python-star-namespace-rebinding-",
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
      "cg-python-inherited-rebinding-",
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

describe("Python submodule bindings are case-exact and target package initializers", () => {
  const packageSource = "value = 1\n";
  const mainSource = "from pkg import sub\n\nprint(sub.value)\n";
  const packageFiles = {
    "pkg/__init__.py": "",
    "pkg/sub/__init__.py": packageSource,
    "main.py": mainSource,
  };

  it("navigates, references, and links a regular-package submodule member", async () => {
    await withFixture("cg-py-package-submodule-", packageFiles, async (root, f) => {
      const index = await buildProjectIndex(root, { cache: "off" });
      expect(index.byFile.get(fileIdentityKey(f("main.py")))?.imports).toMatchObject([
        { kind: "namespace", resolved: f("pkg/sub/__init__.py") },
      ]);
      const goto = await goToDefinition(index, {
        file: f("main.py"),
        line: 3,
        column: columnOf(mainSource, 3, "value"),
      });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") {
        expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(f("pkg/sub/__init__.py")));
      }

      const refs = await findReferences(index, { file: f("pkg/sub/__init__.py"), line: 1, column: 1 });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        expect(refs.referenceCoverage.state).toBe("complete");
        const sites = refs.references.map((ref) => `${fileIdentityKey(ref.file)}:${ref.range.start.line}`).sort();
        expect(sites).toEqual(
          [`${fileIdentityKey(f("main.py"))}:3`, `${fileIdentityKey(f("pkg/sub/__init__.py"))}:1`].sort(),
        );
      }

      const graph = await buildSymbolGraphDetailed(index);
      expect(
        graph.edges.some((edge) => {
          const from = graph.nodes.get(edge.from);
          const to = graph.nodes.get(edge.to);
          return (
            edge.label === "value" &&
            fileIdentityKey(from?.file ?? "") === fileIdentityKey(f("main.py")) &&
            fileIdentityKey(to?.file ?? "") === fileIdentityKey(f("pkg/sub/__init__.py")) &&
            to?.name === "value"
          );
        }),
      ).toBe(true);
    });
  });

  it("keeps the regular-package submodule binding identical after a warm disk build", async () => {
    await withFixture("cg-py-package-submodule-cache-", packageFiles, async (root, f) => {
      await buildProjectIndexIncremental(root, { cache: "disk" });
      const warm = await buildProjectIndexIncremental(root, { cache: "disk" });
      const cold = await buildProjectIndex(root, { cache: "off" });
      for (const index of [warm, cold]) {
        expect(index.byFile.get(fileIdentityKey(f("main.py")))?.imports).toMatchObject([
          { kind: "namespace", resolved: f("pkg/sub/__init__.py") },
        ]);
        const goto = await goToDefinition(index, {
          file: f("main.py"),
          line: 3,
          column: columnOf(mainSource, 3, "value"),
        });
        expect(goto.status).toBe("ok");
        if (goto.status === "ok") {
          expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(f("pkg/sub/__init__.py")));
        }
        const refs = await findReferences(index, { file: f("pkg/sub/__init__.py"), line: 1, column: 1 });
        expect(refs.status).toBe("ok");
        if (refs.status === "ok") {
          expect(refs.referenceCoverage.state).toBe("complete");
          expect(
            refs.references.some(
              (ref) => fileIdentityKey(ref.file) === fileIdentityKey(f("main.py")) && ref.range.start.line === 3,
            ),
          ).toBe(true);
        }
        const graph = await buildSymbolGraphDetailed(index);
        expect(
          graph.edges.some(
            (edge) =>
              edge.label === "value" &&
              fileIdentityKey(graph.nodes.get(edge.from)?.file ?? "") === fileIdentityKey(f("main.py")) &&
              fileIdentityKey(graph.nodes.get(edge.to)?.file ?? "") === fileIdentityKey(f("pkg/sub/__init__.py")),
          ),
        ).toBe(true);
      }
      expect(warm.byFile.get(fileIdentityKey(f("main.py")))?.imports).toEqual(
        cold.byFile.get(fileIdentityKey(f("main.py")))?.imports,
      );
    });
  });

  it("does not invent a differently cased submodule for package member navigation", async () => {
    const source = "import pkg\n\nx = pkg.Widget\n";
    await withFixture(
      "cg-py-case-exact-submodule-",
      { "pkg/__init__.py": "", "pkg/widget.py": "class Widget:\n    pass\n", "main.py": source },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        const goto = await goToDefinition(index, {
          file: f("main.py"),
          line: 3,
          column: columnOf(source, 3, "Widget"),
        });
        expect(goto.status).toBe("not_found");

        const refs = await findReferences(index, { file: f("pkg/widget.py"), line: 1, column: 7 });
        expect(refs.status).toBe("ok");
        if (refs.status === "ok") {
          expect(refs.referenceCoverage.state).toBe("complete");
          expect(refs.references.map((ref) => `${fileIdentityKey(ref.file)}:${ref.range.start.line}`)).toEqual([
            `${fileIdentityKey(f("pkg/widget.py"))}:1`,
          ]);
        }
        const graph = await buildSymbolGraphDetailed(index);
        expect(
          graph.edges.some(
            (edge) =>
              fileIdentityKey(graph.nodes.get(edge.from)?.file ?? "") === fileIdentityKey(f("main.py")) &&
              fileIdentityKey(graph.nodes.get(edge.to)?.file ?? "") === fileIdentityKey(f("pkg/widget.py")) &&
              graph.nodes.get(edge.to)?.name === "Widget",
          ),
        ).toBe(false);
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
      "cg-py-attribute-",
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
      "cg-py-submodule-control-",
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
      "cg-py-other-attribute-",
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
      "cg-py-reexport-",
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
      "cg-py-submodule-member-",
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
      "cg-py-imported-module-",
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

  it("keeps a submodule binding uncallable for bare calls but reachable through members", async () => {
    const mainSource = "from pkg import name\n\ndef run():\n    return name()\n\ndef use():\n    return name.value()\n";
    await withFixture(
      "cg-py-submodule-call-",
      {
        "pkg/__init__.py": "",
        "pkg/name.py": "def name():\n    return 2\n\ndef value():\n    return 3\n",
        "main.py": mainSource,
      },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        // `from pkg import name` with no package attribute binds the submodule object, and a
        // module is not callable: the bare call is an error, not a call to pkg/name.py's
        // same-named function. Member access through the binding still resolves.
        const call = await goToDefinition(index, {
          file: f("main.py"),
          line: 4,
          column: columnOf(mainSource, 4, "name"),
        });
        expect(call.status).toBe("not_found");

        const member = await goToDefinition(index, {
          file: f("main.py"),
          line: 7,
          column: columnOf(mainSource, 7, "value"),
        });
        expect(member.status).toBe("ok");
        if (member.status === "ok") {
          expect(fileIdentityKey(member.definition.file)).toBe(fileIdentityKey(f("pkg/name.py")));
          expect(member.definition.range.start.line).toBe(4);
        }

        const graph = await buildSymbolGraphDetailed(index);
        const run = [...graph.nodes.values()].find(
          (node) => node.name === "run" && fileIdentityKey(node.file) === fileIdentityKey(f("main.py")),
        );
        const use = [...graph.nodes.values()].find(
          (node) => node.name === "use" && fileIdentityKey(node.file) === fileIdentityKey(f("main.py")),
        );
        expect(run).toBeDefined();
        expect(use).toBeDefined();
        expect(graph.edges.filter((edge) => edge.label === "calls" && edge.from === run?.id)).toHaveLength(0);
        const useCalls = graph.edges.filter((edge) => edge.label === "calls" && edge.from === use?.id);
        expect(useCalls.map((edge) => graph.nodes.get(edge.to)?.name)).toEqual(["value"]);
      },
    );
  });

  it("re-resolves unchanged importers on warm disk builds when a package attribute is added and removed", async () => {
    await withFixture(
      "cg-py-attribute-cache-",
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
            if (expectedKind === "namespace") {
              // The submodule binding is a module object, not a callable: the bare call in
              // `return name()` is an error, not a call to the submodule's first export.
              expect(goto.status).toBe("not_found");
            } else {
              expect(goto.status).toBe("ok");
              if (goto.status === "ok")
                expect(fileIdentityKey(goto.definition.file)).toBe(fileIdentityKey(f(expectedFile)));
            }
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
