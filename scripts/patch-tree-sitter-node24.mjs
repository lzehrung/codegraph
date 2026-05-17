import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { patchTreeSitterBindingGypSource, resolveTreeSitterBindingGypPath } from "./patch-tree-sitter-node24-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bindingPath = resolveTreeSitterBindingGypPath({ repoRoot });

if (!bindingPath) {
  console.log("[codegraph] tree-sitter binding.gyp was not found; skipping Node 24 patch.");
  process.exit(0);
}

const original = readFileSync(bindingPath, "utf8");
const result = patchTreeSitterBindingGypSource(original);

if (!result.changed) {
  console.log("[codegraph] tree-sitter binding.gyp already selects the C++ standard dynamically.");
  process.exit(0);
}

writeFileSync(bindingPath, result.source);
console.log("[codegraph] Patched tree-sitter binding.gyp for Node 24 C++20 builds.");
