import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildProjectIndex, buildProjectIndexIncremental } from "../src/indexer.js";
import { buildProjectIndexFromFiles } from "../src/indexer/build-index.js";
import { buildSymbolGraphDetailed, findReferences, goToDefinition, type Reference } from "../src/index.js";
import { defNodeId } from "../src/graphs/symbol-graph.js";
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
 * - a module-level name read from a function body is the module's binding at call time, so an
 *   import that follows a local `def` owns the deferred call while an earlier module-level call
 *   still names the local, and a later local declaration or a parameter keeps its own binding.
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

/** Sorted `[line, column]` reference start sites of one file. */
function sitesOf(references: readonly Reference[], file: string): Array<[number, number]> {
  return references
    .filter((reference) => fileIdentityKey(reference.file) === file)
    .map((reference): [number, number] => [reference.range.start.line, reference.range.start.column])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
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

describe("Python module names a later import rebinds", () => {
  const otherSource = "def helper():\n    return 2\n";
  // 1-2: local definition, the same-name local decoy for the imported helper.
  // 3: module-level call before the import, still the local.
  // 4-5: deferred call in a function body, which reads the module name at call time.
  // 6: the import that rebinds the name.
  const mainSource = [
    "def helper():",
    "    return 1",
    "print(helper())",
    "def run():",
    "    return helper()",
    "from other import helper",
    "",
  ].join("\n");

  it("keeps the local's own call and excludes the deferred call the import owns", async () => {
    await withFixture("cg-py-later-import-", { "main.py": mainSource, "other.py": otherSource }, async (root, f) => {
      const index = await buildProjectIndex(root, { cache: "off" });

      const earlyCall = await goToDefinition(index, {
        file: f("main.py"),
        line: 3,
        column: columnOf(mainSource, 3, "helper"),
      });
      expect(earlyCall.status).toBe("ok");
      if (earlyCall.status === "ok") {
        expect(fileIdentityKey(earlyCall.definition.file)).toBe(fileIdentityKey(f("main.py")));
        expect(earlyCall.definition.range.start.line).toBe(1);
      }

      const deferredCall = await goToDefinition(index, {
        file: f("main.py"),
        line: 5,
        column: columnOf(mainSource, 5, "helper"),
      });
      expect(deferredCall.status).toBe("ok");
      if (deferredCall.status === "ok") {
        expect(fileIdentityKey(deferredCall.definition.file)).toBe(fileIdentityKey(f("other.py")));
        expect(deferredCall.definition.range.start.line).toBe(1);
      }

      const localReferences = await findReferences(index, {
        file: f("main.py"),
        line: 1,
        column: columnOf(mainSource, 1, "helper"),
      });
      expect(localReferences.status).toBe("ok");
      if (localReferences.status !== "ok") return;
      expect(localReferences.referenceCoverage.state).toBe("complete");
      expect(sitesOf(localReferences.references, fileIdentityKey(f("main.py")))).toEqual([
        [1, columnOf(mainSource, 1, "helper")],
        [3, columnOf(mainSource, 3, "helper")],
      ]);

      const importedReferences = await findReferences(index, {
        file: f("other.py"),
        line: 1,
        column: columnOf(otherSource, 1, "helper"),
      });
      expect(importedReferences.status).toBe("ok");
      if (importedReferences.status !== "ok") return;
      expect(importedReferences.referenceCoverage.state).toBe("complete");
      expect(sitesOf(importedReferences.references, fileIdentityKey(f("main.py")))).toEqual([
        [5, columnOf(mainSource, 5, "helper")],
        [6, columnOf(mainSource, 6, "helper")],
      ]);
    });
  });

  it("gives the deferred call to a local declaration that follows the import", async () => {
    const shadowedSource = [
      "from other import helper",
      "",
      "def run():",
      "    return helper()",
      "def helper():",
      "    return 3",
      "",
    ].join("\n");
    await withFixture(
      "cg-py-local-after-import-",
      { "main.py": shadowedSource, "other.py": otherSource },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });

        const deferredCall = await goToDefinition(index, {
          file: f("main.py"),
          line: 4,
          column: columnOf(shadowedSource, 4, "helper"),
        });
        expect(deferredCall.status).toBe("ok");
        if (deferredCall.status === "ok") {
          expect(fileIdentityKey(deferredCall.definition.file)).toBe(fileIdentityKey(f("main.py")));
          expect(deferredCall.definition.range.start.line).toBe(5);
        }

        const localReferences = await findReferences(index, {
          file: f("main.py"),
          line: 5,
          column: columnOf(shadowedSource, 5, "helper"),
        });
        expect(localReferences.status).toBe("ok");
        if (localReferences.status !== "ok") return;
        expect(sitesOf(localReferences.references, fileIdentityKey(f("main.py")))).toEqual([
          [4, columnOf(shadowedSource, 4, "helper")],
          [5, columnOf(shadowedSource, 5, "helper")],
        ]);

        const importedReferences = await findReferences(index, {
          file: f("other.py"),
          line: 1,
          column: columnOf(otherSource, 1, "helper"),
        });
        expect(importedReferences.status).toBe("ok");
        if (importedReferences.status !== "ok") return;
        expect(sitesOf(importedReferences.references, fileIdentityKey(f("main.py")))).toEqual([
          [1, columnOf(shadowedSource, 1, "helper")],
        ]);
      },
    );
  });

  it("keeps a parameter that shadows the rebinding module name", async () => {
    const parameterSource = `${mainSource}\ndef via_param(helper):\n    return helper()\n`;
    await withFixture(
      "cg-py-later-import-param-",
      { "main.py": parameterSource, "other.py": otherSource },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        const parameterUse = await goToDefinition(index, {
          file: f("main.py"),
          line: 9,
          column: columnOf(parameterSource, 9, "helper"),
        });
        expect(parameterUse.status).toBe("ok");
        if (parameterUse.status !== "ok") return;
        expect(fileIdentityKey(parameterUse.definition.file)).toBe(fileIdentityKey(f("main.py")));
        expect(parameterUse.definition.range.start.line).toBe(8);

        for (const [definition, expected] of [
          [
            { file: f("main.py"), line: 1, column: columnOf(parameterSource, 1, "helper") },
            [
              [1, columnOf(parameterSource, 1, "helper")],
              [3, columnOf(parameterSource, 3, "helper")],
            ],
          ],
          [
            { file: f("other.py"), line: 1, column: columnOf(otherSource, 1, "helper") },
            [
              [5, columnOf(parameterSource, 5, "helper")],
              [6, columnOf(parameterSource, 6, "helper")],
            ],
          ],
        ] as const) {
          const result = await findReferences(index, definition);
          expect(result.status).toBe("ok");
          if (result.status !== "ok") continue;
          expect(sitesOf(result.references, fileIdentityKey(f("main.py")))).toEqual(expected);
        }
      },
    );
  });
});

describe("Python module-level use before a later same-named local declaration", () => {
  const otherSource = "def helper():\n    return 2\n";
  // 1: the import that binds `helper` at module scope.
  // 2: a module-level read before the local `def` exists, so it names the imported function.
  // 3-4: a deferred read in a function body, which resolves after module initialization and so
  //      names the local declaration that replaced the import.
  // 5-6: the local declaration that rebinds the name, the same-name decoy for line 2.
  const source = [
    "from other import helper",
    "print(helper())",
    "def run():",
    "    return helper()",
    "def helper():",
    "    return 3",
    "",
  ].join("\n");

  it("resolves the module-level call to the import and the deferred call to the local", async () => {
    await withFixture("cg-py-later-local-", { "main.py": source, "other.py": otherSource }, async (root, f) => {
      const index = await buildProjectIndex(root, { cache: "off" });

      const immediate = await goToDefinition(index, {
        file: f("main.py"),
        line: 2,
        column: columnOf(source, 2, "helper"),
      });
      expect(immediate.status).toBe("ok");
      if (immediate.status === "ok") {
        expect(fileIdentityKey(immediate.definition.file)).toBe(fileIdentityKey(f("other.py")));
        expect(immediate.definition.range.start.line).toBe(1);
      }

      const deferred = await goToDefinition(index, {
        file: f("main.py"),
        line: 4,
        column: columnOf(source, 4, "helper"),
      });
      expect(deferred.status).toBe("ok");
      if (deferred.status === "ok") {
        expect(fileIdentityKey(deferred.definition.file)).toBe(fileIdentityKey(f("main.py")));
        expect(deferred.definition.range.start.line).toBe(5);
      }
    });
  });

  it("lists the module-level call as an imported reference and keeps it off the local declaration", async () => {
    await withFixture("cg-py-later-local-refs-", { "main.py": source, "other.py": otherSource }, async (root, f) => {
      const index = await buildProjectIndex(root, { cache: "off" });

      const imported = await findReferences(index, {
        file: f("other.py"),
        line: 1,
        column: columnOf(otherSource, 1, "helper"),
      });
      expect(imported.status).toBe("ok");
      if (imported.status !== "ok") return;
      expect(imported.referenceCoverage.state).toBe("complete");
      expect(sitesOf(imported.references, fileIdentityKey(f("main.py")))).toEqual([
        [1, columnOf(source, 1, "helper")],
        [2, columnOf(source, 2, "helper")],
      ]);

      const local = await findReferences(index, {
        file: f("main.py"),
        line: 5,
        column: columnOf(source, 5, "helper"),
      });
      expect(local.status).toBe("ok");
      if (local.status !== "ok") return;
      expect(local.referenceCoverage.state).toBe("complete");
      expect(sitesOf(local.references, fileIdentityKey(f("main.py")))).toEqual([
        [4, columnOf(source, 4, "helper")],
        [5, columnOf(source, 5, "helper")],
      ]);
    });
  });

  it("keeps a star-only module-level call before a later local declaration unresolved", async () => {
    // The source-order fallback below supports explicit imports only; star/local arbitration is
    // unchanged and must not confidently choose the later local declaration.
    const starSource = ["from other import *", "print(helper())", "def helper():", "    return 3", ""].join("\n");
    await withFixture(
      "cg-py-later-local-star-",
      { "main.py": starSource, "other.py": otherSource },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });

        const immediate = await goToDefinition(index, {
          file: f("main.py"),
          line: 2,
          column: columnOf(starSource, 2, "helper"),
        });
        expect(immediate.status).toBe("not_found");

        const local = await findReferences(index, {
          file: f("main.py"),
          line: 3,
          column: columnOf(starSource, 3, "helper"),
        });
        expect(local.status).toBe("ok");
        if (local.status !== "ok") return;
        expect(local.referenceCoverage.state).toBe("complete");
        expect(sitesOf(local.references, fileIdentityKey(f("main.py")))).toEqual([
          [3, columnOf(starSource, 3, "helper")],
        ]);
      },
    );
  });

  it("does not let a later star import replace the earlier explicit binding", async () => {
    const starSource = [
      "from other import helper",
      "print(helper())",
      "from decoy import *",
      "def run():",
      "    return helper()",
      "def helper():",
      "    return 3",
      "",
    ].join("\n");
    await withFixture(
      "cg-py-later-local-star-order-",
      { "main.py": starSource, "other.py": otherSource, "decoy.py": "def helper():\n    return 99\n" },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        const immediate = await goToDefinition(index, {
          file: f("main.py"),
          line: 2,
          column: columnOf(starSource, 2, "helper"),
        });
        expect(immediate.status).toBe("ok");
        if (immediate.status !== "ok") throw new Error("Expected the earlier explicit import");
        expect(fileIdentityKey(immediate.definition.file)).toBe(fileIdentityKey(f("other.py")));
        expect(immediate.definition.range.start.line).toBe(1);

        const deferred = await goToDefinition(index, {
          file: f("main.py"),
          line: 5,
          column: columnOf(starSource, 5, "helper"),
        });
        expect(deferred.status).toBe("ok");
        if (deferred.status !== "ok") throw new Error("Expected the later local declaration");
        expect(fileIdentityKey(deferred.definition.file)).toBe(fileIdentityKey(f("main.py")));
        expect(deferred.definition.range.start.line).toBe(6);

        for (const [file, expectedSites] of [
          [
            "other.py",
            [
              [1, columnOf(starSource, 1, "helper")],
              [2, columnOf(starSource, 2, "helper")],
            ],
          ],
          ["decoy.py", []],
        ] as const) {
          const refs = await findReferences(index, { file: f(file), line: 1, column: 5 });
          expect(refs.status).toBe("ok");
          if (refs.status !== "ok") throw new Error("Expected helper references");
          expect(refs.referenceCoverage.state).toBe("complete");
          expect(sitesOf(refs.references, fileIdentityKey(f("main.py")))).toEqual(expectedSites);
        }
      },
    );
  });

  it("lets a preceding module-level star import replace the earlier explicit binding", async () => {
    const starSource = [
      "from other import helper",
      "from decoy import *",
      "print(helper())",
      "def helper():",
      "    return 3",
      "",
    ].join("\n");
    await withFixture(
      "cg-py-earlier-star-order-",
      { "main.py": starSource, "other.py": otherSource, "decoy.py": "def helper():\n    return 99\n" },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        const result = await goToDefinition(index, {
          file: f("main.py"),
          line: 3,
          column: columnOf(starSource, 3, "helper"),
        });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") throw new Error("Expected the preceding star import");
        expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(f("decoy.py")));
        expect(result.definition.range.start.line).toBe(1);
      },
    );
  });

  it("does not prove a module binding through an earlier conditional star import", async () => {
    const conditionalSource = [
      "from other import helper",
      "if True:",
      "    from decoy import *",
      "print(helper())",
      "def helper():",
      "    return 3",
      "",
    ].join("\n");
    await withFixture(
      "cg-py-conditional-star-order-",
      { "main.py": conditionalSource, "other.py": otherSource, "decoy.py": "def helper():\n    return 99\n" },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        const result = await goToDefinition(index, {
          file: f("main.py"),
          line: 4,
          column: columnOf(conditionalSource, 4, "helper"),
        });
        expect(result.status).toBe("not_found");

        const refs = await findReferences(index, { file: f("other.py"), line: 1, column: 5 });
        expect(refs.status).toBe("ok");
        if (refs.status !== "ok") throw new Error("Expected explicit import references");
        expect(refs.referenceCoverage.state).toBe("partial");
        expect(sitesOf(refs.references, fileIdentityKey(f("main.py")))).toEqual([
          [1, columnOf(conditionalSource, 1, "helper")],
        ]);
      },
    );
  });

  it.each([
    {
      label: "an intervening external star",
      lines: ["from other import exists", "from os.path import *", 'print(exists("."))'],
      expectedStatus: "not_found",
      referenceLines: [1],
      coverage: "partial",
    },
    {
      label: "an external star after the use",
      lines: ["from other import exists", 'print(exists("."))', "from os.path import *"],
      expectedStatus: "ok",
      referenceLines: [1, 2],
      coverage: "complete",
    },
    {
      label: "an external star overwritten by an explicit import",
      lines: ["from os.path import *", "from other import exists", 'print(exists("."))'],
      expectedStatus: "ok",
      referenceLines: [2, 3],
      coverage: "complete",
    },
  ])("keeps source-order proof honest with $label", async ({ lines, expectedStatus, referenceLines, coverage }) => {
    const mainSource = [...lines, "def exists(path):", "    return False", ""].join("\n");
    const existsSource = "def exists(path):\n    return True\n";
    await withFixture(
      "cg-py-external-star-order-",
      { "main.py": mainSource, "other.py": existsSource },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        const useLine = lines.findIndex((line) => line.startsWith("print(")) + 1;
        const result = await goToDefinition(index, {
          file: f("main.py"),
          line: useLine,
          column: columnOf(mainSource, useLine, "exists"),
        });
        expect(result.status).toBe(expectedStatus);
        if (result.status === "ok") {
          expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(f("other.py")));
        } else {
          expect(result.reason).toBe("Ambiguous star import");
        }
        const references = await findReferences(index, { file: f("other.py"), line: 1, column: 5 });
        expect(references.status).toBe("ok");
        if (references.status !== "ok") throw new Error("Expected explicit exists import references");
        expect(references.referenceCoverage.state).toBe(coverage);
        expect(sitesOf(references.references, fileIdentityKey(f("main.py")))).toEqual(
          referenceLines.map((line) => [line, columnOf(mainSource, line, "exists")]),
        );
      },
    );
  });

  it.each(["unindexed", "incomplete"])("rejects an %s star target before the use", async (state) => {
    const mainSource = [
      "from other import exists",
      "from decoy import *",
      'print(exists("."))',
      "def exists(path):",
      "    return False",
      "",
    ].join("\n");
    const existsSource = "def exists(path):\n    return True\n";
    let decoySource = existsSource;
    if (state === "incomplete") decoySource += "\ndef broken(:\n    pass\n";
    await withFixture(
      "cg-py-unchecked-star-target-",
      { "main.py": mainSource, "other.py": existsSource, "decoy.py": decoySource },
      async (root, f) => {
        const index = await buildProjectIndexFromFiles(
          root,
          state === "unindexed" ? [f("main.py"), f("other.py")] : [f("main.py"), f("other.py"), f("decoy.py")],
          { cache: "off" },
        );
        const decoy = index.byFile.get(fileIdentityKey(f("decoy.py")));
        if (state === "unindexed") {
          expect(decoy).toBeUndefined();
        } else {
          expect(decoy?.parseErrorRanges?.length).toBeGreaterThan(0);
        }
        const result = await goToDefinition(index, {
          file: f("main.py"),
          line: 3,
          column: columnOf(mainSource, 3, "exists"),
        });
        expect(result.status).toBe("not_found");
        if (result.status !== "ok") expect(result.reason).toBe("Ambiguous star import");
        const references = await findReferences(index, { file: f("other.py"), line: 1, column: 5 });
        expect(references.status).toBe("ok");
        if (references.status !== "ok") throw new Error("Expected explicit exists import references");
        expect(references.referenceCoverage.state).toBe("partial");
        expect(sitesOf(references.references, fileIdentityKey(f("main.py")))).toEqual([
          [1, columnOf(mainSource, 1, "exists")],
        ]);
      },
    );
  });

  it.each([
    {
      label: "an unresolved explicit re-export",
      decoy: "from os.path import exists\n",
      expectedStatus: "not_found",
      referenceLines: [1],
      coverage: "partial",
    },
    {
      label: "an unresolved star re-export",
      decoy: "from os.path import *\n",
      expectedStatus: "not_found",
      referenceLines: [1],
      coverage: "partial",
    },
    {
      label: "a known-absent name in a closed module",
      decoy: "def unrelated():\n    return True\n",
      expectedStatus: "ok",
      referenceLines: [1, 3],
      coverage: "complete",
    },
  ])("handles $label without guessing", async ({ decoy, expectedStatus, referenceLines, coverage }) => {
    const mainSource = [
      "from other import exists",
      "from decoy import *",
      'print(exists("."))',
      "def exists(path):",
      "    return False",
      "",
    ].join("\n");
    await withFixture(
      "cg-py-forwarded-star-proof-",
      {
        "main.py": mainSource,
        "other.py": "def exists(path):\n    return True\n",
        "decoy.py": decoy,
      },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        const result = await goToDefinition(index, {
          file: f("main.py"),
          line: 3,
          column: columnOf(mainSource, 3, "exists"),
        });
        expect(result.status).toBe(expectedStatus);
        if (result.status === "ok") {
          expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(f("other.py")));
        } else {
          expect(result.reason).toBe("Ambiguous star import");
        }
        const references = await findReferences(index, { file: f("other.py"), line: 1, column: 5 });
        expect(references.status).toBe("ok");
        if (references.status !== "ok") throw new Error("Expected explicit exists import references");
        expect(references.referenceCoverage.state).toBe(coverage);
        expect(sitesOf(references.references, fileIdentityKey(f("main.py")))).toEqual(
          referenceLines.map((line) => [line, columnOf(mainSource, line, "exists")]),
        );
      },
    );
  });

  it.each([
    {
      label: "a resolved wrapper definition overwritten by an external import",
      imports: ["from other import exists", "from wrapper import *"],
      wrapperSource: "def exists(path):\n    return False\nfrom os.path import exists\n",
      expectedTargetFile: undefined,
      expectedCoverage: "partial",
      wrapperDefinesExists: true,
    },
    {
      label: "an unchecked star overwritten by a later proven star",
      imports: ["from other import exists", "from os.path import *", "from replacement import *"],
      wrapperSource: "def unrelated():\n    return 0\n",
      expectedTargetFile: "replacement.py",
      expectedCoverage: "complete",
      wrapperDefinesExists: false,
    },
    {
      label: "a star target with only unrelated imports",
      imports: ["from other import exists", "from wrapper import *"],
      wrapperSource: "import math\nfrom math import sqrt\n\ndef unrelated():\n    return 0\n",
      expectedTargetFile: "other.py",
      expectedCoverage: "complete",
      wrapperDefinesExists: false,
    },
  ])(
    "keeps star fallback source-order proof for $label",
    async ({ imports, wrapperSource, expectedTargetFile, expectedCoverage, wrapperDefinesExists }) => {
      const mainSource = [
        ...imports,
        'print(exists("."))',
        'def run(value=exists(".")):',
        '    return exists(".")',
        "def exists(path):",
        "    return False",
        "",
      ].join("\n");
      const immediateLine = imports.length + 1;
      const defaultLine = immediateLine + 1;
      const deferredLine = immediateLine + 2;
      const localDefinitionLine = immediateLine + 3;
      await withFixture(
        "cg-py-star-fallback-proof-",
        {
          "main.py": mainSource,
          "other.py": "def exists(path):\n    return True\n",
          "replacement.py": "def exists(path):\n    return 99\n",
          "wrapper.py": wrapperSource,
        },
        async (root, f) => {
          const index = await buildProjectIndex(root, { cache: "off" });
          for (const line of [immediateLine, defaultLine]) {
            const result = await goToDefinition(index, {
              file: f("main.py"),
              line,
              column: columnOf(mainSource, line, "exists"),
            });
            if (expectedTargetFile) {
              expect(result.status).toBe("ok");
              if (result.status !== "ok") throw new Error("Expected the source-order import target");
              expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(f(expectedTargetFile)));
              expect(result.definition.range.start.line).toBe(1);
            } else {
              expect(result.status).toBe("not_found");
              if (result.status === "not_found") expect(result.reason).toBe("Ambiguous star import");
            }
          }

          const deferred = await goToDefinition(index, {
            file: f("main.py"),
            line: deferredLine,
            column: columnOf(mainSource, deferredLine, "exists"),
          });
          expect(deferred.status).toBe("ok");
          if (deferred.status !== "ok") throw new Error("Expected the final local declaration");
          expect(fileIdentityKey(deferred.definition.file)).toBe(fileIdentityKey(f("main.py")));
          expect(deferred.definition.range.start.line).toBe(localDefinitionLine);

          for (const file of ["other.py", "replacement.py"]) {
            const references = await findReferences(index, { file: f(file), line: 1, column: 5 });
            expect(references.status).toBe("ok");
            if (references.status !== "ok") throw new Error("Expected source-order import references");
            if (file === "other.py") expect(references.referenceCoverage.state).toBe(expectedCoverage);
            const expectedLines: number[] = file === "other.py" ? [1] : [];
            if (file === expectedTargetFile) expectedLines.push(immediateLine, defaultLine);
            expect(sitesOf(references.references, fileIdentityKey(f("main.py")))).toEqual(
              expectedLines.map((line) => [line, columnOf(mainSource, line, "exists")]),
            );
          }

          const local = await findReferences(index, {
            file: f("main.py"),
            line: localDefinitionLine,
            column: columnOf(mainSource, localDefinitionLine, "exists"),
          });
          expect(local.status).toBe("ok");
          if (local.status !== "ok") throw new Error("Expected local exists references");
          expect(sitesOf(local.references, fileIdentityKey(f("main.py")))).toEqual(
            [deferredLine, localDefinitionLine].map((line) => [line, columnOf(mainSource, line, "exists")]),
          );

          if (wrapperDefinesExists) {
            const wrapper = await findReferences(index, { file: f("wrapper.py"), line: 1, column: 5 });
            expect(wrapper.status).toBe("ok");
            if (wrapper.status !== "ok") throw new Error("Expected the overwritten wrapper declaration");
            expect(wrapper.referenceCoverage.state).toBe("partial");
            expect(sitesOf(wrapper.references, fileIdentityKey(f("main.py")))).toEqual([]);
          }

          const graph = await buildSymbolGraphDetailed(index);
          const run = [...graph.nodes.values()].find(
            (node) => node.name === "run" && fileIdentityKey(node.file) === fileIdentityKey(f("main.py")),
          );
          expect(run).toBeDefined();
          if (!run) throw new Error("Expected the run function to be indexed");
          const calls = graph.edges
            .filter((edge) => edge.label === "calls" && edge.from === run.id)
            .map((edge) => `${fileIdentityKey(graph.nodes.get(edge.to)?.file ?? "")}:${edge.site?.range.start.line}`);
          const expectedCalls = [`${fileIdentityKey(f("main.py"))}:${deferredLine}`];
          if (expectedTargetFile) expectedCalls.push(`${fileIdentityKey(f(expectedTargetFile))}:${defaultLine}`);
          expect(calls.sort()).toEqual(expectedCalls.sort());
        },
      );
    },
  );

  it.each([
    { label: "a positional parameter", declaration: "def run(helper=helper()):", bodyLine: 3 },
    { label: "a typed parameter", declaration: "def run(helper: object=helper()):", bodyLine: 3 },
    { label: "a keyword-only parameter", declaration: "def run(*, helper=helper()):", bodyLine: 3 },
    { label: "a lambda parameter", declaration: "run = lambda helper=helper(): helper()", bodyLine: 2 },
  ])("evaluates the default outside $label's binding", async ({ declaration, bodyLine }) => {
    const lines = ["from other import helper", declaration];
    if (bodyLine === 3) lines.push("    return helper()");
    const localDefinitionLine = lines.length + 1;
    lines.push("def helper():", "    return 3", "");
    const mainSource = lines.join("\n");
    const parameterColumn = declaration.indexOf("helper") + 1;
    const defaultColumn = declaration.indexOf("helper()") + 1;
    const bodyColumn = columnOf(mainSource, bodyLine, "helper", true);
    await withFixture(
      "cg-py-default-parameter-binding-",
      { "main.py": mainSource, "other.py": "def helper():\n    return lambda: 2\n" },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        const defaultUse = await goToDefinition(index, { file: f("main.py"), line: 2, column: defaultColumn });
        expect(defaultUse.status).toBe("ok");
        if (defaultUse.status !== "ok") throw new Error("Expected the eager default-expression target");
        expect(fileIdentityKey(defaultUse.definition.file)).toBe(fileIdentityKey(f("other.py")));
        expect(defaultUse.definition.range.start.line).toBe(1);

        for (const [line, column] of [
          [2, parameterColumn],
          [bodyLine, bodyColumn],
        ] as const) {
          const parameterUse = await goToDefinition(index, { file: f("main.py"), line, column });
          expect(parameterUse.status).toBe("ok");
          if (parameterUse.status !== "ok") throw new Error("Expected the actual parameter binding");
          expect(fileIdentityKey(parameterUse.definition.file)).toBe(fileIdentityKey(f("main.py")));
          expect(parameterUse.definition.range.start.line).toBe(2);
          expect(parameterUse.definition.range.start.column).toBe(parameterColumn);
        }

        const imported = await findReferences(index, { file: f("other.py"), line: 1, column: 5 });
        expect(imported.status).toBe("ok");
        if (imported.status !== "ok") throw new Error("Expected default-expression references");
        expect(imported.referenceCoverage.state).toBe("complete");
        expect(sitesOf(imported.references, fileIdentityKey(f("main.py")))).toEqual([
          [1, columnOf(mainSource, 1, "helper")],
          [2, defaultColumn],
        ]);

        const parameter = await findReferences(index, { file: f("main.py"), line: 2, column: parameterColumn });
        expect(parameter.status).toBe("ok");
        if (parameter.status !== "ok") throw new Error("Expected actual parameter references");
        expect(sitesOf(parameter.references, fileIdentityKey(f("main.py")))).toEqual([
          [2, parameterColumn],
          [bodyLine, bodyColumn],
        ]);

        const local = await findReferences(index, {
          file: f("main.py"),
          line: localDefinitionLine,
          column: columnOf(mainSource, localDefinitionLine, "helper"),
        });
        expect(local.status).toBe("ok");
        if (local.status !== "ok") throw new Error("Expected the later local declaration");
        expect(sitesOf(local.references, fileIdentityKey(f("main.py")))).toEqual([
          [localDefinitionLine, columnOf(mainSource, localDefinitionLine, "helper")],
        ]);
      },
    );
  });

  it.each([
    {
      label: "an imported callable",
      before: ["from other import run"],
      targetFile: "other.py",
      targetLine: 1,
      earlierMainLine: 1,
    },
    {
      label: "an earlier local callable",
      before: ["def run():", "    return 1"],
      targetFile: "main.py",
      targetLine: 1,
      earlierMainLine: 1,
    },
  ])("uses $label when a same-named function evaluates its default", async (scenario) => {
    const mainSource = [...scenario.before, "def run(value=run()):", "    return run(value)", ""].join("\n");
    const defaultLine = scenario.before.length + 1;
    const bodyLine = defaultLine + 1;
    await withFixture(
      "cg-py-self-named-default-",
      { "main.py": mainSource, "other.py": "def run():\n    return 2\n" },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        const defaultUse = await goToDefinition(index, {
          file: f("main.py"),
          line: defaultLine,
          column: columnOf(mainSource, defaultLine, "run", true),
        });
        expect(defaultUse.status).toBe("ok");
        if (defaultUse.status !== "ok") throw new Error("Expected the earlier callable in the default");
        expect(fileIdentityKey(defaultUse.definition.file)).toBe(fileIdentityKey(f(scenario.targetFile)));
        expect(defaultUse.definition.range.start.line).toBe(scenario.targetLine);

        const bodyUse = await goToDefinition(index, {
          file: f("main.py"),
          line: bodyLine,
          column: columnOf(mainSource, bodyLine, "run"),
        });
        expect(bodyUse.status).toBe("ok");
        if (bodyUse.status !== "ok") throw new Error("Expected the new function in its body");
        expect(fileIdentityKey(bodyUse.definition.file)).toBe(fileIdentityKey(f("main.py")));
        expect(bodyUse.definition.range.start.line).toBe(defaultLine);

        const earlier = await findReferences(index, {
          file: f(scenario.targetFile),
          line: scenario.targetLine,
          column: 5,
        });
        expect(earlier.status).toBe("ok");
        if (earlier.status !== "ok") throw new Error("Expected earlier callable references");
        expect(sitesOf(earlier.references, fileIdentityKey(f("main.py")))).toEqual([
          [scenario.earlierMainLine, columnOf(mainSource, scenario.earlierMainLine, "run")],
          [defaultLine, columnOf(mainSource, defaultLine, "run", true)],
        ]);

        const current = await findReferences(index, {
          file: f("main.py"),
          line: defaultLine,
          column: columnOf(mainSource, defaultLine, "run"),
        });
        expect(current.status).toBe("ok");
        if (current.status !== "ok") throw new Error("Expected the new function's references");
        expect(sitesOf(current.references, fileIdentityKey(f("main.py")))).toEqual([
          [defaultLine, columnOf(mainSource, defaultLine, "run")],
          [bodyLine, columnOf(mainSource, bodyLine, "run")],
        ]);

        const graph = await buildSymbolGraphDetailed(index);
        const priorId = defNodeId(defaultUse.definition);
        const currentId = defNodeId(bodyUse.definition);
        expect(graph.nodes.has(priorId)).toBe(true);
        expect(graph.nodes.has(currentId)).toBe(true);
        expect(
          graph.edges
            .filter((edge) => edge.from === currentId && edge.label === "calls")
            .map((edge) => [edge.site?.range.start.line, edge.to])
            .sort((left, right) => Number(left[0]) - Number(right[0])),
        ).toEqual([
          [defaultLine, priorId],
          [bodyLine, currentId],
        ]);
      },
    );
  });

  it("keeps an unbound eager self-name unresolved while a deferred lambda sees the function", async () => {
    const mainSource = [
      "def missing(value=missing()):",
      "    return value",
      "def future(value=lambda: future()):",
      "    return value",
      "",
    ].join("\n");
    await withFixture("cg-py-self-default-unbound-", { "main.py": mainSource }, async (root, f) => {
      const index = await buildProjectIndex(root, { cache: "off" });
      const missing = await goToDefinition(index, {
        file: f("main.py"),
        line: 1,
        column: columnOf(mainSource, 1, "missing", true),
      });
      expect(missing.status).toBe("not_found");
      const missingReferences = await findReferences(index, { file: f("main.py"), line: 1, column: 5 });
      expect(missingReferences.status).toBe("ok");
      if (missingReferences.status !== "ok") throw new Error("Expected missing's declaration references");
      expect(sitesOf(missingReferences.references, fileIdentityKey(f("main.py")))).toEqual([[1, 5]]);

      const deferred = await goToDefinition(index, {
        file: f("main.py"),
        line: 3,
        column: columnOf(mainSource, 3, "future", true),
      });
      expect(deferred.status).toBe("ok");
      if (deferred.status !== "ok") throw new Error("Expected the deferred function binding");
      expect(deferred.definition.range.start.line).toBe(3);
      expect(deferred.definition.range.start.column).toBe(5);
      const futureReferences = await findReferences(index, { file: f("main.py"), line: 3, column: 5 });
      expect(futureReferences.status).toBe("ok");
      if (futureReferences.status !== "ok") throw new Error("Expected deferred function references");
      expect(sitesOf(futureReferences.references, fileIdentityKey(f("main.py")))).toEqual([
        [3, 5],
        [3, columnOf(mainSource, 3, "future", true)],
      ]);
    });
  });

  it.each([
    { label: "no prior local", before: [], expectedLine: undefined },
    { label: "a prior local", before: ["    def run():", "        return 1"], expectedLine: 3 },
  ])("keeps a nested self-named default within its enclosing scope with $label", async (scenario) => {
    const lines = [
      "from other import run",
      "def outer():",
      ...scenario.before,
      "    def run(value=run()):",
      "        return value",
      "    return run",
      "",
    ];
    const mainSource = lines.join("\n");
    const defaultLine = scenario.before.length + 3;
    await withFixture(
      "cg-py-nested-self-default-",
      { "main.py": mainSource, "other.py": "def run():\n    return 2\n" },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        const result = await goToDefinition(index, {
          file: f("main.py"),
          line: defaultLine,
          column: columnOf(mainSource, defaultLine, "run", true),
        });
        if (scenario.expectedLine === undefined) {
          expect(result.status).toBe("not_found");
        } else {
          expect(result.status).toBe("ok");
          if (result.status !== "ok") throw new Error("Expected the earlier enclosing local");
          expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(f("main.py")));
          expect(result.definition.range.start.line).toBe(scenario.expectedLine);
          const prior = await findReferences(index, {
            file: f("main.py"),
            line: scenario.expectedLine,
            column: columnOf(mainSource, scenario.expectedLine, "run"),
          });
          expect(prior.status).toBe("ok");
          if (prior.status !== "ok") throw new Error("Expected the earlier local references");
          expect(sitesOf(prior.references, fileIdentityKey(f("main.py")))).toEqual([
            [scenario.expectedLine, columnOf(mainSource, scenario.expectedLine, "run")],
            [defaultLine, columnOf(mainSource, defaultLine, "run", true)],
          ]);
        }
        const imported = await findReferences(index, { file: f("other.py"), line: 1, column: 5 });
        expect(imported.status).toBe("ok");
        if (imported.status !== "ok") throw new Error("Expected the external import references");
        expect(sitesOf(imported.references, fileIdentityKey(f("main.py")))).toEqual([
          [1, columnOf(mainSource, 1, "run")],
        ]);
        const current = await findReferences(index, {
          file: f("main.py"),
          line: defaultLine,
          column: columnOf(mainSource, defaultLine, "run"),
        });
        expect(current.status).toBe("ok");
        if (current.status !== "ok") throw new Error("Expected the nested function references");
        expect(sitesOf(current.references, fileIdentityKey(f("main.py")))).toEqual([
          [defaultLine, columnOf(mainSource, defaultLine, "run")],
          [defaultLine + 2, columnOf(mainSource, defaultLine + 2, "run")],
        ]);
      },
    );
  });

  it("evaluates a nested function's default with its enclosing function's runtime module binding", async () => {
    const mainSource = [
      "def helper():",
      "    return 1",
      "def outer():",
      "    def inner(value=helper()):",
      "        return value",
      "    return inner",
      "from other import helper",
      "",
    ].join("\n");
    await withFixture(
      "cg-py-nested-default-runtime-",
      { "main.py": mainSource, "other.py": otherSource },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        const result = await goToDefinition(index, {
          file: f("main.py"),
          line: 4,
          column: columnOf(mainSource, 4, "helper"),
        });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") throw new Error("Expected the runtime module import");
        expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(f("other.py")));
        expect(result.definition.range.start.line).toBe(1);

        const imported = await findReferences(index, { file: f("other.py"), line: 1, column: 5 });
        expect(imported.status).toBe("ok");
        if (imported.status !== "ok") throw new Error("Expected nested-default import references");
        expect(imported.referenceCoverage.state).toBe("complete");
        expect(sitesOf(imported.references, fileIdentityKey(f("main.py")))).toEqual(
          [4, 7].map((line) => [line, columnOf(mainSource, line, "helper")]),
        );

        const local = await findReferences(index, { file: f("main.py"), line: 1, column: 5 });
        expect(local.status).toBe("ok");
        if (local.status !== "ok") throw new Error("Expected the original helper declaration");
        expect(sitesOf(local.references, fileIdentityKey(f("main.py")))).toEqual([
          [1, columnOf(mainSource, 1, "helper")],
        ]);
      },
    );
  });

  it("keeps a local-only module-level call unresolved when its declaration follows", async () => {
    const localOnlySource = ["print(helper())", "def helper():", "    return 3", ""].join("\n");
    await withFixture("cg-py-later-local-only-", { "main.py": localOnlySource }, async (root, f) => {
      const index = await buildProjectIndex(root, { cache: "off" });
      const immediate = await goToDefinition(index, {
        file: f("main.py"),
        line: 1,
        column: columnOf(localOnlySource, 1, "helper"),
      });
      expect(immediate.status).toBe("not_found");
    });
  });

  it.each([
    [
      "a conditional suite",
      ["if True:", "    from other import helper", "print(helper())", "def helper():", "    return 3", ""],
    ],
    [
      "a type-checking guard",
      [
        "from typing import TYPE_CHECKING",
        "if TYPE_CHECKING:",
        "    from other import helper",
        "print(helper())",
        "def helper():",
        "    return 3",
        "",
      ],
    ],
    [
      "another function's suite",
      ["def setup():", "    from other import helper", "print(helper())", "def helper():", "    return 3", ""],
    ],
  ])("leaves a module-level call unresolved after %s import", async (_label, lines) => {
    const guardedSource = lines.join("\n");
    await withFixture(
      "cg-py-guarded-import-",
      { "main.py": guardedSource, "other.py": otherSource },
      async (root, f) => {
        const index = await buildProjectIndex(root, { cache: "off" });
        const callLine = lines.findIndex((line) => line.startsWith("print(helper())")) + 1;
        const immediate = await goToDefinition(index, {
          file: f("main.py"),
          line: callLine,
          column: columnOf(guardedSource, callLine, "helper"),
        });
        expect(immediate.status).toBe("not_found");
      },
    );
  });
});
