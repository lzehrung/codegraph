import fs from "node:fs";
import path from "node:path";
import { bumpVersion, finalizeChangelogForRelease, validReleaseTypes } from "./release-lib.mjs";

const [releaseType, ...args] = process.argv.slice(2);
if (!validReleaseTypes.has(releaseType) || (args.length && (args.length !== 2 || args[0] !== "--output" || !args[1]))) {
  throw new Error("Usage: npm run release:prepare-changelog -- <patch|minor|major> [--output <path>]");
}

const rootPath = process.cwd();
const packagePath = path.join(rootPath, "package.json");
const changelogPath = path.join(rootPath, "CHANGELOG.md");
const rootPackage = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const version = bumpVersion(rootPackage.version, releaseType);
const date = new Date().toISOString().slice(0, 10);

const outputPath = args.length ? path.resolve(args[1]) : changelogPath;
const changelog = finalizeChangelogForRelease(fs.readFileSync(changelogPath, "utf8"), version, date);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, changelog);
console.log(`Prepared ${path.relative(rootPath, outputPath)} for ${version}.`);
