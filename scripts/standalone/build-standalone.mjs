#!/usr/bin/env node
import path from "node:path";
import { assembleStandaloneArchive, resolveStandaloneTarget } from "./standalone-lib.mjs";

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
    options.set(token, value);
    index += 1;
  }
  return options;
}

const args = parseArgs(process.argv.slice(2));
const target = args.get("--target") ?? resolveStandaloneTarget();
if (!target) throw new Error(`No standalone target exists for ${process.platform}/${process.arch}.`);
const sourceRoot = path.resolve(args.get("--source-root") ?? process.cwd());
const result = await assembleStandaloneArchive({
  target,
  packageRoot: path.resolve(args.get("--package-root") ?? sourceRoot),
  outputDir: path.resolve(args.get("--output") ?? path.join(sourceRoot, "temp", "standalone")),
  nodeExecutable: path.resolve(args.get("--node") ?? process.execPath),
  noticesPath: path.resolve(args.get("--notices") ?? path.join(sourceRoot, "THIRD_PARTY_NOTICES")),
  sourceRoot,
  ...(args.get("--version") ? { version: args.get("--version") } : {}),
  ...(args.get("--source-revision") ? { sourceRevision: args.get("--source-revision") } : {}),
  allowCrossTarget: args.get("--allow-cross-target") === "true",
});
console.log(
  JSON.stringify(
    {
      target: result.target,
      version: result.manifest.version,
      archivePath: result.archivePath,
      archiveSha256: result.archiveSha256,
      fileCount: result.manifest.files.length,
    },
    null,
    2,
  ),
);
