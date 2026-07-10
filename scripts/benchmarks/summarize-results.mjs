#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./summarize-results-lib.mjs";

export function main(argv = process.argv.slice(2), runtime = {}) {
  const stderr = runtime.stderr ?? process.stderr;
  try {
    runCli(argv, { stdout: runtime.stdout ?? process.stdout });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main();
