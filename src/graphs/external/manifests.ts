import fs from "node:fs";
import path from "node:path";

export type DependencyManifest = {
  declaredPackages: Set<string>;
  hasManifest: boolean;
};

export function directoryExists(directory: string): boolean {
  if (!fs.existsSync(directory)) return false;
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

export function pathExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function readText(filePath: string): string | null {
  if (!pathExists(filePath)) return null;
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  const raw = readText(filePath);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value).filter(([, entry]) => typeof entry === "string");
  return Object.fromEntries(entries) as Record<string, string>;
}

function addPackageWithSeparators(packageName: string, declaredPackages: Set<string>): void {
  const trimmed = packageName.trim();
  if (!trimmed) return;
  declaredPackages.add(trimmed);
  declaredPackages.add(trimmed.replace(/-/g, "_"));
}

function addPackageJsonDependencies(filePath: string, declaredPackages: Set<string>): boolean {
  const parsed = readJsonObject(filePath);
  if (!parsed) return false;
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
    for (const packageName of Object.keys(readStringRecord(parsed[field]))) {
      declaredPackages.add(packageName);
    }
  }
  return true;
}

function addComposerDependencies(filePath: string, declaredPackages: Set<string>): boolean {
  const parsed = readJsonObject(filePath);
  if (!parsed) return false;
  for (const field of ["require", "require-dev"] as const) {
    for (const packageName of Object.keys(readStringRecord(parsed[field]))) {
      if (packageName !== "php" && !packageName.startsWith("ext-")) {
        declaredPackages.add(packageName);
      }
    }
  }
  return true;
}

function addPythonPackageName(rawName: string, declaredPackages: Set<string>): void {
  const normalizedName = rawName.trim().split("[")[0]?.toLowerCase();
  if (!normalizedName || normalizedName === "python") return;
  addPackageWithSeparators(normalizedName, declaredPackages);
}

function addRequirementsDependencies(filePath: string, declaredPackages: Set<string>): boolean {
  const raw = readText(filePath);
  if (raw === null) return false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
    const dependency = trimmed.match(/^([A-Za-z0-9_.-]+)/);
    if (dependency?.[1]) {
      addPythonPackageName(dependency[1], declaredPackages);
    }
  }
  return true;
}

function addSetupCfgDependencies(filePath: string, declaredPackages: Set<string>): boolean {
  const raw = readText(filePath);
  if (raw === null) return false;
  let inInstallRequires = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^\[/.test(trimmed)) {
      inInstallRequires = false;
      continue;
    }
    if (/^install_requires\s*=/.test(trimmed)) {
      inInstallRequires = true;
      const inlineValue = trimmed.split("=").slice(1).join("=").trim();
      if (inlineValue) {
        const packageName = inlineValue.match(/^([A-Za-z0-9_.-]+)/)?.[1];
        if (packageName) addPythonPackageName(packageName, declaredPackages);
      }
      continue;
    }
    if (inInstallRequires) {
      const packageName = trimmed.match(/^([A-Za-z0-9_.-]+)/)?.[1];
      if (packageName) addPythonPackageName(packageName, declaredPackages);
    }
  }
  return true;
}

function addPipfileDependencies(filePath: string, declaredPackages: Set<string>): boolean {
  const raw = readText(filePath);
  if (raw === null) return false;
  let inPackageSection = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const section = trimmed.match(/^\[([^\]]+)\]$/);
    if (section) {
      inPackageSection = ["packages", "dev-packages"].includes(section[1] ?? "");
      continue;
    }
    if (!inPackageSection) continue;
    const dependency = trimmed.match(/^["']?([A-Za-z0-9_.-]+)["']?\s*=/);
    if (dependency?.[1]) {
      addPythonPackageName(dependency[1], declaredPackages);
    }
  }
  return true;
}

function addPyprojectDependencies(filePath: string, declaredPackages: Set<string>): boolean {
  const raw = readText(filePath);
  if (raw === null) return false;
  const dependencyArrays = raw.matchAll(/(?:^|\n)\s*[A-Za-z0-9_-]*dependencies\s*=\s*\[([\s\S]*?)\]/g);
  for (const dependencyArray of dependencyArrays) {
    for (const dependency of (dependencyArray[1] ?? "").matchAll(/["']([^"']+)["']/g)) {
      const packageName = dependency[1]?.match(/^([A-Za-z0-9_.-]+)/)?.[1];
      if (packageName) {
        addPythonPackageName(packageName, declaredPackages);
      }
    }
  }

  let inPoetryDependencySection = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    const section = trimmed.match(/^\[([^\]]+)\]$/);
    if (section) {
      inPoetryDependencySection =
        section[1] === "tool.poetry.dependencies" ||
        /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section[1] ?? "");
      continue;
    }
    if (!inPoetryDependencySection || !trimmed || trimmed.startsWith("#")) continue;
    const dependency = trimmed.match(/^["']?([A-Za-z0-9_.-]+)["']?\s*=/);
    if (dependency?.[1]) {
      addPythonPackageName(dependency[1], declaredPackages);
    }
  }
  return true;
}

function addCargoDependencies(filePath: string, declaredPackages: Set<string>): boolean {
  const raw = readText(filePath);
  if (raw === null) return false;
  let inDependencySection = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const section = trimmed.match(/^\[([^\]]+)\]$/);
    if (section) {
      inDependencySection = /(^|\.)(dependencies|dev-dependencies|build-dependencies)$/.test(section[1] ?? "");
      continue;
    }
    if (!inDependencySection) continue;
    const dependency = trimmed.match(/^([A-Za-z0-9_-]+)\s*=/);
    if (dependency?.[1]) {
      addPackageWithSeparators(dependency[1], declaredPackages);
    }
  }
  return true;
}

function addGoDependencies(filePath: string, declaredPackages: Set<string>): boolean {
  const raw = readText(filePath);
  if (raw === null) return false;
  let inRequireBlock = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    if (trimmed === "require (") {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock) {
      if (trimmed === ")") {
        inRequireBlock = false;
        continue;
      }
      const blockRequireMatch = trimmed.match(/^([^\s]+)\s+/);
      if (blockRequireMatch?.[1]) declaredPackages.add(blockRequireMatch[1]);
      continue;
    }
    const requireMatch = trimmed.match(/^require\s+([^\s]+)\s+/);
    if (requireMatch?.[1]) declaredPackages.add(requireMatch[1]);
    const moduleMatch = trimmed.match(/^module\s+([^\s]+)/);
    if (moduleMatch?.[1]) declaredPackages.add(moduleMatch[1]);
  }
  return true;
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function addZigDependencies(filePath: string, declaredPackages: Set<string>): boolean {
  const raw = readText(filePath);
  if (raw === null) return false;
  let inDependencySection = false;
  let dependencyDepth = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!inDependencySection && trimmed.startsWith(".dependencies") && trimmed.includes(".{")) {
      inDependencySection = true;
      dependencyDepth = countMatches(trimmed, /\{/g) - countMatches(trimmed, /\}/g);
      continue;
    }
    if (!inDependencySection) continue;
    if (dependencyDepth === 1) {
      const dependency = trimmed.match(/^\.((?:[A-Za-z0-9_]+)|(?:"[^"]+"))\s*=/);
      if (dependency?.[1]) declaredPackages.add(dependency[1].replace(/^"|"$/g, ""));
    }
    dependencyDepth += countMatches(trimmed, /\{/g) - countMatches(trimmed, /\}/g);
    if (dependencyDepth <= 0) {
      inDependencySection = false;
    }
  }
  return true;
}

function addGemfileDependencies(filePath: string, declaredPackages: Set<string>): boolean {
  const raw = readText(filePath);
  if (raw === null) return false;
  for (const line of raw.split(/\r?\n/)) {
    const dependency = line.match(/^\s*gem\s+["']([^"']+)["']/);
    if (dependency?.[1]) {
      declaredPackages.add(dependency[1]);
    }
  }
  return true;
}

function addGemspecDependencies(filePath: string, declaredPackages: Set<string>): boolean {
  const raw = readText(filePath);
  if (raw === null) return false;
  for (const dependency of raw.matchAll(/add(?:_runtime)?_dependency|add_development_dependency/g)) {
    if (dependency.index === undefined) continue;
    const afterMatch = raw.slice(dependency.index);
    const packageName = afterMatch.match(/["']([^"']+)["']/)?.[1];
    if (packageName) declaredPackages.add(packageName);
  }
  return true;
}

function addMavenDependencies(filePath: string, declaredPackages: Set<string>): boolean {
  const raw = readText(filePath);
  if (raw === null) return false;
  for (const dependencyBlock of raw.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const groupId = dependencyBlock[1]?.match(/<groupId>\s*([^<\s]+)\s*<\/groupId>/)?.[1];
    const artifactId = dependencyBlock[1]?.match(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/)?.[1];
    if (groupId) declaredPackages.add(groupId);
    if (groupId && artifactId) declaredPackages.add(`${groupId}.${artifactId}`);
    if (artifactId) declaredPackages.add(artifactId);
  }
  return true;
}

function addGradleDependencies(filePath: string, declaredPackages: Set<string>): boolean {
  const raw = readText(filePath);
  if (raw === null) return false;
  for (const dependency of raw.matchAll(/["']([^:"']+):([^:"']+):[^"']+["']/g)) {
    const groupId = dependency[1];
    const artifactId = dependency[2];
    if (groupId) declaredPackages.add(groupId);
    if (groupId && artifactId) declaredPackages.add(`${groupId}.${artifactId}`);
    if (artifactId) declaredPackages.add(artifactId);
  }
  return true;
}

function addDotnetDependencies(filePath: string, declaredPackages: Set<string>): boolean {
  const raw = readText(filePath);
  if (raw === null) return false;
  for (const dependency of raw.matchAll(/<PackageReference\b[^>]*\bInclude=["']([^"']+)["']/g)) {
    if (dependency[1]) declaredPackages.add(dependency[1]);
  }
  return true;
}

function addVcpkgDependencies(filePath: string, declaredPackages: Set<string>): boolean {
  const parsed = readJsonObject(filePath);
  if (!parsed) return false;
  const dependencies = parsed.dependencies;
  if (!Array.isArray(dependencies)) return true;
  for (const dependency of dependencies) {
    if (typeof dependency === "string") {
      declaredPackages.add(dependency);
    } else if (
      dependency &&
      typeof dependency === "object" &&
      !Array.isArray(dependency) &&
      typeof dependency.name === "string"
    ) {
      declaredPackages.add(dependency.name);
    }
  }
  return true;
}

function addSwiftPackageDependencies(filePath: string, declaredPackages: Set<string>): boolean {
  const raw = readText(filePath);
  if (raw === null) return false;
  for (const dependency of raw.matchAll(/\.package\s*\([^)]*\bname:\s*"([^"]+)"/g)) {
    if (dependency[1]) declaredPackages.add(dependency[1]);
  }
  for (const product of raw.matchAll(/\.product\s*\([^)]*\bname:\s*"([^"]+)"/g)) {
    if (product[1]) declaredPackages.add(product[1]);
  }
  return true;
}

function addGemspecs(directory: string, declaredPackages: Set<string>): boolean {
  if (!directoryExists(directory)) return false;
  let found = false;
  try {
    for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!dirent.isFile() || !dirent.name.endsWith(".gemspec")) continue;
      found = addGemspecDependencies(path.join(directory, dirent.name), declaredPackages) || found;
    }
  } catch {
    return false;
  }
  return found;
}

function addDotnetProjectFiles(directory: string, declaredPackages: Set<string>): boolean {
  if (!directoryExists(directory)) return false;
  let found = false;
  try {
    for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!dirent.isFile() || !/\.(?:csproj|fsproj|vbproj)$/i.test(dirent.name)) continue;
      found = addDotnetDependencies(path.join(directory, dirent.name), declaredPackages) || found;
    }
  } catch {
    return false;
  }
  return found;
}

export function createDependencyManifestForDirectory(directory: string): DependencyManifest {
  const resolvedRoot = path.resolve(directory);
  const declaredPackages = new Set<string>();
  let hasManifest = false;
  hasManifest = addPackageJsonDependencies(path.join(resolvedRoot, "package.json"), declaredPackages) || hasManifest;
  hasManifest =
    addRequirementsDependencies(path.join(resolvedRoot, "requirements.txt"), declaredPackages) || hasManifest;
  hasManifest =
    addRequirementsDependencies(path.join(resolvedRoot, "requirements.in"), declaredPackages) || hasManifest;
  hasManifest = addPyprojectDependencies(path.join(resolvedRoot, "pyproject.toml"), declaredPackages) || hasManifest;
  hasManifest = addSetupCfgDependencies(path.join(resolvedRoot, "setup.cfg"), declaredPackages) || hasManifest;
  hasManifest = addPipfileDependencies(path.join(resolvedRoot, "Pipfile"), declaredPackages) || hasManifest;
  hasManifest = addComposerDependencies(path.join(resolvedRoot, "composer.json"), declaredPackages) || hasManifest;
  hasManifest = addCargoDependencies(path.join(resolvedRoot, "Cargo.toml"), declaredPackages) || hasManifest;
  hasManifest = addGoDependencies(path.join(resolvedRoot, "go.mod"), declaredPackages) || hasManifest;
  hasManifest = addZigDependencies(path.join(resolvedRoot, "build.zig.zon"), declaredPackages) || hasManifest;
  hasManifest = addGemfileDependencies(path.join(resolvedRoot, "Gemfile"), declaredPackages) || hasManifest;
  hasManifest = addGemspecs(resolvedRoot, declaredPackages) || hasManifest;
  hasManifest = addMavenDependencies(path.join(resolvedRoot, "pom.xml"), declaredPackages) || hasManifest;
  hasManifest = addGradleDependencies(path.join(resolvedRoot, "build.gradle"), declaredPackages) || hasManifest;
  hasManifest = addGradleDependencies(path.join(resolvedRoot, "build.gradle.kts"), declaredPackages) || hasManifest;
  hasManifest = addDotnetProjectFiles(resolvedRoot, declaredPackages) || hasManifest;
  hasManifest = addVcpkgDependencies(path.join(resolvedRoot, "vcpkg.json"), declaredPackages) || hasManifest;
  hasManifest = addSwiftPackageDependencies(path.join(resolvedRoot, "Package.swift"), declaredPackages) || hasManifest;

  return { declaredPackages, hasManifest };
}
