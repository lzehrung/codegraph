import path from "node:path";
import { findFirstExistingResolutionCandidate } from "./findFirstExisting.js";
import { resolvePackageExportTargets, type PackageExportConditionMode } from "../packageExports.js";
import { fileIdentityKey, isFilePathWithinRoot } from "../paths.js";
import { directoryExists, loadJSON, type MinimalPackageJson } from "../workspace.js";

export async function resolveFromNodeModules(
  spec: string,
  fromFile: string,
  projectRoot: string,
  resolutionExtensions?: readonly string[],
  exportCondition: PackageExportConditionMode = "import",
): Promise<string | null> {
  try {
    const resolvedProjectRoot = path.resolve(projectRoot);
    const projectRootKey = fileIdentityKey(resolvedProjectRoot);
    let dir = path.dirname(fromFile);
    const parts = spec.split("/");
    const packageName = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
    const subpath = spec.startsWith("@") ? parts.slice(2).join("/") : parts.slice(1).join("/");
    while (isFilePathWithinRoot(resolvedProjectRoot, dir)) {
      const nmDir = path.join(dir, "node_modules", packageName);
      if (await directoryExists(nmDir)) {
        const pkgPath = path.join(nmDir, "package.json");
        const pkg = await loadJSON<MinimalPackageJson>(pkgPath);
        const tryResolveRelative = async (rel: string): Promise<string | null> => {
          const hit = await findFirstExistingResolutionCandidate(path.resolve(nmDir, rel), resolutionExtensions);
          return hit && isFilePathWithinRoot(resolvedProjectRoot, hit) ? hit : null;
        };

        if (pkg && Object.hasOwn(pkg, "exports")) {
          const exportKey = subpath ? `./${subpath}` : ".";
          for (const target of resolvePackageExportTargets(pkg.exports, exportKey, exportCondition)) {
            const hit = await tryResolveRelative(target);
            if (hit) return hit;
          }
          return null;
        }
        if (subpath) {
          const hit = await tryResolveRelative(subpath);
          if (hit) return hit;
        }
        if (typeof pkg?.main === "string") {
          const mainHit = await tryResolveRelative(pkg.main);
          if (mainHit) return mainHit;
        }
        const indexHit = await tryResolveRelative("./index");
        if (indexHit) return indexHit;
        return null;
      }
      if (fileIdentityKey(dir) === projectRootKey) break;
      const parent = path.dirname(dir);
      if (!isFilePathWithinRoot(resolvedProjectRoot, parent)) break;
      dir = parent;
    }
  } catch {
    /* fs/access: ignore */
  }
  return null;
}
