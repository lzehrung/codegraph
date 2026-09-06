import fs from "node:fs";
import path from "node:path";
import { bumpVersion, finalizeChangelogForRelease, validReleaseTypes } from "./release-lib.mjs";

const [releaseType] = process.argv.slice(2);
if (!validReleaseTypes.has(releaseType)) {
  throw new Error("Usage: npm run release:prepare-changelog -- <patch|minor|major>");
}

const rootPath = process.cwd();
const packagePath = path.join(rootPath, "package.json");
const changelogPath = path.join(rootPath, "CHANGELOG.md");
const rootPackage = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const version = bumpVersion(rootPackage.version, releaseType);
const date = new Date().toISOString().slice(0, 10);

fs.writeFileSync(changelogPath, finalizeChangelogForRelease(fs.readFileSync(changelogPath, "utf8"), version, date));
console.log(`Prepared CHANGELOG.md for ${version}.`);
