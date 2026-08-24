import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectDistForTests } from "./ensure-dist-for-tests-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRequiredSuites = [
  "tests/native-parse-tree.test.ts",
  "tests/native-semantic-parity.test.ts",
  "tests/native-parser-ownership.test.ts",
  "tests/native-query-ownership-parity.test.ts",
  "tests/native-query-scope.test.ts",
  "tests/native-worker-parity.test.ts",
  "tests/detailed-symbol-native-only.test.ts",
  "tests/native-cache-windows.test.ts",
  "tests/call-hierarchy-language-parity.test.ts",
  "tests/type-hierarchy-language-parity.test.ts",
  "tests/native-combined-extraction.test.ts",
  "tests/cache-path-confinement.test.ts",
  "tests/fallback-import-extraction.test.ts",
  "tests/duplicates.test.ts",
];

function run(command, args, extraEnv) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    shell: process.platform === "win32",
    stdio: "inherit",
    ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

const distState = inspectDistForTests(rootDir);
if (distState.needsBuild) {
  const buildStatus = run("npm", ["run", "build"]);
  if (buildStatus) {
    process.exit(buildStatus);
  }
}

const availability = await import("../dist/native/treeSitterNative.js");
if (!availability.isNativeTreeSitterAvailable("on")) {
  const loadError = availability.getNativeTreeSitterLoadError("on");
  console.error("[codegraph] Native-required tests need @lzehrung/codegraph-native to load successfully.");
  if (loadError) {
    console.error(`[codegraph] Native load error: ${loadError.message}`);
  }
  process.exit(1);
}

console.error(`[codegraph] Running ${nativeRequiredSuites.length} native-required JS test suites.`);
// Native is proven available above, so suites gated on it must run rather than
// self-skip: a skipped parity case reads as coverage while asserting nothing.
process.exit(run("npx", ["vitest", "run", ...nativeRequiredSuites], { CODEGRAPH_NATIVE_REQUIRED: "1" }));
