import path from "node:path";
import { fileExists } from "../workspace.js";

function isWithinOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function findNearestCargoRoot(fromFile: string, projectRoot: string): Promise<string | null> {
  const root = path.resolve(projectRoot);
  let dir = path.dirname(path.resolve(fromFile));
  while (isWithinOrEqual(dir, root)) {
    if (await fileExists(path.join(dir, "Cargo.toml"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function normalizeRustModuleSpecifier(spec: string): string {
  const compact = spec.replace(/\s+/g, "");
  const braceIndex = compact.indexOf("{");
  const withoutGroup = braceIndex >= 0 ? compact.slice(0, braceIndex).replace(/::$/, "") : compact;
  return withoutGroup.endsWith("::*") ? withoutGroup.slice(0, -"::*".length) : withoutGroup;
}

async function firstExistingFile(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return path.resolve(candidate);
    }
  }
  return null;
}

function rustModuleCandidates(baseDir: string, parts: readonly string[]): string[] {
  if (!parts.length) {
    return [path.join(baseDir, "lib.rs"), path.join(baseDir, "main.rs"), path.join(baseDir, "mod.rs")];
  }
  const modulePath = path.join(baseDir, ...parts);
  return [`${modulePath}.rs`, path.join(modulePath, "mod.rs")];
}

function crateSourceRoot(cargoRoot: string | null, projectRoot: string): string {
  const root = cargoRoot ?? projectRoot;
  return path.join(root, "src");
}

async function resolveRustModuleParts(baseDir: string, parts: readonly string[]): Promise<string | null> {
  return firstExistingFile(rustModuleCandidates(baseDir, parts));
}

export async function resolveRustImportPath(
  projectRoot: string,
  fromFile: string,
  spec: string,
): Promise<string | null> {
  const normalized = normalizeRustModuleSpecifier(spec);
  if (!normalized) return null;

  const parts = normalized.split("::").filter(Boolean);
  if (!parts.length) return null;

  const cargoRoot = await findNearestCargoRoot(fromFile, projectRoot);
  const sourceRoot = crateSourceRoot(cargoRoot, projectRoot);
  const currentDir = path.dirname(fromFile);
  const head = parts[0];
  const tail = parts.slice(1);

  if (head === "crate") {
    return resolveRustModuleParts(sourceRoot, tail);
  }
  if (head === "self") {
    return resolveRustModuleParts(currentDir, tail);
  }
  if (head === "super") {
    const parentModuleFile = await resolveRustModuleParts(currentDir, []);
    if (!tail.length && parentModuleFile) {
      return parentModuleFile;
    }
    const siblingModule = await resolveRustModuleParts(currentDir, tail);
    if (siblingModule) {
      return siblingModule;
    }
    return resolveRustModuleParts(path.dirname(currentDir), tail);
  }

  const siblingModule = await resolveRustModuleParts(currentDir, parts);
  if (siblingModule) {
    return siblingModule;
  }
  return resolveRustModuleParts(sourceRoot, parts);
}
