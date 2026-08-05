import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "docs", "graph-visualization", "vendor");
fs.mkdirSync(outDir, { recursive: true });

function run(args) {
  const result = spawnSync("npx", ["esbuild", ...args], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run([
  "node_modules/graphology/dist/graphology.esm.js",
  "--bundle",
  "--format=esm",
  "--platform=browser",
  `--outfile=${path.join(outDir, "graphology.js")}`,
]);
run([
  "node_modules/graphology-layout-forceatlas2/index.js",
  "--bundle",
  "--format=esm",
  "--platform=browser",
  "--alias:graphology=./graphology.js",
  `--outfile=${path.join(outDir, "graphology-layout-forceatlas2.js")}`,
]);
run([
  "node_modules/sigma/dist/sigma.esm.js",
  "--bundle",
  "--format=esm",
  "--platform=browser",
  `--outfile=${path.join(outDir, "sigma.js")}`,
]);

console.log("Vendored graph viewer libraries into", outDir);
