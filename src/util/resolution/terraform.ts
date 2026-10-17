import fsp from "node:fs/promises";
import path from "node:path";
import { supportForFileWithoutHeaderSample, type LanguageExtensionMap } from "../../languages.js";
import { confineResolvedPath, normalizePath } from "../paths.js";

/**
 * The directory a Terraform module `source` names, or null when the source is not local.
 *
 * Terraform treats a source as a local path when it starts with `./` or `../`, and as an absolute
 * path (copied as a package by `terraform init`) when it starts with `/` or a drive letter. Every
 * other form (a registry address, a Git, HTTP, or S3 URL, or an archive) is installed from
 * elsewhere, so it is external to the project. Callers confine the directory to the project root.
 */
export function terraformLocalModuleDirectory(fromFile: string, source: string): string | null {
  if (source.startsWith("./") || source.startsWith("../")) {
    return normalizePath(path.resolve(path.dirname(fromFile), source));
  }
  if (WINDOWS_DRIVE_PATH.test(source)) return normalizePath(path.win32.normalize(source));
  if (source.startsWith("/")) return normalizePath(path.resolve(source));
  return null;
}

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/u;

/**
 * Every Terraform file directly inside a local module source directory, sorted and confined to
 * the project root. A module is the whole directory, so a module call depends on each file.
 * Subdirectories are separate modules and are not included. A symlink counts when its target is a
 * regular file inside the project root.
 */
export async function resolveTerraformModuleSourcePaths(
  projectRoot: string,
  source: string,
  fromFile: string,
  languageExtensions?: LanguageExtensionMap,
): Promise<string[]> {
  const directory = terraformLocalModuleDirectory(fromFile, source);
  if (!directory) return [];
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => ({ file: normalizePath(path.join(directory, entry.name)), link: entry.isSymbolicLink() }))
    .filter(({ file }) => supportForFileWithoutHeaderSample(file, languageExtensions)?.id === "terraform")
    .sort((left, right) => left.file.localeCompare(right.file));
  const confined: string[] = [];
  for (const candidate of candidates) {
    if (candidate.link && !(await isRegularFileTarget(candidate.file))) continue;
    const hit = await confineResolvedPath(projectRoot, candidate.file);
    if (hit) confined.push(hit);
  }
  return confined;
}

async function isRegularFileTarget(link: string): Promise<boolean> {
  try {
    return (await fsp.stat(link)).isFile();
  } catch {
    return false;
  }
}
