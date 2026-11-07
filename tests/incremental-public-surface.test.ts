import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  type BuildReport,
  type ModuleIndex,
  type ProjectIndex,
} from "../src/index.js";
import * as filePrep from "../src/languages/file-prep.js";
import * as specifierTargets from "../src/util/resolution/specifier-targets.js";
import { collectDirectDependents } from "../src/indexer/incremental-plan.js";
import {
  computeApiSurface,
  propagateReexportSurfaceChanges,
  publicSurfaceKind,
} from "../src/indexer/public-surface.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";

const roots = createTempRootRegistry();

afterEach(async () => {
  vi.restoreAllMocks();
  await roots.cleanup();
});

function normalize(file: string): string {
  return file.replace(/\\/g, "/");
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    const full = path.join(root, name);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, text, "utf8");
  }
}

async function indexedProject(files: Record<string, string>): Promise<string> {
  const root = await roots.create("dg-public-surface-");
  await writeFiles(root, files);
  await buildProjectIndex(root, { cache: "disk", threads: 1 });
  return root;
}

/** One incremental update, with the project-relative files it extracted again. */
async function update(root: string): Promise<{ index: ProjectIndex; extracted: string[]; report: BuildReport }> {
  const prepared = vi.spyOn(filePrep, "prepareSourceInput");
  const report: BuildReport = { timings: {} };
  const index = await buildProjectIndexIncremental(root, { cache: "disk", threads: 1, report });
  const extracted = prepared.mock.calls.map(([file]) => normalize(path.relative(root, String(file))));
  prepared.mockRestore();
  return { index, extracted: [...new Set(extracted)].sort(), report };
}

function modulesByFile(index: ProjectIndex): Record<string, ModuleIndex> {
  return Object.fromEntries(
    [...index.byFile.values()].map((mod) => [normalize(mod.file), mod] as const).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** A cold index of the edited tree, built in an empty cache. */
async function expectSameAsColdBuild(root: string, index: ProjectIndex): Promise<void> {
  const coldCache = await roots.create("dg-public-surface-cold-");
  const cold = await buildProjectIndex(root, { cache: "disk", cacheDir: coldCache, threads: 1 });
  expect(modulesByFile(index)).toEqual(modulesByFile(cold));
  expect(index.graph.edges).toEqual(expect.arrayContaining(cold.graph.edges));
  expect(index.graph.edges).toHaveLength(cold.graph.edges.length);
}

function importsOf(index: ProjectIndex, root: string, file: string): ModuleIndex["imports"] {
  const mod =
    index.byFile.get(normalize(path.join(root, file))) ??
    [...index.byFile.values()].find((m) => normalize(m.file).endsWith(`/${file}`));
  if (!mod) throw new Error(`missing module ${file}`);
  return mod.imports;
}

const TS_PROJECT = {
  "b.ts": "export function b(x: number) {\n  return x + 1;\n}\n",
  "a.ts": 'import { b } from "./b";\nexport const a = b(1);\n',
  "c.ts": 'import { a } from "./a";\nexport const c = a;\n',
  "lonely.ts": "export const lonely = 1;\n",
};

describe("incremental updates extract importers only for a changed public surface", () => {
  it("extracts only the edited file for a body edit", async () => {
    const root = await indexedProject(TS_PROJECT);
    await fsp.writeFile(
      path.join(root, "b.ts"),
      "export function b(x: number) {\n  const doubled = x * 2;\n  return doubled + 1;\n}\n",
      "utf8",
    );
    const { index, extracted, report } = await update(root);
    expect(extracted).toEqual(["b.ts"]);
    expect(report.files?.changed).toBe(1);
    expect(report.files?.parsed).toBe(1);
    await expectSameAsColdBuild(root, index);
  });

  it("extracts only the edited file for an added optional parameter", async () => {
    const root = await indexedProject(TS_PROJECT);
    await fsp.writeFile(
      path.join(root, "b.ts"),
      "export function b(x: number, extra?: number) {\n  return x + 1;\n}\n",
      "utf8",
    );
    const { index, extracted } = await update(root);
    expect(extracted).toEqual(["b.ts"]);
    await expectSameAsColdBuild(root, index);
  });

  it("extracts the direct importers of a renamed export, and not theirs", async () => {
    const root = await indexedProject(TS_PROJECT);
    await fsp.writeFile(path.join(root, "b.ts"), "export function bRenamed(x: number) {\n  return x + 1;\n}\n", "utf8");
    const { index, extracted } = await update(root);
    expect(extracted).toEqual(["a.ts", "b.ts"]);
    await expectSameAsColdBuild(root, index);
  });

  it("extracts the importers of an export that is added or removed", async () => {
    const root = await indexedProject(TS_PROJECT);
    await fsp.writeFile(
      path.join(root, "b.ts"),
      "export function b(x: number) {\n  return x + 1;\n}\nexport const extra = 2;\n",
      "utf8",
    );
    const added = await update(root);
    expect(added.extracted).toEqual(["a.ts", "b.ts"]);
    await expectSameAsColdBuild(root, added.index);

    await fsp.writeFile(
      path.join(root, "b.ts"),
      "function b(x: number) {\n  return x + 1;\n}\nexport const extra = 2;\n",
      "utf8",
    );
    const removed = await update(root);
    expect(removed.extracted).toEqual(["a.ts", "b.ts"]);
    await expectSameAsColdBuild(root, removed.index);
  });

  it("propagates a surface change through a chain of star re-exports", async () => {
    const root = await indexedProject({
      "leaf.ts": "export const leaf = 1;\nexport function run() {\n  return leaf;\n}\n",
      "mid.ts": 'export * from "./leaf";\n',
      "top.ts": 'export * from "./mid";\n',
      "use.ts": 'import { leaf } from "./top";\nexport const used = leaf;\n',
      "other.ts": "export const other = 1;\n",
    });
    await fsp.writeFile(
      path.join(root, "leaf.ts"),
      "export const leaf = 1;\nexport const leafToo = 2;\nexport function run() {\n  return leaf;\n}\n",
      "utf8",
    );
    const changed = await update(root);
    expect(changed.extracted).toEqual(["leaf.ts", "mid.ts", "top.ts", "use.ts"]);
    await expectSameAsColdBuild(root, changed.index);

    await fsp.writeFile(
      path.join(root, "leaf.ts"),
      "export const leaf = 1;\nexport const leafToo = 2;\nexport function run() {\n  const twice = leaf * 2;\n  return twice;\n}\n",
      "utf8",
    );
    const body = await update(root);
    expect(body.extracted).toEqual(["leaf.ts"]);
    await expectSameAsColdBuild(root, body.index);
  });

  it("extracts only the importer when it drops an import", async () => {
    const root = await indexedProject(TS_PROJECT);
    await fsp.writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
    const { index, extracted } = await update(root);
    expect(extracted).toEqual(["a.ts"]);
    expect(index.graph.edges.some((edge) => normalize(edge.from).endsWith("/a.ts"))).toBe(false);
    await expectSameAsColdBuild(root, index);
  });

  it("extracts the importers of an importer whose own exports changed", async () => {
    const root = await indexedProject(TS_PROJECT);
    await fsp.writeFile(path.join(root, "a.ts"), "export const a = 1;\nexport const aMore = 2;\n", "utf8");
    const { index, extracted } = await update(root);
    expect(extracted).toEqual(["a.ts", "c.ts"]);
    await expectSameAsColdBuild(root, index);
  });

  it("extracts the importers of a deleted file, and not theirs", async () => {
    const root = await indexedProject({
      "c.ts": "export const c = 1;\n",
      "b.ts": 'import { c } from "./c";\nexport const b = c;\n',
      "a.ts": 'import { b } from "./b";\nexport const a = b;\n',
    });
    await fsp.rm(path.join(root, "c.ts"));
    const { index, extracted } = await update(root);
    expect(extracted).toEqual(["b.ts"]);
    expect(importsOf(index, root, "b.ts")[0]?.resolved).toEqual({ external: "./c" });
    await expectSameAsColdBuild(root, index);
  });

  it("falls back to extracting the importers when the manifest has no recorded surface", async () => {
    const root = await indexedProject(TS_PROJECT);
    const manifestPath = path.join(root, ".codegraph", "cache", "index-v1", "manifest.json");
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as {
      files: Record<string, { surface?: string }>;
    };
    for (const entry of Object.values(manifest.files)) delete entry.surface;
    await fsp.writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    await fsp.writeFile(
      path.join(root, "b.ts"),
      "export function b(x: number) {\n  const y = x;\n  return y + 1;\n}\n",
      "utf8",
    );
    const first = await update(root);
    expect(first.extracted).toEqual(["a.ts", "b.ts"]);
    await expectSameAsColdBuild(root, first.index);

    // The update recorded the surfaces again, so the next body edit is confined to its file.
    await fsp.writeFile(
      path.join(root, "b.ts"),
      "export function b(x: number) {\n  const y = x + 2;\n  return y + 1;\n}\n",
      "utf8",
    );
    const second = await update(root);
    expect(second.extracted).toEqual(["b.ts"]);
    await expectSameAsColdBuild(root, second.index);
  });

  it("starts the worker pool for a later wave of importers that is large enough to need one", async () => {
    const files: Record<string, string> = { "hub.ts": "export const hub = 1;\n" };
    for (let index = 0; index < 40; index += 1) {
      files[`user${index}.ts`] = `import { hub } from "./hub";\nexport const user${index} = hub + ${index};\n`;
    }
    const root = await indexedProject(files);
    await fsp.writeFile(path.join(root, "hub.ts"), "export const hub = 1;\nexport const hubToo = 2;\n", "utf8");

    const { index, report } = await update(root);

    // One file starts the update, which is below the pool threshold; its 40 importers are the wave that starts it.
    expect(report.files?.changed).toBe(41);
    expect(report.workerPool?.enabled).toBe(true);
    expect(report.workerPool?.tasksSubmitted).toBe(40);
    expect(report.workerPool?.tasksFailed).toBe(0);
    await expectSameAsColdBuild(root, index);
  });
});

describe("incremental updates of star-import and declaration languages", () => {
  it("expands a Python star import again only when the target's names change", async () => {
    const root = await indexedProject({
      "pkg/__init__.py": "",
      "pkg/base.py": "def keep():\n    return 1\n\n\ndef drop():\n    return 2\n",
      "pkg/use.py": "from pkg.base import *\n\nvalue = keep()\n",
    });
    const names = (index: ProjectIndex): string[] =>
      importsOf(index, root, "pkg/use.py")
        .flatMap((binding) => (binding.kind === "named" ? [binding.local] : []))
        .sort();

    await fsp.writeFile(
      path.join(root, "pkg/base.py"),
      "def keep():\n    return 100\n\n\ndef drop():\n    return 200\n",
      "utf8",
    );
    const body = await update(root);
    expect(body.extracted).toEqual(["pkg/base.py"]);
    expect(names(body.index)).toEqual(["drop", "keep"]);
    await expectSameAsColdBuild(root, body.index);

    await fsp.writeFile(
      path.join(root, "pkg/base.py"),
      "def keep():\n    return 100\n\n\ndef fresh():\n    return 3\n",
      "utf8",
    );
    const renamed = await update(root);
    expect(renamed.extracted).toEqual(["pkg/base.py", "pkg/use.py"]);
    expect(names(renamed.index)).toEqual(["fresh", "keep"]);
    await expectSameAsColdBuild(root, renamed.index);
  });

  it("re-resolves the importers of a Java file whose package changes", async () => {
    const root = await indexedProject({
      "q/B.java": "package q;\n\npublic class B {\n  public void run() {}\n}\n",
      "p/A.java": "package p;\n\nimport q.B;\n\npublic class A {\n  B field;\n}\n",
      "p/C.java": "package p;\n\npublic class C {\n  A held;\n}\n",
    });
    await fsp.writeFile(
      path.join(root, "q/B.java"),
      "package q2;\n\npublic class B {\n  public void run() {}\n}\n",
      "utf8",
    );
    const { index, extracted } = await update(root);
    expect(extracted).toEqual(expect.arrayContaining(["p/A.java", "q/B.java"]));
    await expectSameAsColdBuild(root, index);
  });

  it("extracts the transitive importers of a Java file again, because they resolve through its declarations", async () => {
    const root = await indexedProject({
      "q/B.java": "package q;\n\npublic class B {\n  public void run() {}\n}\n",
      "p/A.java": "package p;\n\nimport q.B;\n\npublic class A {\n  B field;\n}\n",
      "r/C.java": "package r;\n\nimport p.A;\n\npublic class C {\n  A held;\n}\n",
    });
    await fsp.writeFile(
      path.join(root, "q/B.java"),
      "package q;\n\npublic class B {\n  public void run() {\n    int steps = 1;\n  }\n}\n",
      "utf8",
    );
    const { index, extracted } = await update(root);
    expect(extracted).toEqual(["p/A.java", "q/B.java", "r/C.java"]);
    await expectSameAsColdBuild(root, index);
  });

  it("extracts the transitive importers of a Python package initializer again", async () => {
    const root = await indexedProject({
      "pkg/__init__.py": "from .base import value\n",
      "pkg/base.py": "value = 1\n",
      "pkg/use.py": "from pkg import value\n\nused = value\n",
      "top.py": "from pkg.use import used\n\nseen = used\n",
    });
    await fsp.writeFile(path.join(root, "pkg/__init__.py"), "# edited\nfrom .base import value\n", "utf8");
    const { index, extracted } = await update(root);
    expect(extracted).toEqual(["pkg/__init__.py", "pkg/use.py", "top.py"]);
    await expectSameAsColdBuild(root, index);
  });

  it("expands a C include again only when the header's names or tags change", async () => {
    const root = await indexedProject({
      "a.h": "struct foo { int x; };\nint f(int v);\n",
      "b.c": '#include "a.h"\nint g(void) {\n  struct foo s;\n  return f(s.x);\n}\n',
      "d.c": '#include "b.c"\nint h(void) {\n  return g();\n}\n',
    });
    const bound = (index: ProjectIndex): string[] =>
      importsOf(index, root, "b.c")
        .flatMap((binding) => (binding.kind === "named" ? [`${binding.local}/${binding.cNamespace}`] : []))
        .sort();

    await fsp.writeFile(path.join(root, "a.h"), "/* edited */\nstruct foo { int x; };\nint f(int v);\n", "utf8");
    const comment = await update(root);
    expect(comment.extracted).toEqual(["a.h"]);
    expect(bound(comment.index)).toEqual(["f/ordinary", "foo/tag"]);
    await expectSameAsColdBuild(root, comment.index);

    await fsp.writeFile(path.join(root, "a.h"), "typedef struct foo { int x; } foo;\nint f(int v);\n", "utf8");
    const retyped = await update(root);
    expect(retyped.extracted).toEqual(["a.h", "b.c"]);
    expect(bound(retyped.index)).toEqual(["f/ordinary", "foo/ordinary", "foo/tag"]);
    await expectSameAsColdBuild(root, retyped.index);
  });

  it("expands a Ruby require again only when the required file's top-level names change", async () => {
    const root = await indexedProject({
      "base.rb": "class Base\n  def run\n    1\n  end\nend\n\ndef helper\n  2\nend\n",
      "use.rb": "require_relative 'base'\n\nclass Use < Base\n  def go\n    helper\n  end\nend\n",
      "top.rb": "require_relative 'use'\n\nUse.new.go\n",
    });
    const bound = (index: ProjectIndex): string[] => {
      const names: string[] = [];
      for (const binding of importsOf(index, root, "use.rb")) {
        if (binding.kind === "named") names.push(binding.local);
        else if (binding.kind === "namespace") names.push(binding.localNS);
      }
      return names.sort();
    };

    await fsp.writeFile(
      path.join(root, "base.rb"),
      "class Base\n  def run\n    42\n  end\nend\n\ndef helper\n  2\nend\n",
      "utf8",
    );
    const body = await update(root);
    expect(body.extracted).toEqual(["base.rb"]);
    expect(bound(body.index)).toEqual(["Base", "helper"]);
    await expectSameAsColdBuild(root, body.index);

    await fsp.writeFile(
      path.join(root, "base.rb"),
      "class Base\n  def run\n    42\n  end\nend\n\nclass Extra\nend\n\ndef helper\n  2\nend\n",
      "utf8",
    );
    const added = await update(root);
    expect(added.extracted).toEqual(["base.rb", "use.rb"]);
    expect(bound(added.index)).toEqual(["Base", "Extra", "helper"]);
    await expectSameAsColdBuild(root, added.index);
  });
});

describe("public surface signatures", () => {
  async function surfaceOf(files: Record<string, string>, file: string): Promise<string> {
    const root = await roots.create("dg-public-surface-sig-");
    await writeFiles(root, files);
    const index = await buildProjectIndex(root, { cache: "off", threads: 1 });
    const mod = [...index.byFile.values()].find((candidate) => normalize(candidate.file).endsWith(`/${file}`));
    if (!mod) throw new Error(`missing module ${file}`);
    return computeApiSurface(mod, root);
  }

  const base = { "m.ts": "export function f(a: number) {\n  return a;\n}\nexport const k = 1;\n" };

  it("ignores bodies, signatures, and positions", async () => {
    const reference = await surfaceOf(base, "m.ts");
    const edited = {
      "m.ts":
        "// a new first line\nexport function f(a: number, b?: string) {\n  const t = a;\n  return t;\n}\nexport const k = 1;\n",
    };
    expect(await surfaceOf(edited, "m.ts")).toBe(reference);
  });

  it("changes with an exported name, an exported kind, or a re-export source", async () => {
    const reference = await surfaceOf(base, "m.ts");
    expect(
      await surfaceOf({ "m.ts": "export function g(a: number) {\n  return a;\n}\nexport const k = 1;\n" }, "m.ts"),
    ).not.toBe(reference);
    expect(await surfaceOf({ "m.ts": "export class f {}\nexport const k = 1;\n" }, "m.ts")).not.toBe(reference);
    expect(
      await surfaceOf({ "m.ts": "function f(a: number) {\n  return a;\n}\nexport const k = 1;\n" }, "m.ts"),
    ).not.toBe(reference);

    const reexport = { "x.ts": "export const x = 1;\n", "y.ts": "export const y = 1;\n" };
    const viaX = await surfaceOf({ ...reexport, "r.ts": 'export * from "./x";\n' }, "r.ts");
    const viaY = await surfaceOf({ ...reexport, "r.ts": 'export * from "./y";\n' }, "r.ts");
    expect(viaX).not.toBe(viaY);
  });

  it("covers the locals that a star import binds when a file exports nothing", async () => {
    const reference = await surfaceOf({ "s.js": "function one() {}\n" }, "s.js");
    expect(await surfaceOf({ "s.js": "function one() {}\nfunction two() {}\n" }, "s.js")).not.toBe(reference);
    expect(await surfaceOf({ "s.js": "function one() {\n  return 1;\n}\n" }, "s.js")).toBe(reference);
  });

  it("classifies files whose dependents read their declarations as content surfaces", () => {
    for (const file of ["A.java", "B.kt", "C.cs", "d.php", "e.cpp", "f.rs", "pkg/__init__.py", "pkg/__init__.pyi"]) {
      expect(publicSurfaceKind(file)).toBe("content");
    }
    for (const file of ["a.ts", "b.tsx", "c.js", "d.go", "pkg/mod.py", "e.scss", "f.c", "g.rb", "README.md"]) {
      expect(publicSurfaceKind(file)).toBe("api");
    }
    expect(publicSurfaceKind("legacy.jvm", { ".jvm": "kotlin" })).toBe("content");
  });
});

describe("surface dependents", () => {
  it("lists direct importers only", () => {
    const reverseDeps = new Map<string, Set<string>>([
      ["/p/c.ts", new Set(["/p/b.ts"])],
      ["/p/b.ts", new Set(["/p/a.ts"])],
    ]);
    expect(collectDirectDependents(reverseDeps, ["/p/c.ts"])).toEqual(new Set(["/p/b.ts"]));
    expect(collectDirectDependents(reverseDeps, ["/p/c.ts", "/p/b.ts"])).toEqual(new Set(["/p/b.ts", "/p/a.ts"]));
  });

  it("closes a surface change under re-exports, including cycles", async () => {
    const root = await roots.create("dg-public-surface-cycle-");
    await writeFiles(root, {
      "a.ts": 'export * from "./b";\n',
      "b.ts": 'export * from "./a";\nexport * from "./c";\n',
      "c.ts": "export const c = 1;\n",
      "d.ts": 'import { c } from "./c";\nexport const d = c;\n',
    });
    const index = await buildProjectIndex(root, { cache: "off", threads: 1 });
    const keyOf = (name: string): string => {
      const mod = [...index.byFile.entries()].find(([, candidate]) => normalize(candidate.file).endsWith(`/${name}`));
      if (!mod) throw new Error(`missing module ${name}`);
      return mod[0];
    };
    const changed = new Set([keyOf("c.ts")]);
    propagateReexportSurfaceChanges(index.byFile, changed);
    expect(changed).toEqual(new Set([keyOf("c.ts"), keyOf("b.ts"), keyOf("a.ts")]));
  });
});

describe("declaration import rechecks are bounded by newly declared names", () => {
  const externalImportFiles = (): Record<string, string> => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 40; index += 1) {
      files[`units/C${index}.cs`] = [
        "using System;",
        "using System.Linq;",
        "namespace Bench;",
        `public class C${index} { public int Value() => 1; }`,
        "",
      ].join("\n");
    }
    return files;
  };

  it("does no unrelated import-resolution work after a body-only C# edit beside many external imports", async () => {
    const files = externalImportFiles();
    const root = await indexedProject(files);
    const edited = path.join(root, "units/C0.cs");
    const resolve = vi.spyOn(specifierTargets, "resolveSpecifierTargets");
    await fsp.writeFile(edited, files["units/C0.cs"]!.replace("=> 1;", "=> 2;"), "utf8");
    const { index, extracted, report } = await update(root);
    expect(extracted).toEqual(["units/C0.cs"]);
    expect(report.files).toMatchObject({ total: 40, parsed: 1, changed: 1, cached: 39 });
    const unrelatedLookups = resolve.mock.calls.filter(([file]) => normalize(file) !== normalize(edited));
    expect(unrelatedLookups).toEqual([]);
    resolve.mockRestore();
    await expectSameAsColdBuild(root, index);
  });

  it("rechecks only the newly named alias target after a C# rename beside many external imports", async () => {
    const root = await indexedProject({
      ...externalImportFiles(),
      "lib/Library.cs": "namespace Lib;\npublic class Different {}\n",
      "app/Use.cs": "using Gadget = Lib.Gadget;\nclass Use { Gadget value; }\n",
    });
    const edited = path.join(root, "lib/Library.cs");
    const consumer = path.join(root, "app/Use.cs");
    const resolve = vi.spyOn(specifierTargets, "resolveSpecifierTargets");
    await fsp.writeFile(edited, "namespace Lib;\npublic class Gadget {}\n", "utf8");
    const { index, extracted, report } = await update(root);
    expect(extracted).toEqual(["app/Use.cs", "lib/Library.cs"]);
    expect(report.files).toMatchObject({ total: 42, parsed: 2, changed: 2, cached: 40 });
    const unrelatedLookups = resolve.mock.calls.filter(([file]) => {
      const normalized = normalize(file);
      return normalized !== normalize(edited) && normalized !== normalize(consumer);
    });
    expect(unrelatedLookups).toEqual([]);
    expect(
      resolve.mock.calls.some(
        ([file, specifier]) => normalize(file) === normalize(consumer) && specifier === "Lib.Gadget",
      ),
    ).toBe(true);
    resolve.mockRestore();
    await expectSameAsColdBuild(root, index);
  });
});
