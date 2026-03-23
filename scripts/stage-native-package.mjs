import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const nativeRoot = path.join(rootDir, "packages", "codegraph-native");

function isMusl() {
  if (process.platform !== "linux") return false;
  const report = process.report?.getReport();
  if (report?.header?.glibcVersionRuntime) return false;
  return true;
}

function currentTargetSuffix() {
  const { platform, arch } = process;
  if (platform === "win32") {
    if (arch === "x64") return "win32-x64-msvc";
    if (arch === "arm64") return "win32-arm64-msvc";
  }
  if (platform === "darwin") {
    if (arch === "x64") return "darwin-x64";
    if (arch === "arm64") return "darwin-arm64";
  }
  if (platform === "linux") {
    const abi = isMusl() ? "musl" : "gnu";
    if (arch === "x64") return `linux-x64-${abi}`;
    if (arch === "arm64") return `linux-arm64-${abi}`;
  }
  return null;
}

const suffix = currentTargetSuffix();
if (!suffix) {
  console.error(`Unsupported platform for local native staging: ${process.platform}/${process.arch}`);
  process.exit(1);
}

const sourceFile = path.join(nativeRoot, `index.${suffix}.node`);
if (!fs.existsSync(sourceFile)) {
  console.error(`Built native binary not found: ${sourceFile}`);
  process.exit(1);
}

const targetDir = path.join(nativeRoot, "npm", suffix);
if (!fs.existsSync(targetDir)) {
  console.error(
    `Target package directory not found: ${targetDir}. Run \`npm run native:create-npm-dirs\` first.`,
  );
  process.exit(1);
}

const targetFile = path.join(targetDir, `index.${suffix}.node`);
fs.copyFileSync(sourceFile, targetFile);
