import { describe, expect, it, vi } from "vitest";
import type { ProjectFileInfo } from "../src/util/projectFiles.js";

const mocks = vi.hoisted(() => ({
  discoverProjectFiles: vi.fn(async () => []),
}));

vi.mock("../src/util/projectFiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/util/projectFiles.js")>();
  return {
    ...actual,
    discoverProjectFiles: mocks.discoverProjectFiles,
  };
});

import { finalizeProjectIndex } from "../src/indexer/finalize.js";

describe("finalizeProjectIndex", () => {
  it("uses provided project-file metadata without rediscovering it", async () => {
    const projectFiles: ProjectFileInfo[] = [
      {
        path: "/repo/package.json",
        kind: "file",
        type: "node",
        role: "manifest",
        projectRoot: "/repo",
        name: "repo",
      },
    ];

    const index = await finalizeProjectIndex({
      projectRoot: "/repo",
      normalizedProjectRoot: "/repo",
      opts: undefined,
      timings: undefined,
      totalStart: performance.now(),
      graph: { nodes: new Set(), edges: [] },
      modules: new Map(),
      parsedMap: new Map(),
      bloomFilterCache: undefined,
      projectFiles: Promise.resolve(projectFiles),
    });

    expect(index.projectFiles).toEqual(projectFiles);
    expect(mocks.discoverProjectFiles).not.toHaveBeenCalled();
  });

  it("returns the resolved normalizedProjectRoot instead of the raw possibly-relative projectRoot", async () => {
    const index = await finalizeProjectIndex({
      projectRoot: ".",
      normalizedProjectRoot: "/repo",
      opts: undefined,
      timings: undefined,
      totalStart: performance.now(),
      graph: { nodes: new Set(), edges: [] },
      modules: new Map(),
      parsedMap: new Map(),
      bloomFilterCache: undefined,
      projectFiles: Promise.resolve([]),
    });

    expect(index.projectRoot).toBe("/repo");
  });
});
