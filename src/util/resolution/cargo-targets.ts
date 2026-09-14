import type { Dirent } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { isFilePathWithinRoot } from "../paths.js";

type TomlTable = Record<string, unknown>;

const AUTO_DISCOVERY_GROUPS = [
  { flag: "autobins", directory: path.join("src", "bin") },
  { flag: "autotests", directory: "tests" },
  { flag: "autoexamples", directory: "examples" },
  { flag: "autobenches", directory: "benches" },
] as const;

function isTomlTable(value: unknown): value is TomlTable {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tomlTables(value: unknown): TomlTable[] {
  if (Array.isArray(value)) return value.filter(isTomlTable);
  return isTomlTable(value) ? [value] : [];
}

function tomlString(table: TomlTable, key: string): string | undefined {
  const value = table[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function packageAutoFlag(parsed: TomlTable, key: string): boolean {
  const pkg = isTomlTable(parsed.package) ? parsed.package : undefined;
  const fromPackage = pkg?.[key];
  if (typeof fromPackage === "boolean") return fromPackage;
  const fromRoot = parsed[key];
  if (typeof fromRoot === "boolean") return fromRoot;
  return true;
}

function explicitTargetPaths(parsed: TomlTable): string[] {
  const paths: string[] = [];
  const lib = isTomlTable(parsed.lib) ? parsed.lib : undefined;
  const libPath = lib ? tomlString(lib, "path") : undefined;
  if (libPath) paths.push(libPath);
  for (const key of ["bin", "example", "test", "bench"] as const) {
    for (const target of tomlTables(parsed[key])) {
      const targetPath = tomlString(target, "path");
      if (targetPath) paths.push(targetPath);
    }
  }
  return paths;
}

async function parseCargoToml(cargoRoot: string): Promise<TomlTable | null> {
  try {
    const raw = await fsp.readFile(path.join(cargoRoot, "Cargo.toml"), "utf8");
    const parsed = parseToml(raw);
    return isTomlTable(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function acceptCrateRoot(candidate: string, projectRoot: string): Promise<string | null> {
  const resolved = path.resolve(candidate);
  if (!resolved.endsWith(".rs")) return null;
  try {
    const stat = await fsp.stat(resolved);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  if (!isFilePathWithinRoot(projectRoot, resolved)) return null;
  try {
    const realRoot = await fsp.realpath(projectRoot);
    const realCandidate = await fsp.realpath(resolved);
    if (!isFilePathWithinRoot(realRoot, realCandidate)) return null;
  } catch {
    return null;
  }
  return resolved;
}

async function addCrateRoot(files: Set<string>, candidate: string, projectRoot: string): Promise<void> {
  const accepted = await acceptCrateRoot(candidate, projectRoot);
  if (accepted) files.add(accepted);
}

async function addAutodiscoveredDirectory(files: Set<string>, directory: string, projectRoot: string): Promise<void> {
  let entries: Dirent[] = [];
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await addCrateRoot(files, path.join(directory, entry.name, "main.rs"), projectRoot);
      continue;
    }
    if (entry.name.endsWith(".rs")) {
      await addCrateRoot(files, path.join(directory, entry.name), projectRoot);
    }
  }
}

export async function rustCrateRootFiles(cargoRoot: string, projectRoot: string): Promise<string[]> {
  const root = path.resolve(cargoRoot);
  const files = new Set<string>();
  const parsed = await parseCargoToml(root);

  if (parsed) {
    for (const relativePath of explicitTargetPaths(parsed)) {
      await addCrateRoot(files, path.resolve(root, relativePath), projectRoot);
    }
  }

  await addCrateRoot(files, path.join(root, "src", "lib.rs"), projectRoot);
  await addCrateRoot(files, path.join(root, "src", "main.rs"), projectRoot);

  for (const group of AUTO_DISCOVERY_GROUPS) {
    if (parsed && !packageAutoFlag(parsed, group.flag)) continue;
    await addAutodiscoveredDirectory(files, path.join(root, group.directory), projectRoot);
  }

  return [...files];
}
