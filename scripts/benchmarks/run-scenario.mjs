#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertComplete,
  parseArguments,
  repositoryRoot,
  runBenchmark,
  serializeBenchmarkResult,
  writeBenchmarkResult,
} from "./run-scenario-lib.mjs";

export async function main(argv = process.argv.slice(2), runtime = {}) {
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const rootDir = runtime.rootDir ?? repositoryRoot;
  try {
    const options = parseArguments(argv);
    const result = await runBenchmark(options, { rootDir });
    let serialized;
    if (options.output) {
      serialized = writeBenchmarkResult(options.output, result, { rootDir });
    } else {
      serialized = serializeBenchmarkResult(result);
    }
    if (options.json || !options.output) stdout.write(serialized);
    if (options.requireComplete) assertComplete(result);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`Benchmark error: ${message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main();
