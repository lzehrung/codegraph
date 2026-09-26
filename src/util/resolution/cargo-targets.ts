import type { Dirent } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { isPhysicalPathWithinRoot, readUtf8WithoutBom } from "../paths.js";

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

function packageBuildScriptPath(parsed: TomlTable): string | null {
  const pkg = isTomlTable(parsed.package) ? parsed.package : undefined;
  const build = pkg?.build;
  if (typeof build === "boolean") {
    if (!build) return null;
    return "build.rs";
  }
  if (typeof build === "string" && build.length) return build;
  return "build.rs";
}

function packageName(parsed: TomlTable): string | undefined {
  const pkg = isTomlTable(parsed.package) ? parsed.package : undefined;
  return pkg ? tomlString(pkg, "name") : undefined;
}

function inferredNamedTargetDirectory(kind: "bin" | "example" | "test" | "bench"): string {
  if (kind === "bin") return path.join("src", "bin");
  if (kind === "example") return "examples";
  if (kind === "test") return "tests";
  return "benches";
}

function inferredNamedTargetPaths(
  kind: "bin" | "example" | "test" | "bench",
  name: string,
  pkgName: string | undefined,
): string[] {
  const directory = inferredNamedTargetDirectory(kind);
  const candidates = [path.join(directory, `${name}.rs`), path.join(directory, name, "main.rs")];
  if (kind === "bin" && pkgName && name === pkgName) {
    candidates.push(path.join("src", "main.rs"));
  }
  return candidates;
}

function explicitTargetPaths(parsed: TomlTable): string[] {
  const paths: string[] = [];
  const lib = isTomlTable(parsed.lib) ? parsed.lib : undefined;
  const libPath = lib ? tomlString(lib, "path") : undefined;
  if (libPath) paths.push(libPath);
  const pkgName = packageName(parsed);
  for (const key of ["bin", "example", "test", "bench"] as const) {
    for (const target of tomlTables(parsed[key])) {
      const targetPath = tomlString(target, "path");
      if (targetPath) {
        paths.push(targetPath);
        continue;
      }
      const name = tomlString(target, "name");
      if (!name) continue;
      paths.push(...inferredNamedTargetPaths(key, name, pkgName));
    }
  }
  return paths;
}

async function parseCargoToml(cargoRoot: string): Promise<TomlTable | null> {
  try {
    const raw = await readUtf8WithoutBom(path.join(cargoRoot, "Cargo.toml"));
    const parsed = parseToml(raw);
    return isTomlTable(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function acceptCrateRoot(
  candidate: string,
  projectRoot: string,
  requireRustExtension = false,
): Promise<string | null> {
  const resolved = path.resolve(candidate);
  if (requireRustExtension && !resolved.endsWith(".rs")) return null;
  try {
    const stat = await fsp.stat(resolved);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  if (!(await isPhysicalPathWithinRoot(projectRoot, resolved))) return null;
  return resolved;
}

async function addCrateRoot(
  roots: Set<string>,
  probed: Set<string>,
  candidate: string,
  projectRoot: string,
  requireRustExtension = false,
): Promise<void> {
  const resolved = path.resolve(candidate);
  probed.add(resolved);
  const accepted = await acceptCrateRoot(resolved, projectRoot, requireRustExtension);
  if (accepted) roots.add(accepted);
}

async function addAutodiscoveredDirectory(
  roots: Set<string>,
  probed: Set<string>,
  directory: string,
  projectRoot: string,
): Promise<void> {
  probed.add(path.resolve(directory));
  let entries: Dirent[] = [];
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await addCrateRoot(roots, probed, path.join(directory, entry.name, "main.rs"), projectRoot, true);
      continue;
    }
    if (!entry.name.endsWith(".rs")) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile()) {
      await addCrateRoot(roots, probed, entryPath, projectRoot, true);
      continue;
    }
    try {
      const st = await fsp.stat(entryPath);
      if (st.isFile()) await addCrateRoot(roots, probed, entryPath, projectRoot, true);
    } catch {
      // Dangling or unreadable symlink: not a crate root.
    }
  }
}

export type RustCrateRoots = {
  /** Existing, resolved, project-confined crate root files. */
  roots: string[];
  /** Every candidate path considered, existing or not, for cache revalidation. */
  probed: string[];
};

export async function rustCrateRootFiles(cargoRoot: string, projectRoot: string): Promise<RustCrateRoots> {
  const root = path.resolve(cargoRoot);
  const roots = new Set<string>();
  const probed = new Set<string>();
  const parsed = await parseCargoToml(root);

  if (parsed && !isTomlTable(parsed.package)) {
    return { roots: [], probed: [] };
  }

  if (parsed) {
    for (const relativePath of explicitTargetPaths(parsed)) {
      await addCrateRoot(roots, probed, path.resolve(root, relativePath), projectRoot);
    }
    const buildScript = packageBuildScriptPath(parsed);
    if (buildScript) {
      await addCrateRoot(roots, probed, path.resolve(root, buildScript), projectRoot);
    }
    const lib = isTomlTable(parsed.lib) ? parsed.lib : undefined;
    const libPath = lib ? tomlString(lib, "path") : undefined;
    if (!libPath && (lib || packageAutoFlag(parsed, "autolib"))) {
      await addCrateRoot(roots, probed, path.join(root, "src", "lib.rs"), projectRoot);
    }
    if (packageAutoFlag(parsed, "autobins")) {
      await addCrateRoot(roots, probed, path.join(root, "src", "main.rs"), projectRoot);
    }
  } else {
    await addCrateRoot(roots, probed, path.join(root, "build.rs"), projectRoot);
    await addCrateRoot(roots, probed, path.join(root, "src", "lib.rs"), projectRoot);
    await addCrateRoot(roots, probed, path.join(root, "src", "main.rs"), projectRoot);
  }

  for (const group of AUTO_DISCOVERY_GROUPS) {
    if (parsed && !packageAutoFlag(parsed, group.flag)) continue;
    await addAutodiscoveredDirectory(roots, probed, path.join(root, group.directory), projectRoot);
  }

  return { roots: [...roots], probed: [...probed] };
}

/**
 * The crate's own package name declared in its Cargo.toml `[package]` table, as the Rust
 * identifier spells it (hyphens folded to underscores, since Cargo derives a crate's own
 * identifier from its package name that way), or undefined when the manifest is missing or
 * declares no name (a virtual workspace root). Lets a package's own `src/bin` targets
 * resolve `use pkg_name::item;` back to the package's own library crate.
 */
export async function rustCargoPackageIdentifier(cargoRoot: string): Promise<string | undefined> {
  const parsed = await parseCargoToml(cargoRoot);
  const name = parsed ? packageName(parsed) : undefined;
  return name ? name.replace(/-/gu, "_") : undefined;
}

/**
 * A `path`-only Cargo dependency declared under `[dependencies]`, `[dev-dependencies]`, or
 * `[build-dependencies]` (inline-table `name = { path = "..." }` or dotted-section
 * `[dependencies.name]` form), matched by the Rust identifier the dependency's own manifest
 * key spells (hyphens folded to underscores, matching Cargo's own crate-identifier rule). A
 * version-only or registry dependency has no `path` field and is not returned;
 * workspace-inherited (`{ workspace = true }`) dependencies are not resolved here.
 */
function pathDependencySpec(parsed: TomlTable, crateIdentifier: string): string | undefined {
  for (const key of ["dependencies", "dev-dependencies", "build-dependencies"] as const) {
    const table = isTomlTable(parsed[key]) ? parsed[key] : undefined;
    if (!table) continue;
    for (const [depName, entry] of Object.entries(table)) {
      if (depName.replace(/-/gu, "_") !== crateIdentifier || !isTomlTable(entry)) continue;
      const depPath = tomlString(entry, "path");
      if (depPath) return depPath;
    }
  }
  return undefined;
}

/**
 * Resolves a `path`-only Cargo dependency declared in `cargoRoot`'s own Cargo.toml, named
 * `crateIdentifier` (the Rust identifier form, e.g. `crate_a`), confined to `projectRoot`.
 * Returns the dependency crate's own root directory (where its Cargo.toml lives), or null
 * when `crateIdentifier` is not a path dependency, its path escapes the project, or the
 * resolved directory does not exist.
 */
export async function rustPathDependencyCrateRoot(
  cargoRoot: string,
  projectRoot: string,
  crateIdentifier: string,
): Promise<string | null> {
  const parsed = await parseCargoToml(cargoRoot);
  if (!parsed) return null;
  const depPath = pathDependencySpec(parsed, crateIdentifier);
  if (!depPath) return null;
  const resolved = path.resolve(cargoRoot, depPath);
  if (!(await isPhysicalPathWithinRoot(projectRoot, resolved))) return null;
  try {
    const stat = await fsp.stat(resolved);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  return resolved;
}
