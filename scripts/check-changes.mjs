import fs from "node:fs";
import path from "node:path";
import { readCacheEpochs } from "./cache-epochs-lib.mjs";
import { readChangelogFragments, unreleasedSection } from "./changelog-fragments-lib.mjs";

try {
  const rootDir = process.cwd();
  unreleasedSection(fs.readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8"));
  const fragments = readChangelogFragments(rootDir);
  readCacheEpochs(rootDir);
  console.log(`Change records valid: ${fragments.length} changelog fragments; cache epoch entries valid.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
