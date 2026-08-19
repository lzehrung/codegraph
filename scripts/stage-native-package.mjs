import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nativeTargetSuffixForPlatform } from "../packages/codegraph-native/platform.js";

const rootDir = process.cwd();
const nativeRoot = path.join(rootDir, "packages", "codegraph-native");
const shouldSkipExistingTarget = process.argv.includes("--if-missing");

function isMusl() {
  if (process.platform !== "linux") return false;
  const report = process.report?.getReport();
  if (report?.header?.glibcVersionRuntime) return false;
  return true;
}

function currentTargetSuffix() {
  const linuxAbi = isMusl() ? "musl" : "gnu";
  return nativeTargetSuffixForPlatform(process.platform, process.arch, linuxAbi);
}

function sha256Of(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

const suffix = currentTargetSuffix();
if (!suffix) {
  console.error(`Unsupported platform for local native staging: ${process.platform}/${process.arch}`);
  process.exit(1);
}

const targetDir = path.join(nativeRoot, "npm", suffix);
if (!fs.existsSync(targetDir)) {
  console.error(`Target package directory not found: ${targetDir}. Run \`npm run native:create-npm-dirs\` first.`);
  process.exit(1);
}

const targetFile = path.join(targetDir, `index.${suffix}.node`);
const sourceFile = path.join(nativeRoot, `index.${suffix}.node`);

if (shouldSkipExistingTarget && fs.existsSync(targetFile)) {
  if (!fs.existsSync(sourceFile)) {
    console.log(`Keeping existing staged native artifact (no fresh build to compare against): ${targetFile}`);
    process.exit(0);
  }
  if (sha256Of(targetFile) === sha256Of(sourceFile)) {
    console.log(`Keeping existing staged native artifact (matches freshly built bytes): ${targetFile}`);
    process.exit(0);
  }
  console.log(`Replacing stale staged native artifact with freshly built bytes: ${targetFile}`);
}

if (!fs.existsSync(sourceFile)) {
  console.error(`Built native binary not found: ${sourceFile}`);
  process.exit(1);
}

fs.copyFileSync(sourceFile, targetFile);
