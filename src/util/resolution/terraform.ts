import fsp from "node:fs/promises";
import path from "node:path";
import { supportForFileWithoutHeaderSample, type LanguageExtensionMap } from "../../languages.js";
import { confineResolvedPath, normalizePath } from "../paths.js";

/**
 * The directory a Terraform module `source` names, or null when the source is not local.
 *
 * Terraform treats a source as a local path only when it starts with `./` or `../`. Every other
 * form (a registry address, a Git, HTTP, or S3 URL, or an archive) is installed by
 * `terraform init`, so it is external to the project.
 */
export function terraformLocalModuleDirectory(fromFile: string, source: string): string | null {
  if (!source.startsWith("./") && !source.startsWith("../")) return null;
  return normalizePath(path.resolve(path.dirname(fromFile), source));
}

/**
 * Every Terraform file directly inside a local module source directory, sorted and confined to
 * the project root. A module is the whole directory, so a module call depends on each file.
 * Subdirectories are separate modules and are not included.
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
    .filter((entry) => entry.isFile())
    .map((entry) => normalizePath(path.join(directory, entry.name)))
    .filter((file) => supportForFileWithoutHeaderSample(file, languageExtensions)?.id === "terraform")
    .sort((left, right) => left.localeCompare(right));
  const confined: string[] = [];
  for (const candidate of candidates) {
    const hit = await confineResolvedPath(projectRoot, candidate);
    if (hit) confined.push(hit);
  }
  return confined;
}
