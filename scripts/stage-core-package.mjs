import { stageCorePackage } from "./stage-core-package-lib.mjs";

try {
  const result = stageCorePackage();
  console.log(`[codegraph] Staged ${result.files.length} files into packages/codegraph-core/dist`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[codegraph] Failed to stage @lzehrung/codegraph-core: ${message}`);
  process.exitCode = 1;
}
