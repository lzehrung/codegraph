import path from "node:path";

export function normalizeImpactFilePath(
  projectRoot: string,
  filePath: string,
): string {
  return path.isAbsolute(filePath)
    ? filePath.replace(/\\/g, "/")
    : path.resolve(projectRoot, filePath).replace(/\\/g, "/");
}
