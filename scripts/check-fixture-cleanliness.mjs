#!/usr/bin/env node

import path from "node:path";
import { inspectFixtureCleanliness } from "./fixture-cleanliness-lib.mjs";

function parseArgs(args) {
  let repoRoot = process.cwd();
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--root") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new Error("--root requires a directory");
      repoRoot = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { repoRoot, json };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const result = await inspectFixtureCleanliness(options);
  const report = {
    schemaVersion: 1,
    status: result.ok ? "pass" : "fail",
    fixtureRoots: result.fixtureRoots,
    violations: result.violations,
  };
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (result.ok) {
    console.log(`Fixture cleanliness check passed for ${result.fixtureRoots.join(", ")}.`);
  } else {
    console.error(`Fixture cleanliness check failed with ${result.violations.length} violation(s):`);
    for (const violation of result.violations) {
      console.error(`- [${violation.code}] ${violation.message}`);
    }
  }
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
