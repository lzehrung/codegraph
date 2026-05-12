import path from "node:path";

export function normalizeProjectFile(projectRoot: string | undefined, file: string): string {
  const normalizedFile = file.replace(/\\/g, "/");
  const isAbsolute = path.isAbsolute(normalizedFile) || path.posix.isAbsolute(normalizedFile);
  const base = projectRoot ?? process.cwd();
  return path.resolve(isAbsolute ? normalizedFile : path.join(base, normalizedFile)).replace(/\\/g, "/");
}

export function isWithinProjectRoot(projectRoot: string, file: string): boolean {
  const root = path.resolve(projectRoot);
  const target = path.resolve(file);
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
