import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { buildProjectIndex, buildSymbolGraphDetailed, collectGraph } from "../src/index.js";
import { extractAngularJsRegistrations } from "../src/frameworks/angularjs.js";
import { fileIdentityKey } from "../src/util/paths.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

const normalizePath = (value: string): string => value.replace(/\\/g, "/");
const frameworkSamplePath = (...parts: string[]): string =>
  path.resolve(process.cwd(), "tests", "samples", "frameworks", "angularjs", ...parts);

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
    expect(nodes.some((node) => node.file === controllerFile && node.name === "UserCtrl")).toBe(false);
    expect(nodes.some((node) => node.file === directiveFile && node.name === "userCard")).toBe(false);
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
});
