import path from "node:path";
import { fileURLToPath } from "node:url";
import { runEnsureDistForTests } from "./ensure-dist-for-tests-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.exitCode = runEnsureDistForTests(rootDir);
