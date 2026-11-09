import path from "node:path";
import { expect } from "vitest";
import type { SymbolGraph } from "../../src/graphs/symbol-graph.js";
import { findReferences, goToDefinition } from "../../src/indexer/navigation.js";
import type { ProjectIndex } from "../../src/indexer/types.js";
import { normalizePath } from "../../src/util/paths.js";
import { lines, positionOf, type Site } from "./qualified-base-fixture.js";

/**
 * An unaliased Python `import pkg.mod` binds the package `pkg`: `pkg.x` is an attribute of `pkg/__init__.py`, `pkg.mod`
 * is the submodule, and `pkg.mod.x` an attribute of it. The package and the submodule declare the same names, so a use
 * that reads the wrong module answers with a same-named decoy. The sources were run on CPython 3.13: `pkg.helper()` is
 * `"init"`, `pkg.mod.helper()` is `"mod"`, `pkg.mod_only` raises `AttributeError`, `pkg.Thing` is the package's class,
 * `pkg.mod` is the submodule although `pkg/__init__.py` declares a function `mod` (the import rebinds the attribute), and
 * a package with no `__init__.py` (`nspkg`) has the attribute `mod` and nothing else.
 */
export const PYTHON_DOTTED_IMPORT_FILES: Readonly<Record<string, string>> = {
  "pkg/__init__.py": lines(
    "class Base:",
    "    def init_only(self):",
    '        return "init"',
    "    def identify(self):",
    '        return "pkg"',
    "",
    "",
    "",
    "class Thing:",
    "    pass",
    "",
    "",
    "def helper():",
    '    return "init"',
    "",
    "",
    "def init_func():",
    '    return "init"',
    "",
    "",
    "# `import pkg.mod` rebinds this name to the submodule once the package has loaded.",
    "def mod():",
    '    return "init"',
    "",
    "",
    "def sub():",
    '    return "package sub"',
  ),
  "pkg/mod.py": lines(
    "class Base:",
    "    def pkg_only(self):",
    '        return "mod"',
    "",
    "",
    "class Thing:",
    "    pass",
    "",
    "",
    "def helper():",
    '    return "mod"',
    "",
    "",
    "def mod_only():",
    '    return "mod"',
  ),
  "pkg/sub/__init__.py": lines("def sub_helper():", '    return "sub"'),
  "pkg/sub/mod.py": lines("def deep_helper():", '    return "deep"'),
  "nspkg/mod.py": lines("def ns_helper():", '    return "ns"'),
  "other/__init__.py": lines(
    "from . import sub",
    "",
    "class Base:",
    "    def identify(self):",
    '        return "other"',
  ),
  "other/sub.py": lines("def helper():", '    return "other"'),
  "use_rebound.py": lines(
    "import pkg.mod",
    "import other as pkg",
    "",
    "class Child(pkg.Base):",
    "    def go(self):",
    "        return self.identify()",
    "",
    "def run():",
    "    return pkg.sub.helper()",
    "",
    "def shadow(pkg):",
    "    return pkg.mod.helper()",
  ),
  "use_before_rebind.py": lines(
    "import pkg.mod",
    "class Before(pkg.Base):",
    "    pass",
    "import other as pkg",
    "class After(pkg.Base):",
    "    pass",
  ),
  "use_function_rebind.py": lines(
    "import pkg.mod",
    "def rebound():",
    "    import other as pkg",
    "    return pkg.sub.helper()",
    "def early():",
    "    value = pkg.mod.helper()",
    "    import other as pkg",
    "    return value",
    "def bound():",
    "    import pkg.mod",
    "    value = pkg.mod.helper()",
    "    import other as pkg",
    "    return value",
  ),
  "lazy.py": lines(
    "import pkg as p",
    "def load():",
    "    import pkg.sub.mod",
    "def run():",
    "    return p.sub()",
    "def after():",
    "    import pkg.sub.mod",
    "    return p.sub()",
  ),
  "order.py": lines("import pkg as p", "first = p.sub()", "import pkg.sub.mod", "def after():", "    return p.sub()"),
  "conditional.py": lines("import pkg as p", "if False:", "    import pkg.sub.mod", "def run():", "    return p.sub()"),
  "use_one.py": lines(
    "import pkg.mod",
    "",
    "",
    "def run():",
    "    pkg.helper()",
    "    pkg.mod.helper()",
    "    pkg.mod_only()",
    "    pkg.init_func()",
    "    return pkg.Thing()",
    "",
    "",
    "class A(pkg.Base):",
    "    def go(self):",
    "        return self.init_only()",
    "",
    "",
    "class B(pkg.mod.Base):",
    "    def go(self):",
    "        return self.pkg_only()",
  ),
  "use_deep.py": lines(
    "import pkg.sub.mod",
    "",
    "",
    "def run():",
    "    pkg.sub.sub_helper()",
    "    pkg.sub.mod.deep_helper()",
    "    pkg.helper()",
  ),
  "use_alias.py": lines("import pkg.mod as m", "", "", "def run():", "    m.helper()", "    m.init_func()"),
  "use_plain.py": lines("import pkg", "", "", "def run():", "    pkg.helper()"),
  "use_both.py": lines(
    "import pkg.mod",
    "import pkg",
    "",
    "",
    "def run():",
    "    pkg.helper()",
    "    pkg.mod.helper()",
  ),
  "use_both2.py": lines(
    "import pkg",
    "import pkg.mod",
    "",
    "",
    "def run():",
    "    pkg.helper()",
    "    pkg.mod.helper()",
  ),
  "use_ns.py": lines("import nspkg.mod", "", "", "def run():", "    nspkg.mod.ns_helper()", "    nspkg.ns_helper()"),
};

type GotoCase = Site & { expect: string | null };
type ReferencesCase = Site & {
  includes: readonly string[];
  excludes: readonly string[];
  coverage: "complete" | "partial";
};

/** Where go-to-definition lands as `name@file`, or `null` for `not_found`. */
const GOTOS: readonly GotoCase[] = [
  { file: "use_one.py", marker: "helper()", occurrence: 0, expect: "helper@pkg/__init__.py" },
  { file: "use_one.py", marker: "helper()", occurrence: 1, expect: "helper@pkg/mod.py" },
  { file: "use_one.py", marker: "mod_only()", expect: null },
  { file: "use_one.py", marker: "init_func()", expect: "init_func@pkg/__init__.py" },
  { file: "use_one.py", marker: "Thing()", expect: "Thing@pkg/__init__.py" },
  { file: "use_one.py", marker: "pkg.Base", offset: 4, expect: "Base@pkg/__init__.py" },
  { file: "use_one.py", marker: "pkg.mod.Base", offset: 8, expect: "Base@pkg/mod.py" },
  { file: "use_one.py", marker: "init_only()", expect: "init_only@pkg/__init__.py" },
  { file: "use_one.py", marker: "pkg_only()", expect: "pkg_only@pkg/mod.py" },
  // The name `pkg` itself is the package, in the import statement and at a use: it lands on the first export of
  // `pkg/__init__.py`.
  { file: "use_one.py", marker: "pkg", occurrence: 0, expect: "Base@pkg/__init__.py" },
  { file: "use_one.py", marker: "pkg", occurrence: 1, expect: "Base@pkg/__init__.py" },
  { file: "use_deep.py", marker: "sub_helper()", expect: "sub_helper@pkg/sub/__init__.py" },
  { file: "use_deep.py", marker: "deep_helper()", expect: "deep_helper@pkg/sub/mod.py" },
  { file: "use_deep.py", marker: "helper()", occurrence: 2, expect: "helper@pkg/__init__.py" },
  { file: "use_alias.py", marker: "helper()", expect: "helper@pkg/mod.py" },
  { file: "use_alias.py", marker: "init_func()", expect: null },
  { file: "use_plain.py", marker: "helper()", expect: "helper@pkg/__init__.py" },
  { file: "use_both.py", marker: "helper()", occurrence: 0, expect: "helper@pkg/__init__.py" },
  { file: "use_both.py", marker: "helper()", occurrence: 1, expect: "helper@pkg/mod.py" },
  { file: "use_both2.py", marker: "helper()", occurrence: 0, expect: "helper@pkg/__init__.py" },
  { file: "use_both2.py", marker: "helper()", occurrence: 1, expect: "helper@pkg/mod.py" },
  { file: "use_rebound.py", marker: "pkg.Base", offset: 4, expect: "Base@other/__init__.py" },
  { file: "use_rebound.py", marker: "identify()", expect: "identify@other/__init__.py" },
  { file: "use_rebound.py", marker: "helper()", occurrence: 0, expect: "helper@other/sub.py" },
  { file: "use_rebound.py", marker: "helper()", occurrence: 1, expect: null },
  { file: "use_function_rebind.py", marker: "helper()", occurrence: 0, expect: "helper@other/sub.py" },
  { file: "use_function_rebind.py", marker: "helper()", occurrence: 1, expect: null },
  { file: "use_function_rebind.py", marker: "helper()", occurrence: 2, expect: "helper@pkg/mod.py" },
  { file: "use_before_rebind.py", marker: "pkg.Base", occurrence: 0, offset: 4, expect: "Base@pkg/__init__.py" },
  { file: "use_before_rebind.py", marker: "pkg.Base", occurrence: 1, offset: 4, expect: "Base@other/__init__.py" },
  { file: "lazy.py", marker: "sub()", occurrence: 0, expect: "sub@pkg/__init__.py" },
  { file: "order.py", marker: "sub()", occurrence: 0, expect: "sub@pkg/__init__.py" },
  { file: "conditional.py", marker: "sub()", expect: "sub@pkg/__init__.py" },
  // A package with no `__init__.py` names its submodule by the whole phrase and nothing else.
  { file: "use_ns.py", marker: "ns_helper()", occurrence: 0, expect: "ns_helper@nspkg/mod.py" },
  { file: "use_ns.py", marker: "ns_helper()", occurrence: 1, expect: null },
  // The package has no file for its own name to land on.
  { file: "use_ns.py", marker: "nspkg", occurrence: 0, expect: null },
  { file: "use_ns.py", marker: "nspkg", occurrence: 2, expect: null },
];

/** `includes` and `excludes` are `file:line` entries; `coverage` is the state `findReferences` must report. */
const REFERENCES: readonly ReferencesCase[] = [
  {
    file: "pkg/__init__.py",
    marker: "helper",
    includes: ["use_one.py:5", "use_deep.py:7", "use_plain.py:5", "use_both.py:6", "use_both2.py:6"],
    excludes: ["use_one.py:6", "use_alias.py:5", "use_both.py:7", "use_both2.py:7"],
    coverage: "complete",
  },
  {
    file: "pkg/mod.py",
    marker: "helper",
    includes: ["use_one.py:6", "use_alias.py:5", "use_both.py:7", "use_both2.py:7", "use_function_rebind.py:11"],
    excludes: [
      "use_one.py:5",
      "use_deep.py:7",
      "use_plain.py:5",
      "use_both.py:6",
      "use_both2.py:6",
      "use_function_rebind.py:6",
    ],
    coverage: "complete",
  },
  {
    file: "other/__init__.py",
    marker: "Base",
    includes: ["use_rebound.py:4", "use_before_rebind.py:5"],
    excludes: ["use_before_rebind.py:2"],
    coverage: "complete",
  },
  {
    file: "other/__init__.py",
    marker: "identify",
    includes: ["use_rebound.py:6"],
    excludes: [],
    coverage: "complete",
  },
  {
    file: "other/sub.py",
    marker: "helper",
    includes: ["use_rebound.py:9", "use_function_rebind.py:4"],
    excludes: ["use_rebound.py:12"],
    coverage: "complete",
  },
  {
    file: "pkg/__init__.py",
    marker: "def sub",
    offset: 4,
    includes: ["lazy.py:5", "order.py:2", "conditional.py:5"],
    excludes: ["lazy.py:8", "order.py:5", "use_deep.py:5", "use_rebound.py:9"],
    coverage: "complete",
  },
  { file: "pkg/__init__.py", marker: "Thing", includes: ["use_one.py:9"], excludes: [], coverage: "complete" },
  { file: "pkg/mod.py", marker: "Thing", includes: [], excludes: ["use_one.py:9"], coverage: "complete" },
  {
    file: "pkg/__init__.py",
    marker: "Base",
    includes: ["use_one.py:12", "use_before_rebind.py:2"],
    excludes: ["use_one.py:17", "use_before_rebind.py:5", "use_rebound.py:4"],
    coverage: "complete",
  },
  {
    file: "pkg/__init__.py",
    marker: "identify",
    includes: [],
    excludes: ["use_rebound.py:6"],
    coverage: "complete",
  },
  {
    file: "pkg/mod.py",
    marker: "Base",
    includes: ["use_one.py:17"],
    excludes: ["use_one.py:12"],
    coverage: "complete",
  },
  {
    file: "pkg/__init__.py",
    marker: "init_func",
    includes: ["use_one.py:8"],
    excludes: ["use_alias.py:6"],
    coverage: "complete",
  },
  // `import pkg.mod` makes `pkg.mod` the submodule, so these uses are not references to the package's function `mod`.
  {
    file: "pkg/__init__.py",
    marker: "def mod",
    offset: 4,
    includes: [],
    excludes: ["use_one.py:6", "use_both.py:7", "use_both2.py:7"],
    coverage: "complete",
  },
  { file: "pkg/mod.py", marker: "mod_only", includes: [], excludes: ["use_one.py:7"], coverage: "complete" },
  { file: "pkg/__init__.py", marker: "init_only", includes: ["use_one.py:14"], excludes: [], coverage: "complete" },
  { file: "pkg/mod.py", marker: "pkg_only", includes: ["use_one.py:19"], excludes: [], coverage: "complete" },
  {
    file: "pkg/sub/__init__.py",
    marker: "sub_helper",
    includes: ["use_deep.py:5"],
    excludes: [],
    coverage: "complete",
  },
  { file: "pkg/sub/mod.py", marker: "deep_helper", includes: ["use_deep.py:6"], excludes: [], coverage: "complete" },
  {
    file: "nspkg/mod.py",
    marker: "ns_helper",
    includes: ["use_ns.py:5"],
    excludes: ["use_ns.py:6"],
    coverage: "complete",
  },
];

/** The calls, constructions, and bases the graph records from the consumer files, `from -label-> to`. */
const EDGES: readonly string[] = [
  "A@use_one.py -extends-> Base@pkg/__init__.py",
  "B@use_one.py -extends-> Base@pkg/mod.py",
  "Before@use_before_rebind.py -extends-> Base@pkg/__init__.py",
  "After@use_before_rebind.py -extends-> Base@other/__init__.py",
  "Child@use_rebound.py -extends-> Base@other/__init__.py",
  "go@use_rebound.py -calls-> identify@other/__init__.py",
  "run@use_rebound.py -calls-> helper@other/sub.py",
  "rebound@use_function_rebind.py -calls-> helper@other/sub.py",
  "bound@use_function_rebind.py -calls-> helper@pkg/mod.py",
  "go@use_one.py -calls-> init_only@pkg/__init__.py",
  "go@use_one.py -calls-> pkg_only@pkg/mod.py",
  "run@use_alias.py -calls-> helper@pkg/mod.py",
  "run@use_both.py -calls-> helper@pkg/__init__.py",
  "run@use_both.py -calls-> helper@pkg/mod.py",
  "run@use_both2.py -calls-> helper@pkg/__init__.py",
  "run@use_both2.py -calls-> helper@pkg/mod.py",
  "run@use_deep.py -calls-> deep_helper@pkg/sub/mod.py",
  "run@use_deep.py -calls-> helper@pkg/__init__.py",
  "run@use_deep.py -calls-> sub_helper@pkg/sub/__init__.py",
  "run@use_ns.py -calls-> ns_helper@nspkg/mod.py",
  "run@use_one.py -calls-> Thing@pkg/__init__.py",
  "run@use_one.py -calls-> helper@pkg/__init__.py",
  "run@use_one.py -calls-> helper@pkg/mod.py",
  "run@use_one.py -calls-> init_func@pkg/__init__.py",
  "run@use_plain.py -calls-> helper@pkg/__init__.py",
];

/** Edges no consumer may record under any label: a package attribute that is not there, or the decoy's. */
const ABSENT_EDGES: readonly string[] = [
  "run@use_one.py -calls-> mod_only@pkg/mod.py",
  "run@use_one.py -uses-> mod_only@pkg/mod.py",
  "run@use_one.py -uses-> Thing@pkg/mod.py",
  "run@use_alias.py -uses-> init_func@pkg/__init__.py",
  "run@use_one.py -uses-> mod@pkg/__init__.py",
  "run@use_both.py -uses-> mod@pkg/__init__.py",
  "run@use_both2.py -uses-> mod@pkg/__init__.py",
  "Child@use_rebound.py -extends-> Base@pkg/__init__.py",
  "After@use_before_rebind.py -extends-> Base@pkg/__init__.py",
  "Before@use_before_rebind.py -extends-> Base@other/__init__.py",
  "go@use_rebound.py -calls-> identify@pkg/__init__.py",
  "run@use_rebound.py -calls-> sub_helper@pkg/sub/__init__.py",
  "shadow@use_rebound.py -calls-> helper@pkg/mod.py",
  "early@use_function_rebind.py -calls-> helper@pkg/mod.py",
];

const CALL_LABELS: Readonly<Record<string, true>> = { calls: true, instantiates: true, extends: true };

/**
 * Asserts, from an index of `PYTHON_DOTTED_IMPORT_FILES` rooted at `root`, that go-to-definition, references with their
 * coverage state, and the detailed graph agree on which module each spelling after an unaliased dotted import names.
 */
export async function expectPythonDottedImports(
  root: string,
  index: ProjectIndex,
  graph: SymbolGraph,
  phase: string,
): Promise<void> {
  const relative = (file: string): string => path.posix.relative(normalizePath(root), normalizePath(file));
  const keyOf = (id: string): string => {
    const node = graph.nodes.get(id);
    return node ? `${node.name}@${relative(node.file)}` : "<missing>";
  };

  for (const site of GOTOS) {
    const result = await goToDefinition(index, {
      file: path.join(root, site.file),
      ...positionOf(PYTHON_DOTTED_IMPORT_FILES, site),
    });
    const actual = result.status === "ok" ? `${result.definition.localName}@${relative(result.definition.file)}` : null;
    expect(actual, `${phase} go to ${site.file} ${site.marker}#${site.occurrence ?? 0}`).toBe(site.expect);
  }

  for (const site of REFERENCES) {
    const result = await findReferences(index, {
      file: path.join(root, site.file),
      ...positionOf(PYTHON_DOTTED_IMPORT_FILES, site),
    });
    if (result.status !== "ok") throw new Error(`${phase}: no references for ${site.file} ${site.marker}`);
    const uses = result.references.map((reference) => `${relative(reference.file)}:${reference.range.start.line}`);
    const where = `${phase} references of ${site.file} ${site.marker}`;
    for (const included of site.includes) expect(uses, where).toContain(included);
    for (const excluded of site.excludes) expect(uses, where).not.toContain(excluded);
    expect(result.referenceCoverage.state, `${where} coverage`).toBe(site.coverage);
  }

  const consumerEdges = graph.edges.flatMap((edge) => {
    const from = graph.nodes.get(edge.from);
    if (!from || !relative(from.file).startsWith("use_")) return [];
    return [{ label: edge.label ?? "", text: `${keyOf(edge.from)} -${edge.label ?? ""}-> ${keyOf(edge.to)}` }];
  });
  const recorded = consumerEdges.filter((edge) => CALL_LABELS[edge.label]).map((edge) => edge.text);
  expect([...new Set(recorded)].sort(), `${phase} calls and bases`).toEqual([...EDGES].sort());
  const everyEdge = new Set(consumerEdges.map((edge) => edge.text));
  for (const absent of ABSENT_EDGES) expect(everyEdge.has(absent), `${phase} no edge ${absent}`).toBe(false);
}
