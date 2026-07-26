import path from "node:path";
import { normalizePath } from "./paths.js";

export function isRelativePathInside(relativePath: string): boolean {
  const normalized = normalizePath(relativePath);
  return (
    !!normalized &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    !path.isAbsolute(relativePath) &&
    !path.win32.isAbsolute(relativePath) &&
    !path.posix.isAbsolute(relativePath)
  );
}

export function matchesDiscoveryGlob(
  absolutePath: string,
  projectRoot: string,
  matcher: (relativePath: string) => boolean,
): boolean {
  const relativePath = path.relative(projectRoot, absolutePath);
  if (!isRelativePathInside(relativePath)) {
    return false;
  }
  return matcher(normalizePath(relativePath));
}
