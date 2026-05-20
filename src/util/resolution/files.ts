import fsp from "node:fs/promises";
import path from "node:path";
import { fileExists } from "../workspace.js";

export async function findNearestFile(startDir: string, stopDir: string, fileName: string): Promise<string | null> {
  let dir = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  while (true) {
    const candidate = path.join(dir, fileName);
    if (await fileExists(candidate)) return candidate;
    if (dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}
