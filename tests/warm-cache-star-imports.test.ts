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
  /** A memory cache keeps no manifest, so its builds check every cached PHP binding against any added PHP file. */
  rechecksEveryPhpBinding: boolean;
};

/** The builds that reuse cached modules. Each expands star imports again and checks added files its own way. */
const WARM_BUILDS: readonly WarmBuild[] = [
  {
    name: "memory update",
    build: (root, report) => buildProjectIndexIncremental(root, { ...SETTINGS, cache: "memory", report }),
    rechecksEveryPhpBinding: true,
  },
  {
    name: "memory-cache full build",
    build: (root, report) => buildProjectIndex(root, { ...SETTINGS, cache: "memory", report }),
    rechecksEveryPhpBinding: true,
  },
  {
    name: "disk update",
    build: (root, report) => buildProjectIndexIncremental(root, { ...SETTINGS, cache: "disk", report }),
    rechecksEveryPhpBinding: false,
  },
  {
    name: "disk-cache full build",
    build: (root, report) => buildProjectIndex(root, { ...SETTINGS, cache: "disk", report }),
    rechecksEveryPhpBinding: false,
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

/** Each module's import bindings in order, as `kind local <- from -> target` with project-relative targets. */
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

type CheckedBuild = { index: ProjectIndex; cold: ProjectIndex; extracted: number };

/** One warm build checked against a cold build of the same tree, with the number of files it extracted again. */
async function warmMatchingCold(warm: WarmBuild, root: string): Promise<CheckedBuild> {
  const report: BuildReport = { timings: {} };
  const index = await warm.build(root, report);
  const cold = await buildProjectIndex(root, { ...SETTINGS, cache: "off" });
  expect(bindings(index, root)).toEqual(bindings(cold, root));
  expect(edges(index, root)).toEqual(edges(cold, root));
  return { index, cold, extracted: (report.files?.total ?? 0) - (report.files?.cached ?? 0) };
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

function phpFunctions(...names: string[]): string {
  return `<?php\n${names.map((name) => `\nfunction ${name}(): string\n{\n    return '${name}';\n}\n`).join("")}`;
}

describe("warm builds expand Composer `autoload.files` imports like a cold build", () => {
  it.each(WARM_BUILDS)(
    "follows an edit, a delete, and a restore of an autoload file its importers never name ($name)",
    async (warm) => {
      const root = await roots.create("cg-star-php-autoload-");
      await writeFiles(root, {
        "composer.json": JSON.stringify({
          autoload: { "psr-4": { "App\\": "src/" }, files: ["helpers/one.php", "helpers/two.php"] },
        }),
        "helpers/one.php": phpFunctions("one"),
        "helpers/two.php": phpFunctions("two"),
        "src/Thing.php": "<?php\n\nnamespace App;\n\nclass Thing\n{\n}\n",
        "src/uses-thing.php":
          "<?php\n\nuse App\\Thing;\n\nfunction usesThing(): Thing\n{\n    return new Thing();\n}\n",
        // No `use` or include: only the autoload files, which no graph edge represents, import into it.
        "plain.php": "<?php\n\none();\ntwo();\noneMore();\n",
      });
      await warmMatchingCold(warm, root);

      // A snapshot-loaded importer used to receive the new name in place, which threw on its frozen bindings.
      await writeFiles(root, { "helpers/one.php": phpFunctions("one", "oneMore") });
      let checked = await warmMatchingCold(warm, root);
      expect(await definitionFile(checked, root, "plain.php", 5, "oneMore")).toBe("helpers/one.php");

      await fsp.rm(path.join(root, "helpers/one.php"));
      checked = await warmMatchingCold(warm, root);
      expect(await definitionFile(checked, root, "plain.php", 3, "one")).toBeUndefined();
      expect(await definitionFile(checked, root, "plain.php", 4, "two")).toBe("helpers/two.php");

      await writeFiles(root, { "helpers/one.php": phpFunctions("one") });
      checked = await warmMatchingCold(warm, root);
      expect(await definitionFile(checked, root, "plain.php", 3, "one")).toBe("helpers/one.php");
      expect(await definitionFile(checked, root, "plain.php", 5, "oneMore")).toBeUndefined();
    },
  );

  it.each(WARM_BUILDS)(
    "extracts the files a composer.json governs again once the only file it autoloads returns ($name)",
    async (warm) => {
      const root = await roots.create("cg-star-php-sole-autoload-");
      await writeFiles(root, {
        "composer.json": JSON.stringify({ autoload: { "psr-4": { "App\\": "src/" }, files: ["helpers.php"] } }),
        "helpers.php": phpFunctions("helper"),
        // Neither file names another file, so with `helpers.php` gone they import nothing at all.
        "plain.php": "<?php\n\nhelper();\n",
        "src/Thing.php": "<?php\n\nnamespace App;\n\nclass Thing\n{\n}\n",
      });
      await warmMatchingCold(warm, root);

      await fsp.rm(path.join(root, "helpers.php"));
      let checked = await warmMatchingCold(warm, root);
      expect(await definitionFile(checked, root, "plain.php", 3, "helper")).toBeUndefined();

      // A build with nothing changed shows what every build extracts in this mode. No composer.json lists the next
      // file, so it adds only itself.
      const unchanged = (await warmMatchingCold(warm, root)).extracted;
      await writeFiles(root, { "src/Other.php": "<?php\n\nnamespace App;\n\nclass Other\n{\n}\n" });
      expect((await warmMatchingCold(warm, root)).extracted).toBe(unchanged + 1);

      await writeFiles(root, { "helpers.php": phpFunctions("helper") });
      checked = await warmMatchingCold(warm, root);
      expect(checked.extracted).toBe(unchanged + 4);
      expect(await definitionFile(checked, root, "plain.php", 3, "helper")).toBe("helpers.php");
    },
  );

  // A memory-cache build re-extracts package b too: it checks every cached PHP binding against any added PHP file.
  it.each(WARM_BUILDS.filter((warm) => !warm.rechecksEveryPhpBinding))(
    "leaves another composer.json's files cached when one package's autoload file returns ($name)",
    async (warm) => {
      const root = await roots.create("cg-star-php-two-packages-");
      await writeFiles(root, {
        "a/composer.json": JSON.stringify({ autoload: { files: ["helpers.php"] } }),
        "a/helpers.php": phpFunctions("aHelper"),
        "a/plain.php": "<?php\n\naHelper();\n",
        "b/composer.json": JSON.stringify({ autoload: { files: ["tools.php"] } }),
        "b/tools.php": phpFunctions("bTool"),
        "b/plain.php": "<?php\n\nbTool();\n",
      });
      await warmMatchingCold(warm, root);
      await fsp.rm(path.join(root, "a/helpers.php"));
      await warmMatchingCold(warm, root);
      const unchanged = (await warmMatchingCold(warm, root)).extracted;

      await writeFiles(root, { "a/helpers.php": phpFunctions("aHelper") });
      const checked = await warmMatchingCold(warm, root);
      expect(await definitionFile(checked, root, "a/plain.php", 3, "aHelper")).toBe("a/helpers.php");
      // `a/helpers.php` and `a/plain.php`: package b imports its own autoload file, which did not change.
      expect(checked.extracted).toBe(unchanged + 2);
    },
  );
});

describe("warm builds re-resolve a TypeScript `require` like a cold build", () => {
  const widget = "class WidgetTs {}\nmodule.exports = WidgetTs;\n";

  it.each(WARM_BUILDS)("binds the required file once it is added and after a restore ($name)", async (warm) => {
    const root = await roots.create("cg-star-ts-require-");
    await writeFiles(root, {
      "consumer.ts": 'const WidgetTs = require("./widget-ts");\nexport const instance = new WidgetTs();\n',
      "importer.ts": 'import { value } from "./value";\nexport const doubled = value * 2;\n',
      "value.ts": "export const value = 1;\n",
    });
    await warmMatchingCold(warm, root);

    // No specifier of either importer can name this file, so only the file itself is extracted.
    await writeFiles(root, { "unrelated.ts": "export const unrelated = 1;\n" });
    expect((await warmMatchingCold(warm, root)).extracted).toBe(1);

    await writeFiles(root, { "widget-ts.ts": widget });
    let checked = await warmMatchingCold(warm, root);
    expect(checked.extracted).toBe(2);
    expect(await definitionFile(checked, root, "consumer.ts", 2, "WidgetTs")).toBe("widget-ts.ts");

    await fsp.rm(path.join(root, "widget-ts.ts"));
    checked = await warmMatchingCold(warm, root);
    expect(await definitionFile(checked, root, "consumer.ts", 2, "WidgetTs")).toBeUndefined();

    await writeFiles(root, { "widget-ts.ts": widget });
    checked = await warmMatchingCold(warm, root);
    expect(await definitionFile(checked, root, "consumer.ts", 2, "WidgetTs")).toBe("widget-ts.ts");
  });
});

describe("warm builds expand a Python `from pkg import *` like a cold build", () => {
  it.each(WARM_BUILDS)("binds the names the package and module export now, in import order ($name)", async (warm) => {
    const root = await roots.create("cg-star-python-");
    const helper = "def helper():\n    return 0\n";
    await writeFiles(root, {
      "pkg/__init__.py": helper,
      "pkg/a.py": "def fa():\n    return 1\n",
      "user.py":
        "from pkg import *\nfrom pkg.a import *\n\n\ndef use():\n    return helper() + helper2() + fa() + fa2()\n",
    });
    await warmMatchingCold(warm, root);

    await writeFiles(root, { "pkg/__init__.py": `${helper}\n\ndef helper2():\n    return 2\n` });
    let checked = await warmMatchingCold(warm, root);
    expect(await definitionFile(checked, root, "user.py", 6, "helper2")).toBe("pkg/__init__.py");

    await writeFiles(root, { "pkg/a.py": "def fa2():\n    return 1\n" });
    checked = await warmMatchingCold(warm, root);
    expect(await definitionFile(checked, root, "user.py", 6, "fa()")).toBeUndefined();
    expect(await definitionFile(checked, root, "user.py", 6, "fa2")).toBe("pkg/a.py");

    await writeFiles(root, { "pkg/__init__.py": `${helper}from .a import *\n` });
    checked = await warmMatchingCold(warm, root);
    expect(await definitionFile(checked, root, "user.py", 6, "helper2")).toBeUndefined();

    await writeFiles(root, { "pkg/__init__.py": `# comment\n${helper}from .a import *\n` });
    await warmMatchingCold(warm, root);
  });
});
