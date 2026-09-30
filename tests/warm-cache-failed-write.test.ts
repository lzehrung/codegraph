import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildProjectIndex } from "../src/index.js";
import type { ProjectIndex } from "../src/indexer/types.js";
import { fileIdentityKey, normalizePath } from "../src/util/paths.js";
import { mkTmpDir } from "./helpers/filesystem.js";

const control = vi.hoisted(() => ({ dropWrites: false }));

// A cache write that fails is logged and skipped, so the build still succeeds.
vi.mock("../src/indexer/build-cache/module-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/indexer/build-cache/module-cache.js")>();
  return {
    ...actual,
    writeModulesToCache: (...args: Parameters<typeof actual.writeModulesToCache>) => {
      if (control.dropWrites) return;
      actual.writeModulesToCache(...args);
    },
  };
});

function bindingTargets(index: ProjectIndex, file: string): string[] {
  const mod = index.byFile.get(fileIdentityKey(file));
  return [
    ...new Set(
      (mod?.imports ?? []).map((binding) =>
        typeof binding.resolved === "string"
          ? `file:${normalizePath(binding.resolved)}`
          : `external:${binding.resolved?.external ?? ""}`,
      ),
    ),
  ].sort();
}

describe("warm module-cache builds when the replacement cache write fails", () => {
  // The stale importer row still matches its own source signature. Without dropping it before the
  // rebuild, the failed write leaves it behind, the deletion is already consumed, and the next
  // build reuses the stale external binding for good.
  it("does not reuse a stale importer row after a failed write (memory cache)", async () => {
    const root = await mkTmpDir("cg-module-cache-failed-write-");
    try {
      const alpha = path.join(root, "alpha.cpp");
      const main = path.join(root, "main.cpp");
      await fsp.writeFile(alpha, "export module shared;\n", "utf8");
      await fsp.writeFile(path.join(root, "beta.cpp"), "export module shared;\n", "utf8");
      await fsp.writeFile(main, "import shared;\n", "utf8");
      const ambiguous = await buildProjectIndex(root, { cache: "memory" });
      expect(bindingTargets(ambiguous, main)).toEqual(["external:shared"]);

      await fsp.rm(path.join(root, "beta.cpp"));
      control.dropWrites = true;
      let dropped: ProjectIndex;
      try {
        dropped = await buildProjectIndex(root, { cache: "memory" });
      } finally {
        control.dropWrites = false;
      }
      expect(bindingTargets(dropped, main)).toEqual(["file:" + normalizePath(alpha)]);

      const retry = await buildProjectIndex(root, { cache: "memory" });
      const cold = await buildProjectIndex(root, { cache: "off" });
      expect(bindingTargets(retry, main)).toEqual(bindingTargets(cold, main));
      expect(bindingTargets(retry, main)).toEqual(["file:" + normalizePath(alpha)]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
