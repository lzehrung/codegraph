import { describe, expect, it } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";

import { buildProjectIndex, buildProjectIndexIncremental, type BuildReport } from "../../src/index.js";
import { fileIdentityKey, normalizePath } from "../../src/util/paths.js";
import type { ProjectIndex } from "../../src/indexer/types.js";
import { mkTmpDir } from "../helpers/filesystem.js";

const DISK_BUILD = { cache: "disk" as const, threads: 1 };

/**
 * Consumer edges as comparable strings. A declared-container fix must produce the same warm
 * result as a cold build of the same final tree; asserting the target list rather than a
 * specific path keeps the invariant independent of the temporary root.
 */
function edgeTargets(index: ProjectIndex, file: string): string[] {
  return index.graph.edges
    .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(file))
    .map((edge) => (edge.to.type === "file" ? `file:${normalizePath(edge.to.path)}` : `external:${edge.to.name}`))
    .sort();
}

async function expectWarmMatchesCold(root: string, consumer: string, warm: ProjectIndex): Promise<string[]> {
  const cold = await buildProjectIndex(root, { cache: "off", threads: 1 });
  const warmTargets = edgeTargets(warm, consumer);
  expect(warmTargets).toEqual(edgeTargets(cold, consumer));
  return warmTargets;
}

function expectNoReprocessedFiles(report: BuildReport): void {
  expect(report.files?.parsed ?? 0).toBe(0);
  expect(report.files?.changed ?? 0).toBe(0);
}

describe("C++20 module resolution across incremental rebuilds", () => {
  it("follows a declaration that moves to another file", async () => {
    const root = await mkTmpDir("cg-cpp-inc-move-");
    try {
      const a = path.join(root, "a.cpp");
      const b = path.join(root, "b.cpp");
      const main = path.join(root, "main.cpp");
      await fsp.writeFile(a, "export module foo;\n", "utf8");
      await fsp.writeFile(main, "import foo;\n", "utf8");
      await buildProjectIndexIncremental(root, DISK_BUILD);

      await fsp.writeFile(a, "int a_value = 1;\n", "utf8");
      await fsp.writeFile(b, "export module foo;\n", "utf8");
      const warm = await buildProjectIndexIncremental(root, DISK_BUILD);
      const targets = await expectWarmMatchesCold(root, main, warm);

      expect(targets.some((target) => target.endsWith("/b.cpp"))).toBe(true);
      expect(targets).not.toContain("external:foo");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("becomes unresolved when the only declaration is deleted", async () => {
    const root = await mkTmpDir("cg-cpp-inc-delete-");
    try {
      const a = path.join(root, "a.cpp");
      const main = path.join(root, "main.cpp");
      await fsp.writeFile(a, "export module foo;\n", "utf8");
      await fsp.writeFile(main, "import foo;\n", "utf8");
      await buildProjectIndexIncremental(root, DISK_BUILD);

      await fsp.rm(a);
      const warm = await buildProjectIndexIncremental(root, DISK_BUILD);
      const targets = await expectWarmMatchesCold(root, main, warm);

      expect(targets).toEqual(["external:foo"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves when an unrelated unchanged consumer's declaration is added", async () => {
    const root = await mkTmpDir("cg-cpp-inc-add-");
    try {
      const unrelated = path.join(root, "unrelated.cpp");
      const declaring = path.join(root, "declaring.cpp");
      const main = path.join(root, "main.cpp");
      await fsp.writeFile(unrelated, "int unrelated_value = 0;\n", "utf8");
      await fsp.writeFile(main, "import foo;\n", "utf8");
      await buildProjectIndexIncremental(root, DISK_BUILD);

      await fsp.writeFile(declaring, "export module foo;\n", "utf8");
      const warm = await buildProjectIndexIncremental(root, DISK_BUILD);
      const targets = await expectWarmMatchesCold(root, main, warm);

      expect(targets.some((target) => target.endsWith("/declaring.cpp"))).toBe(true);
      expect(targets).not.toContain("external:foo");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves to the survivor when one of two duplicate declarations is deleted", async () => {
    const root = await mkTmpDir("cg-cpp-inc-dupe-");
    try {
      const alpha = path.join(root, "alpha.cpp");
      const beta = path.join(root, "beta.cpp");
      const main = path.join(root, "main.cpp");
      await fsp.writeFile(alpha, "export module shared;\n", "utf8");
      await fsp.writeFile(beta, "export module shared;\n", "utf8");
      await fsp.writeFile(main, "import shared;\n", "utf8");
      await buildProjectIndexIncremental(root, DISK_BUILD);

      await fsp.rm(beta);
      const warm = await buildProjectIndexIncremental(root, DISK_BUILD);
      const targets = await expectWarmMatchesCold(root, main, warm);

      expect(targets.some((target) => target.endsWith("/alpha.cpp"))).toBe(true);
      expect(targets).not.toContain("external:shared");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("returns to unresolved when a second declaration makes an import ambiguous", async () => {
    const root = await mkTmpDir("cg-cpp-inc-ambiguous-");
    try {
      const alpha = path.join(root, "alpha.cpp");
      const beta = path.join(root, "beta.cpp");
      const main = path.join(root, "main.cpp");
      await fsp.writeFile(alpha, "export module shared;\n", "utf8");
      await fsp.writeFile(main, "import shared;\n", "utf8");
      const resolved = await buildProjectIndexIncremental(root, DISK_BUILD);
      expect(edgeTargets(resolved, main).some((target) => target.endsWith("/alpha.cpp"))).toBe(true);

      await fsp.writeFile(beta, "export module shared;\n", "utf8");
      const warm = await buildProjectIndexIncremental(root, DISK_BUILD);
      const targets = await expectWarmMatchesCold(root, main, warm);

      expect(targets).toEqual(["external:shared"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not reprocess a module consumer when an unrelated file changes", async () => {
    const root = await mkTmpDir("cg-cpp-inc-unrelated-");
    try {
      const declaring = path.join(root, "declaring.cpp");
      const main = path.join(root, "main.cpp");
      const unrelated = path.join(root, "unrelated.ts");
      await fsp.writeFile(declaring, "export module foo;\n", "utf8");
      await fsp.writeFile(main, "import foo;\n", "utf8");
      await fsp.writeFile(unrelated, "export const value = 1;\n", "utf8");
      await buildProjectIndexIncremental(root, DISK_BUILD);

      await fsp.writeFile(unrelated, "export const value = 2;\n", "utf8");
      const report: BuildReport = { timings: {} };
      const warm = await buildProjectIndexIncremental(root, { ...DISK_BUILD, report });

      expect(report.files?.parsed ?? 0).toBe(1);
      expect(report.files?.changed ?? 0).toBe(1);
      const targets = await expectWarmMatchesCold(root, main, warm);
      expect(targets.some((target) => target.endsWith("/declaring.cpp"))).toBe(true);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not reprocess files on a warm no-change rebuild after a declaration change", async () => {
    const root = await mkTmpDir("cg-cpp-inc-nochange-");
    try {
      const declaring = path.join(root, "declaring.cpp");
      const main = path.join(root, "main.cpp");
      await fsp.writeFile(declaring, "export module foo;\n", "utf8");
      await fsp.writeFile(main, "import foo;\n", "utf8");
      const first = await buildProjectIndexIncremental(root, DISK_BUILD);
      expect(edgeTargets(first, main).some((target) => target.endsWith("/declaring.cpp"))).toBe(true);

      const report: BuildReport = { timings: {} };
      await buildProjectIndexIncremental(root, { ...DISK_BUILD, report });

      expectNoReprocessedFiles(report);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
