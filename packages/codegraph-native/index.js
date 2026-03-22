import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import childProcess from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

function isMusl() {
  if (process.platform !== "linux") return false;
  const report = process.report?.getReport();
  if (report?.header?.glibcVersionRuntime) return false;
  try {
    return childProcess
      .execSync("ldd --version", { encoding: "utf8" })
      .toLowerCase()
      .includes("musl");
  } catch {
    return true;
  }
}

function platformPackageSuffix() {
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

function findLocalNativeBinary() {
  const files = fs.readdirSync(__dirname);
  const binary = files.find((file) => file.endsWith(".node"));
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

export const runLanguageQueries = binding.runLanguageQueries;
export const supportedLanguageIds = binding.supportedLanguageIds;
export default binding;
