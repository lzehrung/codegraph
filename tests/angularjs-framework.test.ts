import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import {
  buildProjectIndex,
  buildSymbolGraphDetailed,
  collectGraph,
} from "../src/index.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

const normalizePath = (value: string): string => value.replace(/\\/g, "/");

describe("AngularJS framework characterization", () => {
  it("keeps useful baseline JS import and symbol-use edges inside controller bodies", async () => {
    const root = await mkTmpDir("cg-angularjs-baseline-");
    await fsp.writeFile(
      path.join(root, "user.service.js"),
      [
        "export function userService($http) {",
        "  return {",
        "    load() {",
        "      return $http.get('/api/users');",
        "    }",
        "  };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, "user.controller.js"),
      [
        "import { userService } from './user.service.js';",
        "angular.module('admin').controller('UserCtrl', ['$scope', '$state', 'userService', function UserCtrl($scope, $state, userService) {",
        "  $scope.refresh = function refresh() {",
        "    return userService.load();",
        "  };",
        "}]);",
        "",
      ].join("\n"),
      "utf8",
    );

    const index = await buildProjectIndex(root);
    const graph = await collectGraph(root, Array.from(index.byFile.keys()));
    const detailed = await buildSymbolGraphDetailed(index);

    const controllerFile = normalizePath(
      path.join(root, "user.controller.js"),
    );
    const serviceFile = normalizePath(path.join(root, "user.service.js"));
    const controllerModule = index.byFile.get(controllerFile);
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
          edge.from === controllerFile &&
          edge.to.type === "file" &&
          normalizePath(edge.to.path) === serviceFile,
      ),
    ).toBe(true);

    const nodes = Array.from(detailed.nodes.values()).map((node) => ({
      ...node,
      file: normalizePath(node.file),
    }));
    const refreshDef = nodes.find(
      (node) => node.file === controllerFile && node.name === "refresh",
    );
    const importedUserService = nodes.find(
      (node) =>
        node.file === controllerFile &&
        node.name === "userService" &&
        node.kind === "import",
    );
    const serviceDef = nodes.find(
      (node) => node.file === serviceFile && node.name === "userService",
    );

    expect(refreshDef).toBeDefined();
    expect(importedUserService).toBeDefined();
    expect(serviceDef).toBeDefined();
    expect(
      detailed.edges.some(
        (edge) =>
          edge.from === refreshDef?.id &&
          edge.to === serviceDef?.id &&
          edge.label === "uses",
      ),
    ).toBe(true);
    expect(
      detailed.edges.some(
        (edge) =>
          edge.from === importedUserService?.id &&
          edge.to === serviceDef?.id &&
          edge.label === "userService",
      ),
    ).toBe(true);
  });

  it("adds heuristic graph edges for AngularJS template, controller, and DI wiring", async () => {
    const root = await mkTmpDir("cg-angularjs-graph-");
    await fsp.writeFile(
      path.join(root, "user.service.js"),
      [
        "angular.module('admin').service('userService', function userService($http) {",
        "  this.load = function load() {",
        "    return $http.get('/api/users');",
        "  };",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, "user.controller.js"),
      [
        "angular.module('admin').controller('UserCtrl', ['$scope', '$state', 'userService', function UserCtrl($scope, $state, userService) {",
        "  $scope.refresh = function refresh() {",
        "    return userService.load();",
        "  };",
        "}]);",
        "",
      ].join("\n"),
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, "user-card.directive.js"),
      [
        "angular.module('admin').directive('userCard', function userCard() {",
        "  return {",
        "    scope: {},",
        "    templateUrl: './user-card.template.html',",
        "    controller: 'UserCtrl',",
        "    controllerAs: 'vm'",
        "  };",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, "user-card.template.html"),
      "<section><button ng-click=\"vm.refresh()\">Refresh</button></section>\n",
      "utf8",
    );

    const index = await buildProjectIndex(root);
    const graph = await collectGraph(root, Array.from(index.byFile.keys()));
    const detailed = await buildSymbolGraphDetailed(index);

    const directiveFile = normalizePath(
      path.join(root, "user-card.directive.js"),
    );
    const serviceFile = normalizePath(path.join(root, "user.service.js"));
    const controllerFile = normalizePath(
      path.join(root, "user.controller.js"),
    );
    const templateFile = normalizePath(
      path.join(root, "user-card.template.html"),
    );

    expect(index.byFile.get(directiveFile)?.imports).toEqual([]);
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
        (edge) =>
          edge.from === controllerFile &&
          edge.to.type === "external" &&
          edge.to.name === "$scope",
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.from === controllerFile &&
          edge.to.type === "external" &&
          edge.to.name === "$state",
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
    expect(
      nodes.some(
        (node) => node.file === controllerFile && node.name === "UserCtrl",
      ),
    ).toBe(false);
    expect(
      nodes.some(
        (node) => node.file === directiveFile && node.name === "userCard",
      ),
    ).toBe(false);
    expect(
      nodes.some(
        (node) => node.file === controllerFile && node.name === "$state",
      ),
    ).toBe(false);
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
    await fsp.writeFile(
      path.join(root, "user.controller.js"),
      "export function UserCtrl() {}\n",
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, "user-card.template.html"),
      "<section></section>\n",
      "utf8",
    );

    const index = await buildProjectIndex(root);
    const graph = await collectGraph(root, Array.from(index.byFile.keys()));
    const configFile = normalizePath(path.join(root, "page-config.js"));
    const controllerFile = normalizePath(path.join(root, "user.controller.js"));
    const templateFile = normalizePath(
      path.join(root, "user-card.template.html"),
    );

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === configFile &&
          edge.to.type === "file" &&
          normalizePath(edge.to.path) === controllerFile,
      ),
    ).toBe(false);
    expect(
      graph.edges.some(
        (edge) =>
          edge.from === configFile &&
          edge.to.type === "file" &&
          normalizePath(edge.to.path) === templateFile,
      ),
    ).toBe(false);
  });
});
