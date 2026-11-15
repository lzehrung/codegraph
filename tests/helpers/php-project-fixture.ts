import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { buildProjectIndex } from "../../src/indexer/build-index.js";
import { closeDiskCacheDatabase } from "../../src/indexer/build-cache.js";
import type { ProjectIndex } from "../../src/indexer/types.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { writeFixtureFiles } from "../languages/callable-consumer-fixtures.js";
import { mkTmpDir } from "./filesystem.js";

/**
 * Runs `consume` on a cold build, a first disk build, and a reopened disk build of a PHP project, after checking that
 * every file went through native extraction. `files` maps project-relative paths to source text, and the callback
 * receives the same paths resolved under the project root.
 */
export async function withPhpFiles(
  files: Readonly<Record<string, string>>,
  consume: (index: ProjectIndex, paths: Record<string, string>, root: string) => Promise<void>,
): Promise<void> {
  const temporary = await mkTmpDir("cg-php-project-");
  const root = path.join(temporary, "project");
  const diskOptions = { cache: "disk", cacheDir: path.join(temporary, "cache") } as const;
  try {
    const paths = await writeFixtureFiles(root, files);
    for (const cache of ["off", "disk", "disk"] as const) {
      if (cache === "disk") closeDiskCacheDatabase(root, diskOptions);
      const index = await buildProjectIndex(root, { ...diskOptions, cache, threads: 1 });
      for (const file of Object.values(paths)) {
        expect(index.byFile.get(fileIdentityKey(file))?.nativeOutcome).toBe("used");
      }
      await consume(index, paths, root);
    }
  } finally {
    closeDiskCacheDatabase(root, diskOptions);
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
