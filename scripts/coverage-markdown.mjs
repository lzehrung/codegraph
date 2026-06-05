#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { writeCoverageMarkdownReports } from "./coverage-markdown-lib.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const mode = process.argv[2] ?? "all";

try {
  const writtenPaths = writeCoverageMarkdownReports({ rootDir, mode });
  for (const filePath of writtenPaths) {
    console.log(filePath);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
