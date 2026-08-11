import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import childProcess from "node:child_process";
import { nativeTargetSuffixForPlatform } from "./platform.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

function isMusl() {
  if (process.platform !== "linux") return false;
  const report = process.report?.getReport();
  if (report?.header?.glibcVersionRuntime) return false;
  try {
    return childProcess.execSync("ldd --version", { encoding: "utf8" }).toLowerCase().includes("musl");
  } catch {
    return true;
  }
}

function platformPackageSuffix() {
  const linuxAbi = isMusl() ? "musl" : "gnu";
  return nativeTargetSuffixForPlatform(process.platform, process.arch, linuxAbi);
}

function findLocalNativeBinary() {
  const suffix = platformPackageSuffix();
  if (!suffix) return null;
  const expectedName = `index.${suffix}.node`;
  const files = fs.readdirSync(__dirname);
  const binary = files.find((file) => file === expectedName);
  return binary ? path.join(__dirname, binary) : null;
}

function loadBinding() {
  const localBinary = findLocalNativeBinary();
  if (localBinary) return require(localBinary);

  const suffix = platformPackageSuffix();
  if (suffix) {
    try {
      return require(`@lzehrung/codegraph-native-${suffix}`);
    } catch {
      // Fall through to the final error below.
    }
  }

  throw new Error(
    "Codegraph native addon is unavailable for this platform. Build it locally with `npm run build:native` or install a published native package for this target.",
  );
}

const binding = loadBinding();

export const parseSyntaxTree = binding.parseSyntaxTree;
export const extractLanguage = binding.extractLanguage;
export const runImportsQueryCompact = binding.runImportsQueryCompact;
export const runLanguageQueries = binding.runLanguageQueries;
export const runQuery = binding.runQuery;
export const tokenizeDuplicateSource = binding.tokenizeDuplicateSource;
export const supportedLanguageIds = binding.supportedLanguageIds;
export default binding;
