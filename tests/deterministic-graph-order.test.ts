import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  buildSymbolGraph,
  buildSymbolGraphDetailed,
  collectGraph,
  listProjectFiles,
  type BuildReport,
  type ProjectIndex,
} from "../src/index.js";
import { clearMemoryCache, closeDiskCacheDatabase } from "../src/indexer/build-cache.js";
import type { IncrementalBuildOptions } from "../src/indexer/types.js";
import { normalizePath, sortProjectFiles } from "../src/util/paths.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";
import { runGit } from "./helpers/git.js";

const roots = createTempRootRegistry();
const diskCaches: Array<{ root: string; cacheDir: string }> = [];

afterEach(async () => {
  for (const { root, cacheDir } of diskCaches.splice(0)) closeDiskCacheDatabase(root, { cache: "disk", cacheDir });
  clearMemoryCache();
  await roots.cleanup();
});

/** Whether a path differing only in case names the same file here, as on the default Windows and macOS volumes. */
const CASE_INSENSITIVE_FILE_SYSTEM = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-order-case-probe-"));
  try {
    fs.writeFileSync(path.join(dir, "probe.txt"), "");
    return fs.existsSync(path.join(dir, "PROBE.TXT"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

type Fixture = Record<string, string>;

/**
 * Directories, upper-case, underscore, and lower-case names, so path order differs from crawl order and from locale
 * order. The two JSON files are imported but match no discovery pattern, so they become modules after the sources;
 * the first one a source names sorts after the second. The two package manifests are linked by a workspace dependency.
 */
const FIXTURE: Fixture = {
  "packages/app/package.json": JSON.stringify({ name: "@order/app", dependencies: { "@order/lib": "1.0.0" } }),
  "packages/lib/package.json": JSON.stringify({ name: "@order/lib" }),
  "src/zeta.ts": 'import first from "./a-first.json";\nexport function zeta(): number {\n  return first.n;\n}\n',
  "src/a-first.json": '{ "n": 1 }\n',
  "src/z-last.json": '{ "n": 2 }\n',
  "src/alpha/index.ts":
    'import { zeta } from "../zeta";\nimport last from "../z-last.json";\nexport function alpha(): number {\n  return zeta() + last.n;\n}\n',
  "src/beta/util.ts": 'import { alpha } from "../alpha";\nexport function beta(): number {\n  return alpha();\n}\n',
  "src/Capital.ts": 'import { beta } from "./beta/util";\nexport const capital = beta();\n',
  "src/_internal.ts": 'import { zeta } from "./zeta";\nexport function internal(): number {\n  return zeta();\n}\n',
  "src/leaf/one.ts": "export const one = 1;\n",
};

const DISCOVERED_FILES = [
  "packages/app/package.json",
  "packages/lib/package.json",
  "src/Capital.ts",
  "src/_internal.ts",
  "src/alpha/index.ts",
  "src/beta/util.ts",
  "src/leaf/one.ts",
  "src/zeta.ts",
];

/** Every build lists the discovered files by path, then each JSON module in the order the sources first name it. */
const LISTED_MODULES = [...DISCOVERED_FILES, "src/z-last.json", "src/a-first.json"];

/**
 * An AngularJS app next to two workspace packages. A full build lists the import edges by source file, then the workspace
 * manifest edge, then the AngularJS edges.
 */
const ANGULAR_FIXTURE: Fixture = {
  "package.json": JSON.stringify({ name: "angular-fixture", private: true }),
  "packages/app/package.json": JSON.stringify({ name: "@order/app", dependencies: { "@order/lib": "1.0.0" } }),
  "packages/lib/package.json": JSON.stringify({ name: "@order/lib" }),
  "app/z-service.js":
    'angular.module("admin").service("userService", function userService($http) {\n  this.load = function load() {\n    return $http.get("/api/users");\n  };\n});\n',
  "app/a-directive.js":
    'import "./b-plain.js";\nangular.module("admin").directive("userCard", function userCard() {\n  return {\n    scope: {},\n    templateUrl: "./user-card.template.html",\n    controller: "UserCtrl",\n    controllerAs: "vm",\n  };\n});\n',
  "app/m-controller.js":
    'import { helper } from "./b-plain.js";\nangular.module("admin").controller("UserCtrl", [\n  "$scope",\n  "$state",\n  "userService",\n  function UserCtrl($scope, $state, userService) {\n    $scope.refresh = function refresh() {\n      return userService.load() + helper();\n    };\n  },\n]);\n',
  "app/b-plain.js": "export function helper() {\n  return 1;\n}\n",
  "app/user-card.template.html": "<div></div>\n",
  "app/y-other.js": 'import { helper } from "./b-plain.js";\nexport const other = helper();\n',
};

/**
 * Imported JSON files, one of them without an extension in its specifier and one imported by several files. The
 * generated JSON file is imported by nobody, so no build may hold a module for it.
 */
const JSON_FIXTURE: Fixture = {
  "src/aaa/head.ts": 'import head from "./head.json";\nexport default head;\n',
  "src/aaa/head.json": '{ "h": 1 }\n',
  "src/main.ts":
    'import data from "./data.json";\nimport cfg from "./config";\nimport shared from "./shared.json";\nexport const main = [data, cfg, shared];\n',
  "src/other.ts": 'import shared from "./shared.json";\nexport const other = [shared];\n',
  "src/deep/leaf.ts": 'import data from "../data.json";\nexport const leaf = [data];\n',
  "src/data.json": '{ "name": "data" }\n',
  "src/config.json": '{ "name": "config" }\n',
  "src/shared.json": '{ "name": "shared" }\n',
  "src/ignored-gen.json": '{ "name": "gen" }\n',
  "src/zzz/tail.ts": 'import tail from "./tail.json";\nexport default tail;\n',
  "src/zzz/tail.json": '{ "t": 1 }\n',
};

type Discovery = "scan" | "git";
type Warm = "memory" | "disk";
type CacheMode = "off" | Warm;

type Project = {
  root: string;
  cacheDir: string;
  discovery: Discovery;
  write: (name: string, text: string) => Promise<void>;
  remove: (name: string) => Promise<void>;
  move: (from: string, to: string) => Promise<void>;
  /**
   * A rename Git records, so a Git project lists the new spelling at once. It hops through a temporary name, as Git
   * needs for a directory's case.
   */
  moveTracked: (from: string, to: string) => Promise<void>;
  commit: () => Promise<void>;
};

async function createProject(discovery: Discovery, fixture: Fixture = FIXTURE): Promise<Project> {
  const root = await roots.create(`cg-order-${discovery}-`);
  const cacheDir = await roots.create(`cg-order-cache-${discovery}-`);
  diskCaches.push({ root, cacheDir });
  const write = async (name: string, text: string): Promise<void> => {
    const file = path.join(root, name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, text, "utf8");
  };
  const move = async (from: string, to: string): Promise<void> => {
    await fsp.mkdir(path.dirname(path.join(root, to)), { recursive: true });
    await fsp.rename(path.join(root, from), path.join(root, to));
  };
  for (const [name, text] of Object.entries(fixture)) await write(name, text);
  if (discovery === "git") {
    runGit(root, ["init", "-q"]);
    runGit(root, ["config", "user.email", "tests@example.com"]);
    runGit(root, ["config", "user.name", "Tests"]);
    runGit(root, ["config", "core.autocrlf", "false"]);
    runGit(root, ["add", "-A"]);
    runGit(root, ["commit", "-qm", "fixture"]);
  }
  return {
    root,
    cacheDir,
    discovery,
    write,
    remove: async (name) => await fsp.rm(path.join(root, name)),
    move,
    moveTracked: async (from, to) => {
      if (discovery !== "git") {
        await move(from, to);
        return;
      }
      runGit(root, ["mv", from, `${from}.case-hop`]);
      runGit(root, ["mv", `${from}.case-hop`, to]);
    },
    commit: async () => {
      if (discovery !== "git") return;
      runGit(root, ["add", "-A"]);
      runGit(root, ["commit", "-qm", "step"]);
    },
  };
}

function buildOptions(
  project: Project,
  cache: CacheMode,
  extra: Partial<IncrementalBuildOptions> = {},
): IncrementalBuildOptions {
  return {
    cache,
    ...(cache === "disk" ? { cacheDir: project.cacheDir } : {}),
    threads: 1,
    logLevel: "silent",
    ...extra,
  };
}

function relativePaths(root: string, files: Iterable<string>): string[] {
  return [...files].map((file) => normalizePath(path.relative(root, file)));
}

function moduleFiles(index: ProjectIndex): string[] {
  return [...index.byFile.values()].map((mod) => mod.file);
}

/** Every array a caller reads in order: the modules, the file graph, and both symbol graphs. */
async function listings(index: ProjectIndex) {
  const symbols = await buildSymbolGraph(index);
  const detailed = await buildSymbolGraphDetailed(index);
  return {
    modules: moduleFiles(index),
    fileNodes: [...index.graph.nodes],
    fileEdges: index.graph.edges.map((edge) => JSON.stringify(edge)),
    symbolNodes: [...symbols.nodes.values()].map((node) => JSON.stringify(node)),
    symbolEdges: symbols.edges.map((edge) => JSON.stringify(edge)),
    detailedNodes: [...detailed.nodes.values()].map((node) => JSON.stringify(node)),
    detailedEdges: detailed.edges.map((edge) => JSON.stringify(edge)),
  };
}

type Step = { name: string; apply: (project: Project) => Promise<void> };

/** Builds the project once, then after each step compares an update with a cold build of the same files. */
async function expectWarmMatchesCold(project: Project, warm: Warm, steps: readonly Step[]): Promise<void> {
  await buildProjectIndex(project.root, buildOptions(project, warm));
  for (const step of steps) {
    await step.apply(project);
    const warmIndex = await buildProjectIndexIncremental(project.root, buildOptions(project, warm));
    const cold = await buildProjectIndex(project.root, buildOptions(project, "off"));
    expect(await listings(warmIndex), `${warm} after ${step.name}`).toEqual(await listings(cold));
  }
}

const ALPHA_EDITED = `${FIXTURE["src/alpha/index.ts"]}export function extra(): number {\n  return alpha();\n}\n`;

/** One step per way a warm build can move a file: unchanged, edited, deleted and restored, renamed and back, added. */
const STEPS: Step[] = [
  { name: "no change", apply: async () => undefined },
  { name: "edit", apply: async (project) => await project.write("src/alpha/index.ts", ALPHA_EDITED) },
  { name: "delete", apply: async (project) => await project.remove("src/beta/util.ts") },
  { name: "restore", apply: async (project) => await project.write("src/beta/util.ts", FIXTURE["src/beta/util.ts"]!) },
  { name: "rename", apply: async (project) => await project.move("src/leaf/one.ts", "src/leaf/two.ts") },
  { name: "rename back", apply: async (project) => await project.move("src/leaf/two.ts", "src/leaf/one.ts") },
  {
    name: "new file",
    apply: async (project) =>
      await project.write("src/aaa/new.ts", 'import { zeta } from "../zeta";\nexport const fresh = zeta();\n'),
  },
  {
    name: "new file edited",
    apply: async (project) => await project.write("src/aaa/new.ts", "export const fresh = 2;\n"),
  },
  { name: "new file removed", apply: async (project) => await project.remove("src/aaa/new.ts") },
];

const ANGULAR_STEPS: Step[] = [
  { name: "no change", apply: async () => undefined },
  {
    name: "edit directive",
    apply: async (project) =>
      await project.write("app/a-directive.js", `${ANGULAR_FIXTURE["app/a-directive.js"]}// edit\n`),
  },
  {
    name: "edit service",
    apply: async (project) =>
      await project.write("app/z-service.js", `${ANGULAR_FIXTURE["app/z-service.js"]}// edit\n`),
  },
  {
    name: "edit the public surface of a shared import",
    apply: async (project) =>
      await project.write("app/b-plain.js", "export function helper() {\n  return 2;\n}\nexport const more = 1;\n"),
  },
  { name: "delete controller", apply: async (project) => await project.remove("app/m-controller.js") },
  {
    name: "restore controller",
    apply: async (project) => await project.write("app/m-controller.js", ANGULAR_FIXTURE["app/m-controller.js"]!),
  },
  {
    name: "add second controller",
    apply: async (project) =>
      await project.write(
        "app/c-ctrl.js",
        'angular.module("admin").controller("UserCtrl2", function UserCtrl2() {});\nangular.module("admin").directive("x", function () { return { controller: "UserCtrl2", templateUrl: "./user-card.template.html" }; });\n',
      ),
  },
  {
    name: "edit workspace manifest",
    apply: async (project) =>
      await project.write(
        "packages/app/package.json",
        JSON.stringify({ name: "@order/app", dependencies: { "@order/lib": "1.0.0", "angular-fixture": "1.0.0" } }),
      ),
  },
  { name: "remove second controller", apply: async (project) => await project.remove("app/c-ctrl.js") },
];

const JSON_STEPS: Step[] = [
  { name: "no change", apply: async () => undefined },
  { name: "edit JSON", apply: async (project) => await project.write("src/data.json", '{ "name": "data2" }\n') },
  { name: "delete a shared JSON file", apply: async (project) => await project.remove("src/shared.json") },
  {
    name: "restore the shared JSON file",
    apply: async (project) => await project.write("src/shared.json", JSON_FIXTURE["src/shared.json"]!),
  },
  {
    name: "add an importer and its JSON file",
    apply: async (project) => {
      await project.write("src/bbb/new.json", '{ "new": 1 }\n');
      await project.write("src/bbb/new.ts", 'import extra from "./new.json";\nexport default extra;\n');
    },
  },
  { name: "remove the importer", apply: async (project) => await project.remove("src/bbb/new.ts") },
  { name: "remove its JSON file", apply: async (project) => await project.remove("src/bbb/new.json") },
  {
    name: "restore the JSON file",
    apply: async (project) => await project.write("src/bbb/new.json", '{ "new": 2 }\n'),
  },
  {
    name: "restore the importer",
    apply: async (project) =>
      await project.write("src/bbb/new.ts", 'import extra from "./new.json";\nexport default extra;\n'),
  },
  { name: "commit", apply: async (project) => await project.commit() },
];

/** Case-only renames, which a case-insensitive file system sees as the same path. */
const CASE_RENAME_STEPS: Step[] = [
  { name: "no change", apply: async () => undefined },
  {
    name: "rename a file's case",
    apply: async (project) => await project.moveTracked("src/Capital.ts", "src/capital.ts"),
  },
  { name: "rename a directory's case", apply: async (project) => await project.moveTracked("src/beta", "src/Beta") },
  { name: "commit", apply: async (project) => await project.commit() },
  {
    name: "rename the file back",
    apply: async (project) => await project.moveTracked("src/capital.ts", "src/Capital.ts"),
  },
  { name: "rename the directory back", apply: async (project) => await project.moveTracked("src/Beta", "src/beta") },
  { name: "commit again", apply: async (project) => await project.commit() },
];

/** Importer files in a directory order unlike their creation order, each naming its own JSON file and a shared one. */
function manyImporters(count: number): { files: Fixture; expectedJsonOrder: string[] } {
  const files: Fixture = { "src/shared.json": '{ "shared": true }\n' };
  const expectedJsonOrder: string[] = [];
  const importers: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const dir = `src/m${String((index * 37) % count).padStart(3, "0")}`;
    files[`${dir}/imp.ts`] =
      `import own from "./own.json";\nimport shared from "../shared.json";\nexport const v${index} = [own, shared];\n`;
    files[`${dir}/own.json`] = `{ "index": ${index} }\n`;
    importers.push(dir);
  }
  // Importers are indexed in path order, and each names its own JSON file before the shared one.
  for (const dir of importers.sort()) {
    expectedJsonOrder.push(`${dir}/own.json`);
    if (!expectedJsonOrder.includes("src/shared.json")) expectedJsonOrder.push("src/shared.json");
  }
  return { files, expectedJsonOrder };
}

type EdgeGroup = "import" | "workspace" | "angularjs";

function edgeGroup(edge: ProjectIndex["graph"]["edges"][number]): EdgeGroup {
  if (edge.resolved === "heuristic") return "angularjs";
  if (edge.raw === "@order/lib") return "workspace";
  return "import";
}

/** The groups in the order they appear, each group once. */
function edgeGroupSequence(index: ProjectIndex): EdgeGroup[] {
  const sequence: EdgeGroup[] = [];
  for (const edge of index.graph.edges) {
    const group = edgeGroup(edge);
    if (sequence.at(-1) !== group) sequence.push(group);
  }
  return sequence;
}

describe("index order", () => {
  it("sorts project files by UTF-16 code unit, not by locale", () => {
    expect(sortProjectFiles(["/p/b.ts", "/p/_c.ts", "/p/a/x.ts", "/p/B.ts", "/p/a.ts"])).toEqual([
      "/p/B.ts",
      "/p/_c.ts",
      "/p/a.ts",
      "/p/a/x.ts",
      "/p/b.ts",
    ]);
  });

  describe.each<Discovery>(["scan", "git"])("%s discovery", (discovery) => {
    it("lists discovered files in path order", async () => {
      const project = await createProject(discovery);
      expect(relativePaths(project.root, await listProjectFiles(project.root))).toEqual(DISCOVERED_FILES);
    });

    it("lists a cold build's modules and file graph nodes by path, with the workspace edge last", async () => {
      const project = await createProject(discovery);
      const cold = await buildProjectIndex(project.root, buildOptions(project, "off"));
      expect(relativePaths(project.root, moduleFiles(cold))).toEqual(LISTED_MODULES);
      expect(relativePaths(project.root, cold.graph.nodes)).toEqual(LISTED_MODULES);
      expect(cold.graph.edges.findIndex((edge) => edge.raw === "@order/lib")).toBe(cold.graph.edges.length - 1);
    });

    it.each<Warm>(["memory", "disk"])(
      "lists a %s-warm build like a cold build after every kind of change",
      async (warm) => {
        const project = await createProject(discovery);
        await expectWarmMatchesCold(project, warm, STEPS);
      },
      60_000,
    );

    it("lists an unchanged disk project, read back from its snapshot, like a cold build", async () => {
      const project = await createProject(discovery);
      await buildProjectIndex(project.root, buildOptions(project, "disk"));
      await project.write("src/alpha/index.ts", ALPHA_EDITED);
      await buildProjectIndexIncremental(project.root, buildOptions(project, "disk"));
      const reloaded = await buildProjectIndexIncremental(project.root, buildOptions(project, "disk"));
      const cold = await buildProjectIndex(project.root, buildOptions(project, "off"));
      expect(await listings(reloaded)).toEqual(await listings(cold));
      expect(relativePaths(project.root, moduleFiles(reloaded))).toEqual(LISTED_MODULES);
    });

    it("lists the import, workspace, and AngularJS edge groups in a full build's order after every kind of change", async () => {
      const project = await createProject(discovery, ANGULAR_FIXTURE);
      const cold = await buildProjectIndex(project.root, buildOptions(project, "off"));
      expect(edgeGroupSequence(cold)).toEqual(["import", "workspace", "angularjs"]);
      for (const warm of ["memory", "disk"] as const) {
        const warmProject = await createProject(discovery, ANGULAR_FIXTURE);
        await buildProjectIndex(warmProject.root, buildOptions(warmProject, warm));
        for (const step of ANGULAR_STEPS) {
          await step.apply(warmProject);
          const updated = await buildProjectIndexIncremental(warmProject.root, buildOptions(warmProject, warm));
          const rebuilt = await buildProjectIndex(warmProject.root, buildOptions(warmProject, "off"));
          expect(edgeGroupSequence(updated), `${warm} after ${step.name}`).toEqual(edgeGroupSequence(rebuilt));
          expect(await listings(updated), `${warm} after ${step.name}`).toEqual(await listings(rebuilt));
        }
      }
    }, 60_000);

    it.each<Warm>(["memory", "disk"])(
      "lists imported JSON modules like a cold build after edit, delete, restore, add, and remove (%s)",
      async (warm) => {
        const project = await createProject(discovery, JSON_FIXTURE);
        const cold = await buildProjectIndex(project.root, buildOptions(project, "off"));
        const jsonModules = relativePaths(project.root, moduleFiles(cold)).filter((file) => file.endsWith(".json"));
        expect(jsonModules).toEqual([
          "src/aaa/head.json",
          "src/data.json",
          "src/config.json",
          "src/shared.json",
          "src/zzz/tail.json",
        ]);
        expect(jsonModules).not.toContain("src/ignored-gen.json");
        await expectWarmMatchesCold(project, warm, JSON_STEPS);
      },
      60_000,
    );

    it.each<Warm>(["memory", "disk"])(
      "lists a case-only rename of a file and of a directory like a cold build (%s)",
      async (warm) => {
        const project = await createProject(discovery);
        await expectWarmMatchesCold(project, warm, CASE_RENAME_STEPS);
      },
      60_000,
    );

    describe("additionalFiles that discovery does not list", () => {
      const extraFiles: Fixture = {
        "extra/b.ts": 'import { zeta } from "../src/zeta";\nexport const b = zeta();\n',
        "extra/a.ts": "export const a = 1;\n",
      };
      const ignoreExtra = { ignoreGlobs: ["**/extra/**"] };
      const listedWithExtras = [
        ...sortProjectFiles([...DISCOVERED_FILES, "extra/a.ts", "extra/b.ts"]),
        "src/z-last.json",
        "src/a-first.json",
      ];

      it("lists a cold build's transient files in path order whatever order the caller names them", async () => {
        const project = await createProject(discovery, { ...FIXTURE, ...extraFiles });
        const absolute = (name: string): string => path.join(project.root, name);
        const orders = [
          [absolute("extra/a.ts"), absolute("extra/b.ts")],
          [absolute("extra/b.ts"), absolute("extra/a.ts")],
        ];
        for (const additionalFiles of orders) {
          const index = await buildProjectIndex(
            project.root,
            buildOptions(project, "off", { additionalFiles, discovery: ignoreExtra }),
          );
          expect(relativePaths(project.root, moduleFiles(index))).toEqual(listedWithExtras);
          expect(relativePaths(project.root, index.graph.nodes)).toEqual(listedWithExtras);
        }
        const without = await buildProjectIndex(project.root, buildOptions(project, "off", { discovery: ignoreExtra }));
        expect(relativePaths(project.root, moduleFiles(without))).toEqual(LISTED_MODULES);
      });

      it.each<Warm>(["memory", "disk"])(
        "lists an update like a cold build when the caller names the transient files in another order (%s)",
        async (warm) => {
          const project = await createProject(discovery, { ...FIXTURE, ...extraFiles });
          const absolute = (name: string): string => path.join(project.root, name);
          const ab = [absolute("extra/a.ts"), absolute("extra/b.ts")];
          const ba = [absolute("extra/b.ts"), absolute("extra/a.ts")];
          const withFiles = (additionalFiles: string[], cache: CacheMode): IncrementalBuildOptions =>
            buildOptions(project, cache, { additionalFiles, discovery: ignoreExtra });
          await buildProjectIndex(project.root, withFiles(ba, warm));
          for (const [name, additionalFiles] of [
            ["same order", ba],
            ["other order", ab],
            ["first file only", [absolute("extra/b.ts")]],
            ["both again", ab],
            ["none", []],
          ] as const) {
            const updated = await buildProjectIndexIncremental(project.root, withFiles([...additionalFiles], warm));
            const cold = await buildProjectIndex(project.root, withFiles([...additionalFiles], "off"));
            expect(await listings(updated), `${warm}, ${name}`).toEqual(await listings(cold));
          }
          const last = await buildProjectIndexIncremental(project.root, withFiles(ab, warm));
          expect(relativePaths(project.root, moduleFiles(last))).toEqual(listedWithExtras);
        },
        60_000,
      );
    });

    it.skipIf(!CASE_INSENSITIVE_FILE_SYSTEM)(
      "keeps the discovered spelling of a file the caller names in another case, in a cold build and an update",
      async () => {
        const project = await createProject(discovery);
        const baseline = await listings(await buildProjectIndex(project.root, buildOptions(project, "off")));
        const variant = path.join(project.root, "SRC", "ZETA.TS");
        const asCaller = (extra: Partial<IncrementalBuildOptions>, cache: CacheMode): IncrementalBuildOptions =>
          buildOptions(project, cache, extra);

        const coldWithAdditional = await buildProjectIndex(
          project.root,
          asCaller({ additionalFiles: [variant] }, "off"),
        );
        expect(relativePaths(project.root, moduleFiles(coldWithAdditional))).toEqual(LISTED_MODULES);
        expect(await listings(coldWithAdditional)).toEqual(baseline);

        await buildProjectIndex(project.root, asCaller({}, "disk"));
        const updates: Array<[string, Partial<IncrementalBuildOptions>]> = [
          ["additionalFiles", { additionalFiles: [variant] }],
          ["files", { files: [variant] }],
          ["no variant again", {}],
        ];
        for (const [name, extra] of updates) {
          const updated = await buildProjectIndexIncremental(project.root, asCaller(extra, "disk"));
          expect(relativePaths(project.root, moduleFiles(updated)), name).toEqual(LISTED_MODULES);
          expect(await listings(updated), name).toEqual(baseline);
        }
      },
      60_000,
    );
  });

  describe("imported JSON modules under parse concurrency", () => {
    it.each([
      { workers: true, label: "native workers" },
      { workers: false, label: "no native workers" },
    ])(
      "lists the JSON modules in one order across repeated builds with eight threads and $label",
      async ({ workers }) => {
        const { files, expectedJsonOrder } = manyImporters(90);
        const project = await createProject("scan", files);
        const seen = new Set<string>();
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const report: BuildReport = { timings: {} };
          const index = await buildProjectIndex(
            project.root,
            buildOptions(project, "off", { threads: 8, useNativeWorkers: workers, report }),
          );
          // A pool that never started would pass for the wrong reason.
          expect(report.workerPool?.enabled).toBe(workers);
          if (workers) expect(report.workerPool?.moduleRecords).toBeGreaterThan(0);
          const modules = relativePaths(project.root, moduleFiles(index));
          expect(modules.filter((file) => file.endsWith(".json"))).toEqual(expectedJsonOrder);
          expect(modules.filter((file) => file.endsWith(".ts"))).toEqual(
            sortProjectFiles(modules.filter((file) => file.endsWith(".ts"))),
          );
          seen.add(JSON.stringify(await listings(index)));
        }
        expect(seen.size).toBe(1);
      },
      120_000,
    );
  });

  it("lists the retained edges of a cached graph and the recollected ones by file, in the order of allFiles", async () => {
    const project = await createProject("scan");
    const sources = (await listProjectFiles(project.root)).filter((file) => file.includes("/src/"));
    const full = await collectGraph(project.root, sources, { allFiles: sources, threads: 1 });
    const edited = sources.filter((file) => file.endsWith("/src/alpha/index.ts"));
    const updated = await collectGraph(project.root, edited, {
      allFiles: sources,
      baseGraph: full,
      replaceFiles: new Set(edited),
      threads: 1,
    });
    expect(updated.edges).toEqual(full.edges);
    expect([...updated.nodes]).toEqual([...full.nodes]);
  });
});
