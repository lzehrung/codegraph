import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bindingPath = path.join(
  repoRoot,
  "packages",
  "codegraph-js-fallback",
  "node_modules",
  "tree-sitter",
  "binding.gyp",
);

function replaceOnce(source, search, replacement) {
  if (!source.includes(search)) {
    throw new Error(`Expected tree-sitter binding.gyp fragment was not found: ${search}`);
  }

  return source.replace(search, replacement);
}

if (!existsSync(bindingPath)) {
  console.error(`tree-sitter binding.gyp was not found at ${bindingPath}`);
  process.exit(1);
}

const original = readFileSync(bindingPath, "utf8");

if (original.includes('"cxxstd%"')) {
  console.log("[codegraph] tree-sitter binding.gyp already selects the C++ standard dynamically.");
  process.exit(0);
}

let patched = original;

patched = replaceOnce(
  patched,
  `      "cflags_cc": [
        "-std=c++17"
      ],
`,
  "",
);

patched = replaceOnce(patched, `"CLANG_CXX_LANGUAGE_STANDARD": "c++17"`, `"CLANG_CXX_LANGUAGE_STANDARD": "<(cxxstd)"`);

patched = replaceOnce(patched, `"/std:c++17"`, `"/std:<(cxxstd)"`);

patched = replaceOnce(
  patched,
  `          "cflags_cc": [
            "-Wno-cast-function-type"
          ]
`,
  `          "cflags_cc": [
            "-std=<(cxxstd)",
            "-fvisibility=hidden",
            "-Wno-cast-function-type",
          ]
`,
);

patched = replaceOnce(
  patched,
  `    "v8_enable_31bit_smis_on_64bit_arch%": 0,
`,
  `    "v8_enable_31bit_smis_on_64bit_arch%": 0,
    "cxxstd%": "<!(node -p \\"parseInt(process.env.npm_config_target ?? process.versions.node) < 22 ? 'c++17' : 'c++20'\\")",
`,
);

writeFileSync(bindingPath, patched);
console.log("[codegraph] Patched tree-sitter binding.gyp for Node 24 C++20 builds.");
