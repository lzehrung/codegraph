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
};

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

const dependencyManifestCache = new Map<string, DependencyManifest>();
const declaredPackagesByStartDirectoryCache = new Map<string, Set<string>>();

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
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

function addPackageJsonDependencies(filePath: string, declaredPackages: Set<string>): void {
  const parsed = readJsonObject(filePath);
  if (!parsed) return;
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
    for (const packageName of Object.keys(readStringRecord(parsed[field]))) {
      declaredPackages.add(packageName);
    }
  }
}

function addComposerDependencies(filePath: string, declaredPackages: Set<string>): void {
  const parsed = readJsonObject(filePath);
  if (!parsed) return;
  for (const field of ["require", "require-dev"] as const) {
    for (const packageName of Object.keys(readStringRecord(parsed[field]))) {
      if (packageName !== "php" && !packageName.startsWith("ext-")) {
        declaredPackages.add(packageName);
      }
    }
  }
}

function addPythonPackageName(rawName: string, declaredPackages: Set<string>): void {
  const normalizedName = rawName.trim().split("[")[0]?.toLowerCase();
  if (!normalizedName) return;
  declaredPackages.add(normalizedName);
  declaredPackages.add(normalizedName.replace(/-/g, "_"));
}

function addRequirementsDependencies(filePath: string, declaredPackages: Set<string>): void {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
    const dependency = trimmed.match(/^([A-Za-z0-9_.-]+)/);
    if (dependency?.[1]) {
      addPythonPackageName(dependency[1], declaredPackages);
    }
  }
}

function addPyprojectDependencies(filePath: string, declaredPackages: Set<string>): void {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  const dependencyArrays = raw.matchAll(/(?:^|\n)\s*[A-Za-z0-9_-]*dependencies\s*=\s*\[([\s\S]*?)\]/g);
  for (const dependencyArray of dependencyArrays) {
    for (const dependency of (dependencyArray[1] ?? "").matchAll(/["']([^"']+)["']/g)) {
      const packageName = dependency[1]?.match(/^([A-Za-z0-9_.-]+)/)?.[1];
      if (packageName) {
        addPythonPackageName(packageName, declaredPackages);
      }
    }
  }
}

function addCargoDependencies(filePath: string, declaredPackages: Set<string>): void {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
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
      declaredPackages.add(dependency[1].replace(/-/g, "_"));
      declaredPackages.add(dependency[1]);
    }
  }
}

function addGoDependencies(filePath: string, declaredPackages: Set<string>): void {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
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
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function addZigDependencies(filePath: string, declaredPackages: Set<string>): void {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
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
      const dependency = trimmed.match(/^\.([A-Za-z0-9_]+)\s*=/);
      if (dependency?.[1]) declaredPackages.add(dependency[1]);
    }
    dependencyDepth += countMatches(trimmed, /\{/g) - countMatches(trimmed, /\}/g);
    if (dependencyDepth <= 0) {
      inDependencySection = false;
    }
  }
}

function dependencyManifestForDirectory(directory: string): DependencyManifest {
  const resolvedRoot = path.resolve(directory);
  const cached = dependencyManifestCache.get(resolvedRoot);
  if (cached) return cached;

  const declaredPackages = new Set<string>();
  addPackageJsonDependencies(path.join(resolvedRoot, "package.json"), declaredPackages);
  addRequirementsDependencies(path.join(resolvedRoot, "requirements.txt"), declaredPackages);
  addPyprojectDependencies(path.join(resolvedRoot, "pyproject.toml"), declaredPackages);
  addComposerDependencies(path.join(resolvedRoot, "composer.json"), declaredPackages);
  addCargoDependencies(path.join(resolvedRoot, "Cargo.toml"), declaredPackages);
  addGoDependencies(path.join(resolvedRoot, "go.mod"), declaredPackages);
  addZigDependencies(path.join(resolvedRoot, "build.zig.zon"), declaredPackages);

  const manifest = { declaredPackages };
  dependencyManifestCache.set(resolvedRoot, manifest);
  return manifest;
}

function parentDirectory(directory: string): string | null {
  const parent = path.dirname(directory);
  return parent === directory ? null : parent;
}

function declaredPackagesFromAncestors(startDirectory: string): Set<string> {
  const resolvedStart = path.resolve(startDirectory);
  const cached = declaredPackagesByStartDirectoryCache.get(resolvedStart);
  if (cached) return cached;

  const declaredPackages = new Set<string>();
  let current: string | null = resolvedStart;
  while (current) {
    for (const packageName of dependencyManifestForDirectory(current).declaredPackages) {
      declaredPackages.add(packageName);
    }
    current = parentDirectory(current);
  }

  declaredPackagesByStartDirectoryCache.set(resolvedStart, declaredPackages);
  return declaredPackages;
}

function declaredPackagesForContext(importerFile: string, projectRoot: string | undefined): Set<string> {
  const declaredPackages = new Set<string>();
  const importerDirectory =
    fs.existsSync(importerFile) && fs.statSync(importerFile).isDirectory() ? importerFile : path.dirname(importerFile);

  for (const packageName of declaredPackagesFromAncestors(importerDirectory)) {
    declaredPackages.add(packageName);
  }
  if (projectRoot) {
    for (const packageName of declaredPackagesFromAncestors(projectRoot)) {
      declaredPackages.add(packageName);
    }
  }
  return declaredPackages;
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
