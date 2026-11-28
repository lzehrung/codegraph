import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProjectIndex } from "../src/index.js";
import type { ProjectIndex } from "../src/indexer/types.js";
import { runWithProbeCache } from "../src/util/fs-probe-cache.js";
import { fileIdentityKey, normalizePath } from "../src/util/paths.js";
import { clearResolutionCaches } from "../src/util/resolution.js";
import { resolvePythonModule, resolvePythonSubmoduleExact } from "../src/util/resolution/python.js";
import { createTempRootRegistry, tryCreateDirectorySymlink, tryCreateFileSymlink } from "./helpers/filesystem.js";

const roots = createTempRootRegistry();

afterEach(async () => {
  vi.restoreAllMocks();
  clearResolutionCaches();
  await roots.cleanup();
});

async function write(root: string, relative: string, content: string): Promise<string> {
  const target = path.join(root, ...relative.split("/"));
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content, "utf8");
  return target;
}

type SyncProbe = { api: "statSync" | "readdirSync" | "readFileSync"; target: string };

/** Records the synchronous probes of paths under `root` (project-relative, slash-separated) made after this call. */
function recordSyncProbes(root: string): SyncProbe[] {
  const calls: SyncProbe[] = [];
  const record = (api: SyncProbe["api"], target: unknown): void => {
    if (typeof target !== "string") return;
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return;
    calls.push({ api, target: normalizePath(relative) || "." });
  };
  const original = {
    statSync: fs.statSync.bind(fs),
    readdirSync: fs.readdirSync.bind(fs),
    readFileSync: fs.readFileSync.bind(fs),
  };
  vi.spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
    record("statSync", args[0]);
    return original.statSync(...args);
  }) as typeof fs.statSync);
  vi.spyOn(fs, "readdirSync").mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
    record("readdirSync", args[0]);
    return original.readdirSync(...args);
  }) as typeof fs.readdirSync);
  vi.spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    record("readFileSync", args[0]);
    return original.readFileSync(...args);
  }) as typeof fs.readFileSync);
  return calls;
}

function countProbes(calls: readonly SyncProbe[], api: SyncProbe["api"], target: string): number {
  return calls.filter((call) => call.api === api && call.target === target).length;
}

/** Each import binding of `file` as `kind local -> target`, with project-relative file targets. */
function bindingsOf(index: ProjectIndex, root: string, relative: string): string[] {
  const key = fileIdentityKey(path.join(root, relative));
  const module = [...index.byFile.values()].find((candidate) => fileIdentityKey(candidate.file) === key);
  if (!module) throw new Error(`Missing module ${relative}`);
  return module.imports.map((binding) => {
    let local = "";
    if ("local" in binding) local = binding.local;
    else if ("localNS" in binding) local = binding.localNS;
    const resolved = binding.resolved;
    let target = "unresolved";
    if (typeof resolved === "string") target = normalizePath(path.relative(root, resolved));
    else if (resolved) target = `external:${resolved.external}`;
    return `${binding.kind} ${local} -> ${target}`;
  });
}

async function build(root: string): Promise<ProjectIndex> {
  return await buildProjectIndex(root, { cache: "off", logLevel: "silent" });
}

describe("Python import probes in one build", () => {
  const IMPORTERS = 30;

  it("lists each package directory and reads each initializer once however many files import them", async () => {
    const root = await roots.create("cg-py-probe-count-");
    await write(root, "pyproject.toml", "[project]\nname = 'probe'\n");
    await write(root, "pkg/__init__.py", "from .core import Engine\n");
    await write(root, "pkg/core.py", "class Engine:\n    pass\n");
    await write(root, "pkg/sub/__init__.py", "");
    await write(root, "pkg/sub/leaf.py", "def grow():\n    return 1\n");
    const importer = "from pkg import core\nfrom pkg import sub\nfrom pkg.sub import leaf\nfrom pkg import Engine\n";
    for (let index = 0; index < IMPORTERS; index += 1) await write(root, `app/m${index}.py`, importer);
    const calls = recordSyncProbes(root);

    const index = await build(root);

    for (let file = 0; file < IMPORTERS; file += 1) {
      expect(bindingsOf(index, root, `app/m${file}.py`)).toEqual([
        "namespace core -> pkg/core.py",
        "namespace sub -> pkg/sub/__init__.py",
        "namespace leaf -> pkg/sub/leaf.py",
        "named Engine -> pkg/__init__.py",
      ]);
    }
    // Before, each import statement listed its package again and each importing file reparsed the initializer:
    // 30 importers listed `pkg` 90 times and read `pkg/__init__.py` 30 times. A directory is listed once for each
    // spelling that reaches it: `pkg/sub` as the directory of `pkg/sub/__init__.py` and as a child joined to `pkg`.
    expect(countProbes(calls, "readdirSync", "pkg")).toBe(1);
    expect(countProbes(calls, "readdirSync", "pkg/sub")).toBeGreaterThanOrEqual(1);
    expect(countProbes(calls, "readdirSync", "pkg/sub")).toBeLessThanOrEqual(2);
    expect(countProbes(calls, "statSync", "pkg/__init__.py")).toBe(1);
    expect(countProbes(calls, "readFileSync", "pkg/__init__.py")).toBe(1);
    expect(countProbes(calls, "readFileSync", "pkg/sub/__init__.py")).toBe(1);
  });

  it("reads package directories and initializers again in the next build", async () => {
    const root = await roots.create("cg-py-probe-next-build-");
    await write(root, "pyproject.toml", "[project]\nname = 'probe'\n");
    await write(root, "pkg/__init__.py", "");
    await write(root, "pkg/core.py", "def run():\n    return 1\n");
    await write(root, "app/user.py", "from pkg import late\nfrom pkg import core\n");
    const calls = recordSyncProbes(root);

    expect(bindingsOf(await build(root), root, "app/user.py")).toEqual([
      "named late -> pkg/__init__.py",
      "namespace core -> pkg/core.py",
    ]);
    const listedFirst = countProbes(calls, "readdirSync", "pkg");
    expect(listedFirst).toBe(1);

    // A submodule added and an attribute bound between builds: the second build must see both.
    await write(root, "pkg/late.py", "def later():\n    return 2\n");
    await write(root, "pkg/__init__.py", "core = None\n");
    expect(bindingsOf(await build(root), root, "app/user.py")).toEqual([
      "namespace late -> pkg/late.py",
      "named core -> pkg/__init__.py",
    ]);
    expect(countProbes(calls, "readdirSync", "pkg")).toBe(listedFirst + 1);
  });

  it("keeps each importer directory's own relative and manifest-rooted targets", async () => {
    const root = await roots.create("cg-py-probe-directories-");
    await write(root, "pyproject.toml", "[project]\nname = 'top'\n");
    await write(root, "shared.py", "VALUE = 1\n");
    for (const name of ["a", "b"]) {
      await write(root, `${name}/__init__.py`, "");
      await write(root, `${name}/util.py`, `def f():\n    return "${name}"\n`);
      await write(root, `${name}/main.py`, "from .util import f\nfrom . import util\nimport shared\n");
    }
    await write(root, "svc/pyproject.toml", "[project]\nname = 'svc'\n");
    await write(root, "svc/shared.py", "VALUE = 2\n");
    await write(root, "svc/app/main.py", "import shared\nfrom .. import shared as parent_shared\n");

    const index = await build(root);

    for (const name of ["a", "b"]) {
      expect(bindingsOf(index, root, `${name}/main.py`)).toEqual([
        `named f -> ${name}/util.py`,
        `namespace util -> ${name}/util.py`,
        "namespace shared -> shared.py",
      ]);
    }
    expect(bindingsOf(index, root, "svc/app/main.py")).toEqual([
      "namespace shared -> svc/shared.py",
      "namespace parent_shared -> svc/shared.py",
    ]);
  });
});

describe("Python import probes inside and outside a build", () => {
  async function writePackage(root: string): Promise<{ links: boolean }> {
    await write(root, "pyproject.toml", "[project]\nname = 'probe'\n");
    await write(root, "pkg/__init__.py", "");
    await write(root, "pkg/widget.py", "class Widget:\n    pass\n");
    await write(root, "pkg/stub.pyi", "def typed() -> int: ...\n");
    await write(root, "pkg/both.py", "def both():\n    return 1\n");
    await write(root, "pkg/both.pyi", "def both() -> int: ...\n");
    await write(root, "pkg/nsdir/inner.py", "def inner():\n    return 1\n");
    await write(root, "pkg/nested_ns/deep/leaf.py", "def leaf():\n    return 1\n");
    await write(root, "pkg/regdir/__init__.py", "");
    await write(root, "pkg/regdir/__init__.pyi", "");
    await write(root, "pkg/stubdir/__init__.pyi", "");
    await write(root, "pkg/emptydir/notes.txt", "no python here\n");
    await write(root, "app/user.py", "");
    const fileLink = await tryCreateFileSymlink(
      path.join(root, "pkg", "widget.py"),
      path.join(root, "pkg", "linked.py"),
    );
    const directoryLink = await tryCreateDirectorySymlink(
      path.join(root, "pkg", "nsdir"),
      path.join(root, "pkg", "linkdir"),
    );
    return { links: fileLink && directoryLink };
  }

  /** Answers as separate standalone calls and as one build's calls, and requires the same answers. */
  async function answerBothWays<T>(queries: ReadonlyArray<() => Promise<T>>): Promise<T[]> {
    const standalone: T[] = [];
    for (const query of queries) {
      clearResolutionCaches();
      standalone.push(await query());
    }
    clearResolutionCaches();
    const inBuild = await runWithProbeCache(async () => {
      const answers: T[] = [];
      for (const query of queries) answers.push(await query());
      return answers;
    });
    expect(inBuild).toEqual(standalone);
    return inBuild;
  }

  it("finds the same submodules, case-exact, with the same initializer and stub precedence", async () => {
    const root = await roots.create("cg-py-probe-submodules-");
    const { links } = await writePackage(root);
    const initializer = normalizePath(path.join(root, "pkg", "__init__.py"));
    const packageDirectory = normalizePath(path.join(root, "pkg"));
    const names = [
      "widget",
      "Widget",
      "stub",
      "both",
      "nsdir",
      "nested_ns",
      "regdir",
      "stubdir",
      "emptydir",
      "missing",
    ];
    if (links) names.push("linked", "linkdir");
    const targets = [initializer, packageDirectory, normalizePath(path.join(root, "pkg", "widget.py")), `${root}/gone`];
    const queries = targets.flatMap((target) =>
      names.map((name) => async () => resolvePythonSubmoduleExact(target, name) ?? "none"),
    );

    const answers = await answerBothWays(queries);

    const relative = (answer: string): string =>
      answer === "none" ? answer : normalizePath(path.relative(root, answer));
    const fromInitializer = Object.fromEntries(names.map((name, at) => [name, relative(answers[at]!)]));
    expect(fromInitializer).toMatchObject({
      widget: "pkg/widget.py",
      Widget: "none",
      stub: "pkg/stub.pyi",
      both: "pkg/both.py",
      nsdir: "pkg/nsdir",
      nested_ns: "pkg/nested_ns",
      regdir: "pkg/regdir/__init__.py",
      stubdir: "pkg/stubdir/__init__.pyi",
      emptydir: "pkg/emptydir",
      missing: "none",
    });
    // A package directory answers like its initializer; a plain module or a missing path has no submodules.
    expect(answers.slice(names.length, 2 * names.length)).toEqual(answers.slice(0, names.length));
    expect(answers.slice(2 * names.length).every((answer) => answer === "none")).toBe(true);
  });

  it("resolves the same modules, namespace packages, and links", async () => {
    const root = await roots.create("cg-py-probe-modules-");
    const { links } = await writePackage(root);
    const importer = path.join(root, "app", "user.py");
    const initializer = path.join(root, "pkg", "__init__.py");
    const specifiers: Array<[from: string, name: string | null, dots: number]> = [
      [importer, "pkg", 0],
      [importer, "pkg.widget", 0],
      [importer, "pkg.stub", 0],
      [importer, "pkg.both", 0],
      [importer, "pkg.nsdir", 0],
      [importer, "pkg.nested_ns", 0],
      [importer, "pkg.regdir", 0],
      [importer, "pkg.stubdir", 0],
      [importer, "pkg.emptydir", 0],
      [importer, "missing", 0],
      [initializer, "widget", 1],
      [initializer, null, 1],
      [initializer, "app.user", 2],
    ];
    if (links) specifiers.push([importer, "pkg.linked", 0], [importer, "pkg.linkdir", 0]);
    const queries = specifiers.map(([from, name, dots]) => async () => {
      const resolved = await resolvePythonModule(root, from, name, dots);
      return typeof resolved === "string"
        ? normalizePath(path.relative(root, resolved))
        : `external:${resolved.external}`;
    });

    const answers = await answerBothWays(queries);

    expect(answers.slice(0, 13)).toEqual([
      "pkg/__init__.py",
      "pkg/widget.py",
      "pkg/stub.pyi",
      "pkg/both.py",
      "pkg/nsdir",
      "pkg/nested_ns",
      "pkg/regdir/__init__.py",
      "pkg/stubdir/__init__.pyi",
      "external:pkg.emptydir",
      "external:missing",
      "pkg/widget.py",
      "pkg/__init__.py",
      "app/user.py",
    ]);
    if (links) expect(answers.slice(13)).toEqual(["pkg/linked.py", "pkg/linkdir"]);
  });
});
