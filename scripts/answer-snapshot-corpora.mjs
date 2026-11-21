#!/usr/bin/env node
import { runAnswerSnapshots } from "./answer-snapshot-lib.mjs";

try {
  await runAnswerSnapshots(process.argv.slice(2), true);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
