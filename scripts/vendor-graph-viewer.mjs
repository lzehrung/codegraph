import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "docs", "graph-visualization", "vendor");
const esbuildBin = path.join(
  root,
  "node_modules",
  "esbuild",
  "bin",
  process.platform === "win32" ? "esbuild.exe" : "esbuild",
);
const esbuildCli = path.join(root, "node_modules", "esbuild", "bin", "esbuild");

fs.mkdirSync(outDir, { recursive: true });

function resolveEsbuildEntry() {
  if (fs.existsSync(esbuildBin)) return { command: esbuildBin, prefixArgs: [] };
  if (fs.existsSync(esbuildCli)) return { command: process.execPath, prefixArgs: [esbuildCli] };
  throw new Error(
    "Local esbuild is missing. Run npm install so the viewer:vendor script can use the repo's esbuild devDependency.",
  );
}

function run(args) {
  const { command, prefixArgs } = resolveEsbuildEntry();
  const result = spawnSync(command, [...prefixArgs, ...args], {
    cwd: root,
    stdio: "inherit",
    shell: false,
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
