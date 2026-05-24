import path from "node:path";
import { findFirstExistingResolutionCandidate } from "./findFirstExisting.js";
import { pickPackageExportTarget } from "../packageExports.js";
import { directoryExists, loadJSON, type MinimalPackageJson } from "../workspace.js";

export async function resolveFromNodeModules(
  spec: string,
  fromFile: string,
  _projectRoot: string,
  resolutionExtensions?: readonly string[],
): Promise<string | null> {
  try {
    let dir = path.dirname(fromFile);
    const parts = spec.split("/");
    const packageName = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
    const subpath = spec.startsWith("@") ? parts.slice(2).join("/") : parts.slice(1).join("/");
    while (true) {
      const nmDir = path.join(dir, "node_modules", packageName);
      if (await directoryExists(nmDir)) {
        const pkgPath = path.join(nmDir, "package.json");
        const pkg = await loadJSON<MinimalPackageJson>(pkgPath);
        const baseDir = nmDir;
        const tryResolveRelative = async (rel: string): Promise<string | null> => {
          return await findFirstExistingResolutionCandidate(path.resolve(baseDir, rel), resolutionExtensions);
        };
        if (pkg?.exports) {
          const key = subpath ? `./${subpath}` : ".";
          if (typeof pkg.exports === "string" && key === ".") {
            const hit = await tryResolveRelative(pkg.exports);
            if (hit) return hit;
          } else if (typeof pkg.exports === "object" && pkg.exports !== null) {
            const map = pkg.exports as Record<string, unknown>;
            const target = map[key] ?? (key === "." ? map["."] : undefined);
            const rel = pickPackageExportTarget(target);
            if (rel) {
              const hit = await tryResolveRelative(rel);
              if (hit) return hit;
            }
          }
        }
        if (subpath) {
          const hit = await findFirstExistingResolutionCandidate(path.join(baseDir, subpath), resolutionExtensions);
          if (hit) return hit;
        }
        const mainField = typeof pkg?.main === "string" ? path.resolve(baseDir, pkg.main) : null;
        if (mainField) {
          const mainHit = await findFirstExistingResolutionCandidate(mainField, resolutionExtensions);
          if (mainHit) return mainHit;
        }
        const indexHit = await findFirstExistingResolutionCandidate(path.join(baseDir, "index"), resolutionExtensions);
        if (indexHit) return indexHit;
        return null;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fs/access: ignore */
  }
  return null;
}
