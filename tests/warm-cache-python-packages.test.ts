import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  goToDefinition,
  type BuildReport,
  type ImportBinding,
  type ProjectIndex,
} from "../src/index.js";
import { normalizePath } from "../src/util/paths.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";
import { columnOf } from "./languages/callable-consumer-fixtures.js";

const roots = createTempRootRegistry();

afterEach(async () => {
  await roots.cleanup();
});

const SETTINGS = { threads: 1, logLevel: "silent" } as const;

type WarmBuild = {
  name: string;
  build: (root: string, report: BuildReport) => Promise<ProjectIndex>;
  /**
   * Files a build extracts after `pkg/__init__.py` gains or loses `cli`: the initializer and the two importers that
   * read it. A disk update also extracts `other.py`, which imports the initializer without reading it, because it
   * extracts every importer of a changed initializer.
   */
  initializerEditExtracts: number;
};

/** The builds that reuse cached modules, each through its own invalidation path. */
const WARM_BUILDS: readonly WarmBuild[] = [
  {
    name: "memory update",
    build: (root, report) => buildProjectIndexIncremental(root, { ...SETTINGS, cache: "memory", report }),
    initializerEditExtracts: 3,
  },
  {
    name: "disk update",
    build: (root, report) => buildProjectIndexIncremental(root, { ...SETTINGS, cache: "disk", report }),
    initializerEditExtracts: 4,
  },
  {
    name: "disk-cache full build",
    build: (root, report) => buildProjectIndex(root, { ...SETTINGS, cache: "disk", report }),
    initializerEditExtracts: 3,
  },
];

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, text, "utf8");
  }
}

function localName(binding: ImportBinding): string {
  if (binding.kind === "namespace") return binding.localNS;
  if (binding.kind === "star") return "*";
  return binding.local;
}

/** Each module's import bindings as `kind local <- from -> target`, with project-relative targets. */
function bindings(index: ProjectIndex, root: string): Record<string, string[]> {
  const relative = (file: string): string => normalizePath(path.relative(root, file));
  const byFile: Record<string, string[]> = {};
  for (const mod of index.byFile.values()) {
    byFile[relative(mod.file)] = mod.imports.map((binding) => {
      const target =
        typeof binding.resolved === "string" ? relative(binding.resolved) : `external:${binding.resolved?.external}`;
      return `${binding.kind} ${localName(binding)} <- ${binding.from} -> ${target}`;
    });
  }
  return byFile;
}

function edges(index: ProjectIndex, root: string): string[] {
  const relative = (file: string): string => normalizePath(path.relative(root, file));
  return index.graph.edges
    .map((edge) => {
      const target = edge.to.type === "file" ? relative(edge.to.path) : `external:${edge.to.name}`;
      return `${relative(edge.from)} -> ${target}`;
    })
    .sort();
}

type CheckedBuild = { index: ProjectIndex; cold: ProjectIndex; bindings: Record<string, string[]>; extracted: number };

/** One warm build checked against a cold build of the same tree, with the number of files it extracted again. */
async function warmMatchingCold(warm: WarmBuild, root: string): Promise<CheckedBuild> {
  const report: BuildReport = { timings: {} };
  const index = await warm.build(root, report);
  const cold = await buildProjectIndex(root, { ...SETTINGS, cache: "off" });
  expect(bindings(index, root)).toEqual(bindings(cold, root));
  expect(edges(index, root)).toEqual(edges(cold, root));
  const extracted = (report.files?.total ?? 0) - (report.files?.cached ?? 0);
  return { index, cold, bindings: bindings(index, root), extracted };
}

/** The project-relative file `goToDefinition` answers for `token` on `line`, the same in the warm and cold index. */
async function definitionFile(
  checked: CheckedBuild,
  root: string,
  file: string,
  line: number,
  token: string,
): Promise<string | undefined> {
  const lines = (await fsp.readFile(path.join(root, file), "utf8")).split("\n");
  const request = { file: path.join(root, file), line, column: columnOf(lines, line, token) };
  const answer = await goToDefinition(checked.index, request);
  expect(answer).toEqual(await goToDefinition(checked.cold, request));
  return answer.status === "ok" ? normalizePath(path.relative(root, answer.definition.file)) : undefined;
}

describe("warm builds rebind a Python `from pkg import name` like a cold build", () => {
  it.each(WARM_BUILDS)(
    "binds the package attribute once the submodule is deleted, and the submodule once it returns ($name)",
    async (warm) => {
      const root = await roots.create("cg-py-submodule-delete-");
      const submodules = {
        "pkg/mod.py": "def value():\n    return 1\n",
        "pkg/sub/__init__.py": "def value():\n    return 2\n",
        "ns/mod.py": "def value():\n    return 3\n",
      };
      await writeFiles(root, {
        ...submodules,
        "pkg/__init__.py": "def helper():\n    return 0\n",
        "ns/keep.py": "def keep():\n    return 0\n",
        "user.py": [
          "from pkg import mod",
          "from pkg import sub",
          "from ns import mod as ns_mod",
          "",
          "",
          "def use():",
          "    return mod.value() + sub.value() + ns_mod.value()",
          "",
        ].join("\n"),
        "other.py": "from pkg import helper\nfrom ns import keep\n\n\ndef run():\n    return helper() + keep.keep()\n",
      });
      await warm.build(root, { timings: {} });

      for (const removed of ["pkg/mod.py", "pkg/sub", "ns/mod.py"]) {
        await fsp.rm(path.join(root, removed), { recursive: true });
      }
      const deleted = await warmMatchingCold(warm, root);
      expect(deleted.bindings["user.py"]).toEqual([
        "named mod <- pkg -> pkg/__init__.py",
        "named sub <- pkg -> pkg/__init__.py",
        "named ns_mod <- ns -> ns",
      ]);
      expect(deleted.bindings["other.py"]).toEqual([
        "named helper <- pkg -> pkg/__init__.py",
        "namespace keep <- ns -> ns/keep.py",
      ]);
      // Only the importer of the deleted modules extracts again.
      expect(deleted.extracted).toBe(1);
      expect(await definitionFile(deleted, root, "user.py", 7, "value")).not.toBe("pkg/mod.py");

      await writeFiles(root, submodules);
      const restored = await warmMatchingCold(warm, root);
      expect(restored.bindings["user.py"]).toEqual([
        "namespace mod <- pkg -> pkg/mod.py",
        "namespace sub <- pkg -> pkg/sub/__init__.py",
        "namespace ns_mod <- ns -> ns/mod.py",
      ]);
      expect(await definitionFile(restored, root, "user.py", 7, "value")).toBe("pkg/mod.py");
    },
  );

  const namespaceDirectoryCases = WARM_BUILDS.flatMap((warm) =>
    [
      {
        change: "is deleted",
        keepsDataFile: false,
        user: ["named nsp <- . -> pkg/__init__.py", "named thing <- .nsp -> external:.nsp"],
      },
      {
        change: "loses its last Python file",
        keepsDataFile: true,
        user: ["namespace nsp <- . -> pkg/nsp", "named thing <- .nsp -> external:.nsp"],
      },
    ].map((scenario) => ({ ...scenario, warm, name: warm.name })),
  );

  it.each(namespaceDirectoryCases)(
    "rebinds the importers of a namespace package directory that $change ($name)",
    async ({ warm, keepsDataFile, user }) => {
      const root = await roots.create("cg-py-namespace-delete-");
      const thing = { "pkg/nsp/thing.py": "def helper():\n    return 4\n" };
      await writeFiles(root, {
        ...thing,
        ...(keepsDataFile ? { "pkg/nsp/README.txt": "data\n" } : {}),
        "pkg/__init__.py": "def marker():\n    return 0\n",
        "pkg/user.py": "from . import nsp\nfrom .nsp import thing\n\n\ndef use():\n    return thing.helper()\n",
        "pkg/other.py": "from . import marker\n\n\ndef run():\n    return marker()\n",
      });
      await warm.build(root, { timings: {} });

      await fsp.rm(path.join(root, keepsDataFile ? "pkg/nsp/thing.py" : "pkg/nsp"), { recursive: true });
      const removed = await warmMatchingCold(warm, root);
      expect(removed.bindings["pkg/user.py"]).toEqual(user);
      expect(removed.bindings["pkg/other.py"]).toEqual(["named marker <- . -> pkg/__init__.py"]);
      expect(removed.extracted).toBe(1);

      await writeFiles(root, thing);
      const restored = await warmMatchingCold(warm, root);
      expect(restored.bindings["pkg/user.py"]).toEqual([
        "namespace nsp <- . -> pkg/nsp",
        "namespace thing <- .nsp -> pkg/nsp/thing.py",
      ]);
    },
  );

  it.each(WARM_BUILDS)(
    "follows a package initializer that gains and loses the attribute a submodule competes with ($name)",
    async (warm) => {
      const root = await roots.create("cg-py-initializer-");
      const initializer = "def helper():\n    return 0\n";
      await writeFiles(root, {
        "pkg/__init__.py": initializer,
        "pkg/cli.py": "def main():\n    return 1\n",
        "pkg/app.py": "from . import cli\n\n\ndef run():\n    return cli.main()\n",
        "main.py": "from pkg import cli\n\n\ndef run():\n    return cli.main()\n",
        "alias.py": "import pkg.cli as tool\n\n\ndef run():\n    return tool.main()\n",
        "other.py": "from pkg import helper\n\n\ndef run():\n    return helper()\n",
      });
      await warm.build(root, { timings: {} });

      await writeFiles(root, { "pkg/__init__.py": `${initializer}\n\ncli = None\n` });
      const attribute = await warmMatchingCold(warm, root);
      expect(attribute.bindings["pkg/app.py"]).toEqual(["named cli <- . -> pkg/__init__.py"]);
      expect(attribute.bindings["main.py"]).toEqual(["named cli <- pkg -> pkg/__init__.py"]);
      // `import pkg.cli` and a name no submodule competes for never read the initializer.
      expect(attribute.bindings["alias.py"]).toEqual(["namespace tool <- pkg.cli -> pkg/cli.py"]);
      expect(attribute.bindings["other.py"]).toEqual(["named helper <- pkg -> pkg/__init__.py"]);
      expect(attribute.extracted).toBe(warm.initializerEditExtracts);
      expect(await definitionFile(attribute, root, "main.py", 5, "cli")).toBe("pkg/__init__.py");

      await writeFiles(root, { "pkg/__init__.py": initializer });
      const submodule = await warmMatchingCold(warm, root);
      expect(submodule.bindings["pkg/app.py"]).toEqual(["namespace cli <- . -> pkg/cli.py"]);
      expect(submodule.bindings["main.py"]).toEqual(["namespace cli <- pkg -> pkg/cli.py"]);
      expect(submodule.extracted).toBe(warm.initializerEditExtracts);
      expect(await definitionFile(submodule, root, "main.py", 5, "main")).toBe("pkg/cli.py");
    },
  );

  it.each(WARM_BUILDS)(
    "binds a module added to a namespace package, and the package attribute once it is deleted ($name)",
    async (warm) => {
      const root = await roots.create("cg-py-namespace-add-");
      await writeFiles(root, {
        "ns/a.py": "x = 1\n",
        "user.py": "from ns import b\n\n\ndef run():\n    return b.f()\n",
      });
      await warm.build(root, { timings: {} });

      await writeFiles(root, { "ns/b.py": "def f():\n    return 1\n" });
      expect((await warmMatchingCold(warm, root)).bindings["user.py"]).toEqual(["namespace b <- ns -> ns/b.py"]);

      await fsp.rm(path.join(root, "ns/b.py"));
      expect((await warmMatchingCold(warm, root)).bindings["user.py"]).toEqual(["named b <- ns -> ns"]);
    },
  );
});
