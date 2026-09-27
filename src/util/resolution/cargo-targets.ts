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

/**
 * The Cargo.toml in `cargoRoot`, read only when the manifest file itself physically lies
 * inside `projectRoot`: a symlinked manifest from outside the project must not steer
 * crate targets or dependency resolution.
 */
async function parseCargoToml(cargoRoot: string, projectRoot: string): Promise<TomlTable | null> {
  const manifest = path.join(cargoRoot, "Cargo.toml");
  if (!(await isPhysicalPathWithinRoot(projectRoot, manifest))) return null;
  try {
    const raw = await readUtf8WithoutBom(manifest);
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
  const parsed = await parseCargoToml(root, projectRoot);

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
export async function rustCargoPackageIdentifier(cargoRoot: string, projectRoot: string): Promise<string | undefined> {
  const parsed = await parseCargoToml(cargoRoot, projectRoot);
  const name = parsed ? packageName(parsed) : undefined;
  return name ? name.replace(/-/gu, "_") : undefined;
}

/** Inline dependency tables naming `crateIdentifier`, across the dependency groups. */
function dependencyEntries(parsed: TomlTable, crateIdentifier: string): TomlTable[] {
  const matches: TomlTable[] = [];
  for (const key of ["dependencies", "dev-dependencies", "build-dependencies"] as const) {
    const table = isTomlTable(parsed[key]) ? parsed[key] : undefined;
    if (!table) continue;
    for (const [depName, entry] of Object.entries(table)) {
      if (depName.replace(/-/gu, "_") !== crateIdentifier || !isTomlTable(entry)) continue;
      matches.push(entry);
    }
  }
  return matches;
}

type PathDependency = {
  depPath: string;
  /** `package = "..."` rename: the dependency's real package name, when it differs from the key. */
  packageName?: string;
};

/**
 * A `path`-only Cargo dependency declared under `[dependencies]`, `[dev-dependencies]`, or
 * `[build-dependencies]` (inline-table `name = { path = "..." }` or dotted-section
 * `[dependencies.name]` form), matched by the Rust identifier the dependency's own manifest
 * key spells (hyphens folded to underscores, matching Cargo's own crate-identifier rule). A
 * version-only or registry dependency has no `path` field and is not returned;
 * workspace-inherited (`{ workspace = true }`) dependencies carry no `path` here and are
 * resolved through the workspace manifest instead.
 */
function pathDependencySpec(parsed: TomlTable, crateIdentifier: string): PathDependency | undefined {
  for (const entry of dependencyEntries(parsed, crateIdentifier)) {
    const depPath = tomlString(entry, "path");
    if (!depPath) continue;
    const renamed = tomlString(entry, "package");
    return renamed ? { depPath, packageName: renamed } : { depPath };
  }
  return undefined;
}

/** Whether the manifest's own dependency entry asks the workspace to supply the spec. */
function workspaceInheritanceRequested(parsed: TomlTable, crateIdentifier: string): boolean {
  for (const entry of dependencyEntries(parsed, crateIdentifier)) {
    const workspace = entry.workspace;
    if (typeof workspace === "boolean") return workspace;
  }
  return false;
}

/**
 * The `path` from the nearest ancestor workspace manifest's `[workspace.dependencies]` entry
 * for `crateIdentifier`, plus the manifest directory the path is relative to. The walk goes
 * from `cargoRoot` up to and including `projectRoot` and never reads a manifest outside it.
 * The nearest manifest declaring `[workspace]` governs inheritance, matching Cargo: an entry
 * missing there is not inherited from a more distant workspace.
 */
async function workspaceInheritedDependencyPath(
  cargoRoot: string,
  projectRoot: string,
  crateIdentifier: string,
): Promise<({ manifestDir: string } & PathDependency) | null> {
  const root = path.resolve(projectRoot);
  let current = path.resolve(cargoRoot);
  while (await isPhysicalPathWithinRoot(root, current)) {
    const parsed = await parseCargoToml(current, root);
    const workspace = parsed && isTomlTable(parsed.workspace) ? parsed.workspace : undefined;
    if (workspace) {
      const table = isTomlTable(workspace.dependencies) ? workspace.dependencies : undefined;
      for (const [depName, entry] of Object.entries(table ?? {})) {
        if (depName.replace(/-/gu, "_") !== crateIdentifier || !isTomlTable(entry)) continue;
        const depPath = tomlString(entry, "path");
        if (!depPath) return null;
        const renamed = tomlString(entry, "package");
        return renamed ? { manifestDir: current, depPath, packageName: renamed } : { manifestDir: current, depPath };
      }
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * Resolves a `path`-only Cargo dependency declared in `cargoRoot`'s own Cargo.toml, named
 * `crateIdentifier` (the Rust identifier form, e.g. `crate_a`), confined to `projectRoot`.
 * A workspace-inherited entry (`{ workspace = true }`) follows the nearest ancestor
 * workspace manifest's `[workspace.dependencies]` `path`, also confined to `projectRoot`.
 * Returns the dependency crate's own root directory, or null when `crateIdentifier` is not a
 * resolvable path dependency, its path escapes the project, or the directory has no Cargo.toml
 * whose `[package]` name is the dependency (Cargo rejects such a dependency).
 */
export async function rustPathDependencyCrateRoot(
  cargoRoot: string,
  projectRoot: string,
  crateIdentifier: string,
): Promise<string | null> {
  const parsed = await parseCargoToml(cargoRoot, projectRoot);
  if (!parsed) return null;
  let manifestDir = cargoRoot;
  let dependency = pathDependencySpec(parsed, crateIdentifier);
  if (!dependency && workspaceInheritanceRequested(parsed, crateIdentifier)) {
    const inherited = await workspaceInheritedDependencyPath(cargoRoot, projectRoot, crateIdentifier);
    if (!inherited) return null;
    manifestDir = inherited.manifestDir;
    dependency = inherited;
  }
  if (!dependency) return null;
  const resolved = path.resolve(manifestDir, dependency.depPath);
  if (!(await isPhysicalPathWithinRoot(projectRoot, resolved))) return null;
  const dependencyManifest = await parseCargoToml(resolved, projectRoot);
  const actualName = dependencyManifest ? packageName(dependencyManifest) : undefined;
  const expectedName = dependency.packageName ?? crateIdentifier;
  if (!actualName || actualName.replace(/-/gu, "_") !== expectedName.replace(/-/gu, "_")) return null;
  return resolved;
}
