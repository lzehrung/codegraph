import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { patchTreeSitterBindingGypSource } from "./patch-tree-sitter-node24-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bindingPath = path.join(
  repoRoot,
  "packages",
  "codegraph-js-fallback",
  "node_modules",
  "tree-sitter",
  "binding.gyp",
);

if (!existsSync(bindingPath)) {
  console.error(`tree-sitter binding.gyp was not found at ${bindingPath}`);
  process.exit(1);
}

const original = readFileSync(bindingPath, "utf8");
const result = patchTreeSitterBindingGypSource(original);

if (!result.changed) {
  console.log("[codegraph] tree-sitter binding.gyp already selects the C++ standard dynamically.");
  process.exit(0);
}

writeFileSync(bindingPath, result.source);
console.log("[codegraph] Patched tree-sitter binding.gyp for Node 24 C++20 builds.");
