import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const nativeRoot = path.join(rootDir, "packages", "codegraph-native");
const nativePackagePath = path.join(nativeRoot, "package.json");
const npmDir = path.join(nativeRoot, "npm");

const nativePackage = JSON.parse(fs.readFileSync(nativePackagePath, "utf8"));
const optionalDependencies = {};

if (fs.existsSync(npmDir)) {
  const targetDirs = fs.readdirSync(npmDir, { withFileTypes: true });
  for (const dirent of targetDirs) {
    if (!dirent.isDirectory()) continue;
    const packagePath = path.join(npmDir, dirent.name, "package.json");
    if (!fs.existsSync(packagePath)) continue;
    const targetPackage = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    const mainFile = typeof targetPackage.main === "string" ? path.join(npmDir, dirent.name, targetPackage.main) : null;
    if (!mainFile || !fs.existsSync(mainFile)) continue;
    optionalDependencies[targetPackage.name] = nativePackage.version;
  }
}

nativePackage.optionalDependencies = optionalDependencies;
fs.writeFileSync(nativePackagePath, `${JSON.stringify(nativePackage, null, 2)}\n`);
