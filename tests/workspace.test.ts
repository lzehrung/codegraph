import { describe, it, expect } from "vitest";
import path from "node:path";
import { buildProjectIndex, collectGraph, goToDefinition } from "../src/index.js";
import { readOnlySamplePath } from "./helpers/filesystem.js";

/* Minimal smoke tests to validate workspace detection wiring. Full fixtures are created in tests/samples/monorepo in a later step. */

describe("Monorepo workspace support", () => {
  const root = readOnlySamplePath("monorepo");

  it("loads workspace config and resolves cross-package imports", async () => {
    const index = await buildProjectIndex(root, { cache: "off" });
    expect(index).toBeDefined();

    // Ensure both packages are indexed
    const files = [...index.byFile.keys()];
    const hasPkgA = files.some((f) => f.includes("packages/pkg-a/src/index.ts"));
    const hasPkgB = files.some((f) => f.includes("packages/pkg-b/src/index.js"));
    expect(hasPkgA && hasPkgB).toBe(true);
  });

  it("creates graph edges from pkg-b to pkg-a via workspace resolution", async () => {
    const files = [
      path.join(root, "packages", "pkg-a", "src", "index.ts"),
      path.join(root, "packages", "pkg-b", "src", "index.js"),
    ];
    const graph = await collectGraph(root, files);
    const edge = graph.edges.find((e) => e.from.endsWith("packages/pkg-b/src/index.js") && e.raw === "@acme/pkg-a");
    expect(edge).toBeTruthy();
    expect(edge?.to.type).toBe("file");
  });

  it("per-package tsconfig paths: pkg-ts-consumer local alias and cross-package import", async () => {
    const index = await buildProjectIndex(root, { cache: "off" });
    const packageA = path.join(root, "packages", "pkg-a", "src", "index.ts");
    const packageConsumer = path.join(root, "packages", "pkg-ts-consumer", "src", "index.ts");
    const packageUtil = path.join(root, "packages", "pkg-ts-consumer", "src", "util.ts");

    // Ensure consumer and util are indexed
    const files = [...index.byFile.keys()].map((file) => file.replace(/\\/g, "/"));
    expect(files.some((file) => file.endsWith("packages/pkg-ts-consumer/src/index.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("packages/pkg-ts-consumer/src/util.ts"))).toBe(true);

    // Graph should resolve @acme/pkg-a and @local/util from consumer
    const consumer = packageConsumer.replace(/\\/g, "/");
    const graph = index.graph;
    const edgeToPkgA = graph.edges.find((edge) => edge.from === consumer && edge.raw === "@acme/pkg-a");
    const edgeToLocal = graph.edges.find((edge) => edge.from === consumer && edge.raw === "@local/util");
    expect(edgeToPkgA).toBeDefined();
    expect(edgeToPkgA?.to.type).toBe("file");
    if (edgeToPkgA?.to.type === "file") {
      expect(edgeToPkgA.to.path.replace(/\\/g, "/")).toBe(packageA.replace(/\\/g, "/"));
    }
    expect(edgeToLocal).toBeDefined();
    expect(edgeToLocal?.to.type).toBe("file");
    if (edgeToLocal?.to.type === "file") {
      expect(edgeToLocal.to.path.replace(/\\/g, "/")).toBe(packageUtil.replace(/\\/g, "/"));
    }

    // Go to def for aHelper usage from pkg-a (line 5: return defA() + aHelper() + localUtil())
    const packageResult = await goToDefinition(index, {
      file: packageConsumer.replace(/\\/g, "/"),
      line: 5,
      column: 24,
    });
    expect(packageResult.status).toBe("ok");
    if (packageResult.status === "ok") {
      expect(packageResult.definition.file.replace(/\\/g, "/")).toBe(packageA.replace(/\\/g, "/"));
    }

    // Go to def for localUtil via @local alias (usage on line 5)
    const localResult = await goToDefinition(index, {
      file: packageConsumer.replace(/\\/g, "/"),
      line: 5,
      column: 38,
    });
    expect(localResult.status).toBe("ok");
    if (localResult.status === "ok") {
      expect(localResult.definition.file.replace(/\\/g, "/")).toContain("packages/pkg-ts-consumer/src/util.ts");
    }
  });
});
