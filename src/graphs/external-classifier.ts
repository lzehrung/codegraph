import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";

export type ExternalResolutionStatus = "declared-package" | "stdlib" | "url" | "unresolved";

export type ExternalSpecifierClassification = {
  status: ExternalResolutionStatus;
  packageName?: string;
};

export type ExternalSpecifierClassificationOptions = {
  projectRoot?: string;
};

type DependencyManifest = {
  declaredPackages: Set<string>;
  hasManifest: boolean;
};

type ExternalClassifierCacheStats = {
  dependencyManifests: number;
  declaredPackageContexts: number;
};

const MAX_EXTERNAL_CLASSIFIER_CACHE_ENTRIES = 512;
const MAX_MANIFEST_ANCESTOR_SEARCH_DEPTH = 64;

class BoundedCacheMap<K, V> extends Map<K, V> {
  constructor(private readonly maxEntries: number) {
    super();
  }

  override set(key: K, value: V): this {
    if (super.has(key)) {
      super.delete(key);
    }
    super.set(key, value);
    while (this.size > this.maxEntries) {
      const oldest = this.keys().next();
      if (oldest.done) break;
      super.delete(oldest.value);
    }
    return this;
  }
}

const NODE_BUILTIN_MODULES = new Set<string>([
  ...builtinModules,
  ...builtinModules.filter((name) => !name.startsWith("node:")).map((name) => `node:${name}`),
]);

const PYTHON_STDLIB_MODULES = new Set([
  "__future__",
  "abc",
  "argparse",
  "asyncio",
  "collections",
  "contextlib",
  "dataclasses",
  "datetime",
  "decimal",
  "functools",
  "itertools",
  "json",
  "logging",
  "math",
  "os",
  "pathlib",
  "re",
  "shutil",
  "sqlite3",
  "statistics",
  "string",
  "subprocess",
  "sys",
  "tempfile",
  "time",
  "typing",
  "unittest",
  "urllib",
]);

const RUBY_STDLIB_MODULES = new Set([
  "date",
  "digest",
  "fileutils",
  "json",
  "logger",
  "pathname",
  "set",
  "time",
  "uri",
  "yaml",
]);

const GO_STDLIB_IMPORTS = new Set([
  "bufio",
  "bytes",
  "context",
  "crypto",
  "database",
  "encoding",
  "errors",
  "fmt",
  "io",
  "log",
  "math",
  "net",
  "net/http",
  "os",
  "path",
  "path/filepath",
  "reflect",
  "regexp",
  "sort",
  "strconv",
  "strings",
  "sync",
  "testing",
  "time",
]);

const CPP_STDLIB_HEADERS = new Set([
  "algorithm",
  "array",
  "chrono",
  "cstdint",
  "cstdio",
  "cstdlib",
  "exception",
  "filesystem",
  "fstream",
  "functional",
  "iostream",
  "map",
  "memory",
  "optional",
  "set",
  "sstream",
  "stdexcept",
  "string",
  "string_view",
  "tuple",
  "type_traits",
  "unordered_map",
  "unordered_set",
  "utility",
  "vector",
]);

const C_STDLIB_HEADERS = new Set([
  "assert.h",
  "ctype.h",
  "errno.h",
  "float.h",
  "limits.h",
  "math.h",
  "setjmp.h",
  "signal.h",
  "stdarg.h",
  "stdbool.h",
  "stddef.h",
  "stdint.h",
  "stdio.h",
  "stdlib.h",
  "string.h",
  "time.h",
]);

const SWIFT_SDK_MODULES = new Set(["Foundation", "Dispatch", "Darwin", "Glibc", "SwiftUI", "UIKit"]);

const dependencyManifestCache = new BoundedCacheMap<string, DependencyManifest>(MAX_EXTERNAL_CLASSIFIER_CACHE_ENTRIES);
const declaredPackagesByContextCache = new BoundedCacheMap<string, Set<string>>(MAX_EXTERNAL_CLASSIFIER_CACHE_ENTRIES);

export function resetExternalClassifierCaches(): void {
  dependencyManifestCache.clear();
  declaredPackagesByContextCache.clear();
}

export function getExternalClassifierCacheStats(): ExternalClassifierCacheStats {
  return {
    dependencyManifests: dependencyManifestCache.size,
    declaredPackageContexts: declaredPackagesByContextCache.size,
  };
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function directoryExists(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function readText(filePath: string): string | null {
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
    const parsed = JSON.parse(raw) as unknown;
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

function dependencyManifestForDirectory(directory: string): DependencyManifest {
  const resolvedRoot = path.resolve(directory);
  const cached = dependencyManifestCache.get(resolvedRoot);
  if (cached) return cached;

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

  const manifest = { declaredPackages, hasManifest };
  dependencyManifestCache.set(resolvedRoot, manifest);
  return manifest;
}

function parentDirectory(directory: string): string | null {
  const parent = path.dirname(directory);
  return parent === directory ? null : parent;
}

function nearestVcsAncestor(startDirectory: string): string | null {
  let current: string | null = path.resolve(startDirectory);
  while (current) {
    if (directoryExists(path.join(current, ".git"))) return current;
    current = parentDirectory(current);
  }
  return null;
}

function nearestManifestAncestor(startDirectory: string, stopDirectory: string | null): string | null {
  let depth = 0;
  let current: string | null = path.resolve(startDirectory);
  const resolvedStop = stopDirectory ? path.resolve(stopDirectory) : null;
  while (current && depth <= MAX_MANIFEST_ANCESTOR_SEARCH_DEPTH) {
    if (dependencyManifestForDirectory(current).hasManifest) return current;
    if (resolvedStop && current === resolvedStop) break;
    current = parentDirectory(current);
    depth += 1;
  }
  return null;
}

function isSameOrInside(directory: string, possibleAncestor: string): boolean {
  const relative = path.relative(possibleAncestor, directory);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function declaredPackagesFromAncestors(startDirectory: string, stopDirectory: string): Set<string> {
  const resolvedStart = path.resolve(startDirectory);
  const resolvedStop = path.resolve(stopDirectory);
  const cacheKey = `${resolvedStart}\0${resolvedStop}`;
  const cached = declaredPackagesByContextCache.get(cacheKey);
  if (cached) return cached;

  const declaredPackages = new Set<string>();
  let current: string | null = resolvedStart;
  while (current && isSameOrInside(current, resolvedStop)) {
    for (const packageName of dependencyManifestForDirectory(current).declaredPackages) {
      declaredPackages.add(packageName);
    }
    if (current === resolvedStop) break;
    current = parentDirectory(current);
  }

  declaredPackagesByContextCache.set(cacheKey, declaredPackages);
  return declaredPackages;
}

function importerDirectoryForFile(importerFile: string): string {
  if (directoryExists(importerFile)) return importerFile;
  return path.dirname(importerFile);
}

function declaredPackagesForContext(importerFile: string, projectRoot: string | undefined): Set<string> {
  const importerDirectory = path.resolve(importerDirectoryForFile(importerFile));
  const ancestorSearchStart = path.resolve(projectRoot ?? importerDirectory);
  const vcsBoundary = nearestVcsAncestor(ancestorSearchStart);
  const boundary =
    nearestManifestAncestor(ancestorSearchStart, vcsBoundary) ?? path.resolve(projectRoot ?? importerDirectory);
  if (!isSameOrInside(importerDirectory, boundary)) {
    return dependencyManifestForDirectory(boundary).declaredPackages;
  }
  return declaredPackagesFromAncestors(importerDirectory, boundary);
}

function isUrlSpecifier(specifier: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(specifier) || specifier.startsWith("data:");
}

function packageNameForSpecifier(specifier: string): string {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : specifier;
  }
  return specifier.split("/")[0] ?? specifier;
}

function isDeclaredPackageSpecifier(specifier: string, declaredPackage: string): boolean {
  if (specifier === declaredPackage) return true;
  if (specifier.startsWith(`${declaredPackage}/`)) return true;
  if (specifier.startsWith(`${declaredPackage}.`)) return true;
  return packageNameForSpecifier(specifier) === declaredPackage;
}

function extensionForFile(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

function isSupportedStdlib(specifier: string, importerFile: string): boolean {
  const ext = extensionForFile(importerFile);
  const firstSegment = specifier.split(/[.:/]/)[0] ?? specifier;
  if (NODE_BUILTIN_MODULES.has(specifier)) return true;
  if ([".py", ".pyw"].includes(ext)) return PYTHON_STDLIB_MODULES.has(firstSegment);
  if ([".rb"].includes(ext)) return RUBY_STDLIB_MODULES.has(specifier) || RUBY_STDLIB_MODULES.has(firstSegment);
  if (ext === ".zig") return specifier === "std";
  if (ext === ".go") return GO_STDLIB_IMPORTS.has(specifier) || GO_STDLIB_IMPORTS.has(firstSegment);
  if (ext === ".rs")
    return (
      specifier === "std" ||
      specifier.startsWith("std::") ||
      specifier.startsWith("core::") ||
      specifier.startsWith("alloc::")
    );
  if ([".java"].includes(ext))
    return (
      specifier.startsWith("java.") ||
      specifier.startsWith("javax.") ||
      specifier.startsWith("org.w3c.") ||
      specifier.startsWith("org.xml.")
    );
  if ([".kt", ".kts"].includes(ext)) return specifier === "kotlin" || specifier.startsWith("kotlin.");
  if (ext === ".cs")
    return specifier === "System" || specifier.startsWith("System.") || specifier.startsWith("Microsoft.");
  if (ext === ".swift") return SWIFT_SDK_MODULES.has(firstSegment);
  if ([".c", ".h", ".i"].includes(ext)) return C_STDLIB_HEADERS.has(specifier);
  if ([".cc", ".cpp", ".cxx", ".c++", ".hpp", ".hh", ".hxx", ".ipp", ".tpp", ".inl"].includes(ext)) {
    return CPP_STDLIB_HEADERS.has(specifier) || C_STDLIB_HEADERS.has(specifier);
  }
  return false;
}

function isDeclaredPackage(specifier: string, importerFile: string, projectRoot: string | undefined): boolean {
  for (const declaredPackage of declaredPackagesForContext(importerFile, projectRoot)) {
    if (isDeclaredPackageSpecifier(specifier, declaredPackage)) {
      return true;
    }
  }
  return false;
}

export function classifyExternalSpecifier(args: {
  raw: string;
  externalName: string;
  importerFile: string;
  options?: ExternalSpecifierClassificationOptions;
}): ExternalSpecifierClassification {
  const specifier = args.raw || args.externalName;
  if (isUrlSpecifier(specifier) || isUrlSpecifier(args.externalName)) return { status: "url" };
  if (isSupportedStdlib(specifier, args.importerFile) || isSupportedStdlib(args.externalName, args.importerFile)) {
    return { status: "stdlib" };
  }
  if (
    isDeclaredPackage(specifier, args.importerFile, args.options?.projectRoot) ||
    isDeclaredPackage(args.externalName, args.importerFile, args.options?.projectRoot)
  ) {
    return { status: "declared-package", packageName: packageNameForSpecifier(specifier) };
  }
  return { status: "unresolved" };
}
