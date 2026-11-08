import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  buildSymbolGraphDetailed,
  collectGraph,
} from "../src/index.js";
import { extractAngularJsRegistrations } from "../src/frameworks/angularjs.js";
import { clearMemoryCache } from "../src/indexer/build-cache/module-cache.js";
import type { BuildOptions, BuildReport, ProjectIndex } from "../src/indexer/types.js";
import type { Graph } from "../src/types.js";
import { fileIdentityKey } from "../src/util/paths.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

const normalizePath = (value: string): string => value.replace(/\\/g, "/");
const frameworkSamplePath = (...parts: string[]): string =>
  path.resolve(process.cwd(), "tests", "samples", "frameworks", "angularjs", ...parts);

function heuristicEdges(graph: Graph): string[] {
  return graph.edges
    .filter((edge) => edge.resolved === "heuristic")
    .map((edge) => {
      const target = edge.to.type === "file" ? path.basename(edge.to.path) : `external:${edge.to.name}`;
      return `${path.basename(edge.from)} -> ${target} raw=${edge.raw} confidence=${edge.confidence}`;
    })
    .sort();
}

async function expectAngularJsGraph(root: string, index: ProjectIndex, expected: string[]): Promise<void> {
  expect(heuristicEdges(index.graph)).toEqual([...expected].sort());
  const graph = await collectGraph(
    root,
    [...index.byFile.values()].map((module) => module.file),
  );
  expect(heuristicEdges(graph)).toEqual([...expected].sort());
}

describe("AngularJS framework characterization", () => {
  it("keeps useful baseline JS import and symbol-use edges inside controller bodies", async () => {
    const root = frameworkSamplePath("baseline");

    const index = await buildProjectIndex(root);
    const graph = await collectGraph(root, [
      normalizePath(path.join(root, "user.controller.js")),
      normalizePath(path.join(root, "user.service.js")),
    ]);
    const detailed = await buildSymbolGraphDetailed(index);

    const controllerFile = normalizePath(path.join(root, "user.controller.js"));
    const serviceFile = normalizePath(path.join(root, "user.service.js"));
    const controllerModule = index.byFile.get(fileIdentityKey(controllerFile));
    expect(controllerModule?.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "named",
          local: "userService",
          imported: "userService",
          resolved: serviceFile,
        }),
      ]),
    );

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === controllerFile && edge.to.type === "file" && normalizePath(edge.to.path) === serviceFile,
      ),
    ).toBe(true);

    const nodes = Array.from(detailed.nodes.values()).map((node) => ({
      ...node,
      file: normalizePath(node.file),
    }));
    const refreshDef = nodes.find((node) => node.file === controllerFile && node.name === "refresh");
    const importedUserService = nodes.find(
      (node) => node.file === controllerFile && node.name === "userService" && node.kind === "import",
    );
    const serviceDef = nodes.find((node) => node.file === serviceFile && node.name === "userService");

    expect(refreshDef).toBeDefined();
    expect(importedUserService).toBeDefined();
    expect(serviceDef).toBeDefined();
    expect(
      detailed.edges.some(
        (edge) => edge.from === refreshDef?.id && edge.to === serviceDef?.id && edge.label === "uses",
      ),
    ).toBe(true);
    expect(
      detailed.edges.some(
        (edge) => edge.from === importedUserService?.id && edge.to === serviceDef?.id && edge.label === "userService",
      ),
    ).toBe(true);
  });

  it("triggers AngularJS heuristics for bracket-access module registration", async () => {
    const root = frameworkSamplePath("bracket-access");

    const graph = await collectGraph(root, [
      normalizePath(path.join(root, "user.controller.js")),
      normalizePath(path.join(root, "user.service.js")),
    ]);

    const controllerFile = normalizePath(path.join(root, "user.controller.js"));
    const serviceFile = normalizePath(path.join(root, "user.service.js"));

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === controllerFile && edge.to.type === "file" && normalizePath(edge.to.path) === serviceFile,
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) => edge.from === controllerFile && edge.to.type === "external" && edge.to.name === "$scope",
      ),
    ).toBe(true);
  });

  it("adds heuristic graph edges for AngularJS template, controller, and DI wiring", async () => {
    const root = frameworkSamplePath("graph");

    const index = await buildProjectIndex(root);
    const graph = await collectGraph(root, [
      normalizePath(path.join(root, "user-card.directive.js")),
      normalizePath(path.join(root, "user.service.js")),
      normalizePath(path.join(root, "user.controller.js")),
      normalizePath(path.join(root, "user-card.template.html")),
    ]);
    const detailed = await buildSymbolGraphDetailed(index);

    const directiveFile = normalizePath(path.join(root, "user-card.directive.js"));
    const serviceFile = normalizePath(path.join(root, "user.service.js"));
    const controllerFile = normalizePath(path.join(root, "user.controller.js"));
    const templateFile = normalizePath(path.join(root, "user-card.template.html"));

    expect(index.byFile.get(fileIdentityKey(directiveFile))?.imports).toEqual([]);
    expect(
      graph.edges.some(
        (edge) =>
          edge.from === controllerFile &&
          edge.to.type === "file" &&
          normalizePath(edge.to.path) === serviceFile &&
          edge.raw === "userService",
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) => edge.from === controllerFile && edge.to.type === "external" && edge.to.name === "$scope",
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) => edge.from === controllerFile && edge.to.type === "external" && edge.to.name === "$state",
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.from === directiveFile &&
          edge.to.type === "file" &&
          normalizePath(edge.to.path) === controllerFile &&
          edge.raw === "UserCtrl",
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.from === directiveFile &&
          edge.to.type === "file" &&
          normalizePath(edge.to.path) === templateFile &&
          edge.raw === "./user-card.template.html",
      ),
    ).toBe(true);

    const nodes = Array.from(detailed.nodes.values()).map((node) => ({
      ...node,
      file: normalizePath(node.file),
    }));
    // `UserCtrl` and `userCard` are real declarations: the DI array and the directive factory are
    // named function expressions (`function UserCtrl(...)`, `function userCard()`), so their own
    // names bind. The heuristics still invent no node for the registration string itself.
    expect(nodes.some((node) => node.file === controllerFile && node.name === "UserCtrl")).toBe(true);
    expect(nodes.some((node) => node.file === directiveFile && node.name === "userCard")).toBe(true);
    expect(nodes.some((node) => node.file === controllerFile && node.name === "$state")).toBe(true);
  });

  it("does not trigger AngularJS heuristics for non-AngularJS controller/template config", async () => {
    const root = await mkTmpDir("cg-angularjs-guard-");
    await fsp.writeFile(
      path.join(root, "page-config.js"),
      [
        "export const page = createPage({",
        "  controller: 'UserCtrl',",
        "  templateUrl: './user-card.template.html',",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
    await fsp.writeFile(path.join(root, "user.controller.js"), "export function UserCtrl() {}\n", "utf8");
    await fsp.writeFile(path.join(root, "user-card.template.html"), "<section></section>\n", "utf8");

    const index = await buildProjectIndex(root);
    const graph = await collectGraph(root, Array.from(index.byFile.keys()));
    const configFile = normalizePath(path.join(root, "page-config.js"));
    const controllerFile = normalizePath(path.join(root, "user.controller.js"));
    const templateFile = normalizePath(path.join(root, "user-card.template.html"));

    expect(
      graph.edges.some(
        (edge) => edge.from === configFile && edge.to.type === "file" && normalizePath(edge.to.path) === controllerFile,
      ),
    ).toBe(false);
    expect(
      graph.edges.some(
        (edge) => edge.from === configFile && edge.to.type === "file" && normalizePath(edge.to.path) === templateFile,
      ),
    ).toBe(false);
  });

  it("does not treat unrelated dotted methods as AngularJS registrations", async () => {
    const root = await mkTmpDir("cg-angularjs-registration-guard-");
    const unrelatedSource = ["angular.module('admin');", "foo.controller('Fake');", ""].join("\n");
    const consumerSource = ["angular.module('admin').directive('widget', {", "  controller: 'Fake',", "});", ""].join(
      "\n",
    );
    await fsp.writeFile(path.join(root, "unrelated.js"), unrelatedSource, "utf8");
    await fsp.writeFile(path.join(root, "consumer.js"), consumerSource, "utf8");

    expect(extractAngularJsRegistrations(unrelatedSource)).toEqual([]);

    const index = await buildProjectIndex(root);
    const graph = await collectGraph(root, Array.from(index.byFile.keys()));
    const consumerFile = normalizePath(path.join(root, "consumer.js")).toLowerCase();
    const unrelatedFile = normalizePath(path.join(root, "unrelated.js")).toLowerCase();
    expect(
      graph.edges.some(
        (edge) =>
          edge.from.toLowerCase() === consumerFile &&
          edge.to.type === "file" &&
          normalizePath(edge.to.path).toLowerCase() === unrelatedFile,
      ),
    ).toBe(false);
  });

  it("registers window.angular module chains but not unrelated dotted controllers", () => {
    const namespaced = [
      "window.angular.module('m').controller('C', function C() {});",
      "foo.controller('Fake');",
      "",
    ].join("\n");

    expect(extractAngularJsRegistrations(namespaced)).toEqual([{ kind: "controller", name: "C" }]);
    expect(extractAngularJsRegistrations("foo.controller('Fake');")).toEqual([]);
  });

  it("keeps registrations on variables assigned from an AngularJS module", async () => {
    const root = await mkTmpDir("cg-angularjs-module-variable-");
    const serviceSource = [
      "const app = angular.module('admin');",
      "app.service('userService', function userService() {});",
      "",
    ].join("\n");
    const controllerSource = [
      "angular.module('admin').controller('UserCtrl', [",
      "  'userService',",
      "  function UserCtrl(userService) {},",
      "]);",
      "",
    ].join("\n");
    await fsp.writeFile(path.join(root, "user.service.js"), serviceSource, "utf8");
    await fsp.writeFile(path.join(root, "user.controller.js"), controllerSource, "utf8");

    expect(extractAngularJsRegistrations(serviceSource)).toEqual([{ kind: "service", name: "userService" }]);

    const index = await buildProjectIndex(root);
    const graph = await collectGraph(root, Array.from(index.byFile.keys()));
    const controllerFile = normalizePath(path.join(root, "user.controller.js")).toLowerCase();
    const serviceFile = normalizePath(path.join(root, "user.service.js")).toLowerCase();
    expect(
      graph.edges.some(
        (edge) =>
          edge.from.toLowerCase() === controllerFile &&
          edge.to.type === "file" &&
          normalizePath(edge.to.path).toLowerCase() === serviceFile &&
          edge.raw === "userService",
      ),
    ).toBe(true);
  });

  it("adds the same heuristic edges for a TypeScript AngularJS project as for JavaScript", async () => {
    const root = frameworkSamplePath("graph-ts");

    const graph = await collectGraph(root, [
      normalizePath(path.join(root, "user-card.directive.ts")),
      normalizePath(path.join(root, "user.service.ts")),
      normalizePath(path.join(root, "user.controller.ts")),
      normalizePath(path.join(root, "user-card.template.html")),
    ]);

    const directiveFile = normalizePath(path.join(root, "user-card.directive.ts"));
    const serviceFile = normalizePath(path.join(root, "user.service.ts"));
    const controllerFile = normalizePath(path.join(root, "user.controller.ts"));
    const templateFile = normalizePath(path.join(root, "user-card.template.html"));

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === controllerFile &&
          edge.to.type === "file" &&
          normalizePath(edge.to.path) === serviceFile &&
          edge.raw === "userService" &&
          edge.resolved === "heuristic" &&
          edge.confidence === 0.8,
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) => edge.from === controllerFile && edge.to.type === "external" && edge.to.name === "$scope",
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) => edge.from === controllerFile && edge.to.type === "external" && edge.to.name === "$state",
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.from === directiveFile &&
          edge.to.type === "file" &&
          normalizePath(edge.to.path) === controllerFile &&
          edge.raw === "UserCtrl",
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.from === directiveFile &&
          edge.to.type === "file" &&
          normalizePath(edge.to.path) === templateFile &&
          edge.raw === "./user-card.template.html",
      ),
    ).toBe(true);
  });

  it("does not trigger AngularJS heuristics for a non-Angular TypeScript file", async () => {
    const root = await mkTmpDir("cg-angularjs-ts-guard-");
    await fsp.writeFile(
      path.join(root, "page-config.ts"),
      [
        "export const page = createPage({",
        "  controller: 'UserCtrl',",
        "  templateUrl: './user-card.template.html',",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
    await fsp.writeFile(path.join(root, "user.controller.ts"), "export function UserCtrl(): void {}\n", "utf8");
    await fsp.writeFile(path.join(root, "user-card.template.html"), "<section></section>\n", "utf8");

    const index = await buildProjectIndex(root);
    const graph = await collectGraph(root, Array.from(index.byFile.keys()));
    const configFile = normalizePath(path.join(root, "page-config.ts"));
    const controllerFile = normalizePath(path.join(root, "user.controller.ts"));
    const templateFile = normalizePath(path.join(root, "user-card.template.html"));

    expect(
      graph.edges.some(
        (edge) => edge.from === configFile && edge.to.type === "file" && normalizePath(edge.to.path) === controllerFile,
      ),
    ).toBe(false);
    expect(
      graph.edges.some(
        (edge) => edge.from === configFile && edge.to.type === "file" && normalizePath(edge.to.path) === templateFile,
      ),
    ).toBe(false);
  });

  it.each([
    { cache: "disk", workers: false },
    { cache: "memory", workers: false },
    { cache: "disk", workers: true },
    { cache: "memory", workers: true },
  ] as const)(
    "keeps cold, incremental, and full AngularJS graphs equal with $cache cache and workers=$workers",
    async ({ cache, workers }) => {
      const root = await mkTmpDir("cg-angularjs-incremental-");
      const cacheDir = `${root}-cache`;
      const controller = path.join(root, "user.controller.js");
      const service = path.join(root, "user.service.js");
      const directive = path.join(root, "user-card.directive.js");
      const other = path.join(root, "other.js");
      const template = path.join(root, "user-card.html");
      const options: BuildOptions = {
        cache,
        cacheDir,
        cacheStrict: true,
        threads: 1,
        useNativeWorkers: workers,
        nativeThreads: 1,
      };
      const controllerSource = (name: string, body = "") =>
        `angular.module('admin').controller('${name}', function ${name}() { ${body} });\n`;
      const directiveSource = (name: string, comment = "") =>
        `angular.module('admin').directive('userCard', ['userService', function userCard(userService) {\n${comment}  return { controller: '${name}', templateUrl: './user-card.html' };\n}]);\n`;
      const linked = (name: string) => [
        `user-card.directive.js -> user.controller.js raw=${name} confidence=0.9`,
        "user-card.directive.js -> user.service.js raw=userService confidence=0.8",
        "user-card.directive.js -> user-card.html raw=./user-card.html confidence=0.9",
      ];
      const external = (name: string) => [
        `user-card.directive.js -> external:${name} raw=${name} confidence=0.75`,
        "user-card.directive.js -> user.service.js raw=userService confidence=0.8",
        "user-card.directive.js -> user-card.html raw=./user-card.html confidence=0.9",
      ];
      try {
        await fsp.writeFile(controller, controllerSource("UserCtrl"));
        await fsp.writeFile(service, "angular.module('admin').service('userService', function userService() {});\n");
        await fsp.writeFile(directive, directiveSource("UserCtrl"));
        await fsp.writeFile(other, "const unrelated = { controller: 'UserCtrl', templateUrl: './fake.html' };\n");
        await fsp.writeFile(template, "<section>card</section>\n");

        const coldReport: BuildReport = { timings: {} };
        const cold = await buildProjectIndex(root, { ...options, report: coldReport });
        expect(coldReport.workerPool?.enabled).toBe(workers);
        if (workers) expect(coldReport.workerPool?.moduleRecords).toBeGreaterThan(0);
        expect(cold.byFile.get(fileIdentityKey(controller.replace(/\\/g, "/")))?.angularJsFacts?.registrations).toEqual(
          [{ kind: "controller", name: "UserCtrl" }],
        );
        await expectAngularJsGraph(root, cold, linked("UserCtrl"));

        const update = async (expected: string[]): Promise<ProjectIndex> => {
          if (cache === "disk") clearMemoryCache();
          const index = await buildProjectIndexIncremental(root, options);
          await expectAngularJsGraph(root, index, expected);
          return index;
        };
        await fsp.writeFile(directive, directiveSource("UserCtrl", "  // edited reference\n"));
        const referencingEdit = await update(linked("UserCtrl"));
        expect(
          referencingEdit.byFile.get(fileIdentityKey(directive.replace(/\\/g, "/")))?.angularJsFacts?.references,
        ).toEqual([
          { kind: "templateUrl", value: "./user-card.html" },
          { kind: "controller", value: "UserCtrl" },
          { kind: "inject", value: "userService" },
        ]);

        await fsp.writeFile(controller, controllerSource("UserCtrl", "const edited = 1;"));
        await update(linked("UserCtrl"));
        await fsp.writeFile(
          other,
          "const unrelated = { controller: 'UserCtrl', templateUrl: './fake.html' };\n// edit\n",
        );
        await update(linked("UserCtrl"));
        await fsp.rm(controller);
        await update(external("UserCtrl"));
        await fsp.writeFile(controller, controllerSource("UserCtrl"));
        await update(linked("UserCtrl"));
        await fsp.writeFile(controller, controllerSource("RenamedCtrl"));
        await update(external("UserCtrl"));
        await fsp.writeFile(directive, directiveSource("RenamedCtrl"));
        await update(linked("RenamedCtrl"));
      } finally {
        clearMemoryCache();
        await fsp.rm(root, { recursive: true, force: true });
        await fsp.rm(cacheDir, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it.each(["ts", "tsx"] as const)("keeps cold and incremental .%s AngularJS framework edges", async (extension) => {
    const root = await mkTmpDir("cg-angularjs-typed-incremental-");
    const controller = path.join(root, `user.controller.${extension}`);
    const directive = path.join(root, `user.directive.${extension}`);
    const template = path.join(root, "user.html");
    const options: BuildOptions = { cache: "memory", useNativeWorkers: false };
    try {
      await fsp.writeFile(controller, "angular.module('admin').controller('UserCtrl', function UserCtrl() {});\n");
      await fsp.writeFile(
        directive,
        "angular.module('admin').directive('user', { controller: 'UserCtrl', templateUrl: './user.html' });\n",
      );
      await fsp.writeFile(template, "<section>user</section>\n");
      const expected = [
        `user.directive.${extension} -> user.controller.${extension} raw=UserCtrl confidence=0.9`,
        `user.directive.${extension} -> user.html raw=./user.html confidence=0.9`,
      ];
      await expectAngularJsGraph(root, await buildProjectIndex(root, options), expected);
      await fsp.writeFile(
        controller,
        "angular.module('admin').controller('UserCtrl', function UserCtrl() { const changed = 1; });\n",
      );
      await expectAngularJsGraph(root, await buildProjectIndexIncremental(root, options), expected);
    } finally {
      clearMemoryCache();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
