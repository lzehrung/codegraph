import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { unquote } from "../ast.js";
import { fileExists } from "../workspace.js";
import { findNearestFile } from "./files.js";

type GoModuleInfo = {
  modulePath: string;
  moduleRoot: string;
  replacements: Map<string, string>;
};

function stripInlineComment(line: string): string {
  const idx = line.indexOf("//");
  return idx === -1 ? line.trim() : line.slice(0, idx).trim();
}

async function parseGoMod(moduleRoot: string): Promise<GoModuleInfo | null> {
  const modPath = path.join(moduleRoot, "go.mod");
  if (!(await fileExists(modPath))) return null;
  const raw = await fsp.readFile(modPath, "utf8");
  const lines = raw.split(/\r?\n/);
  let modulePath: string | null = null;
  const replacements = new Map<string, string>();
  for (const rawLine of lines) {
    const line = stripInlineComment(rawLine);
    if (!line) continue;
    if (!modulePath) {
      const moduleMatch = line.match(/^module\s+(.+)$/);
      if (moduleMatch) {
        modulePath = unquote(moduleMatch[1]?.trim() ?? "");
        continue;
      }
    }
    const replaceMatch = line.match(/^replace\s+(\S+)(?:\s+v[^\s]+)?\s+=>\s+(\S+)/);
    if (replaceMatch) {
      const from = unquote(replaceMatch[1] ?? "");
      const toRaw = unquote(replaceMatch[2] ?? "");
      if (!from || !toRaw) continue;
      if (path.isAbsolute(toRaw) || toRaw.startsWith(".")) {
        const toPath = path.resolve(moduleRoot, toRaw);
        replacements.set(from, toPath);
      }
    }
  }
  if (!modulePath) return null;
  return {
    modulePath,
    moduleRoot,
    replacements,
  };
}

async function parseGoWork(goWorkPath: string): Promise<string[]> {
  const content = await fsp.readFile(goWorkPath, "utf8");
  const lines = content.split(/\r?\n/);
  const modules: string[] = [];
  let inUseBlock = false;
  for (const rawLine of lines) {
    const line = stripInlineComment(rawLine);
    if (!line) continue;
    if (line.startsWith("use (")) {
      inUseBlock = true;
      continue;
    }
    if (inUseBlock) {
      if (line.startsWith(")")) {
        inUseBlock = false;
        continue;
      }
      modules.push(unquote(line));
      continue;
    }
    const match = line.match(/^use\s+(.+)$/);
    if (match) {
      modules.push(unquote(match[1] ?? ""));
    }
  }
  return modules.filter(Boolean);
}

async function findGoPackageEntry(dirPath: string): Promise<string | null> {
  try {
    const stat = await fsp.stat(dirPath);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  let entries: fs.Dirent[] = [];
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }
  const goFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".go") && !entry.name.endsWith("_test.go"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  if (!goFiles.length) return null;
  return path.join(dirPath, goFiles[0] ?? "");
}

function isGoStdLib(spec: string): boolean {
  const base = spec.split("/")[0] ?? "";
  return !!base.length && !base.includes(".");
}

async function resolveGoModuleImport(moduleInfo: GoModuleInfo, spec: string): Promise<string | null> {
  const { modulePath, moduleRoot, replacements } = moduleInfo;
  if (spec === modulePath || spec.startsWith(`${modulePath}/`)) {
    const subPath = spec === modulePath ? "" : spec.slice(modulePath.length + 1);
    const targetDir = path.join(moduleRoot, subPath);
    const entry = await findGoPackageEntry(targetDir);
    if (entry) return entry;
  }
  for (const [from, toPath] of replacements.entries()) {
    if (spec === from || spec.startsWith(`${from}/`)) {
      const subPath = spec === from ? "" : spec.slice(from.length + 1);
      const targetDir = path.join(toPath, subPath);
      const entry = await findGoPackageEntry(targetDir);
      if (entry) return entry;
    }
  }
  const vendorDir = path.join(moduleRoot, "vendor", spec);
  const vendored = await findGoPackageEntry(vendorDir);
  if (vendored) return vendored;
  return null;
}

export async function resolveGoImportPath(
  projectRoot: string,
  fromFile: string,
  spec: string,
): Promise<string | null> {
  const startDir = path.dirname(fromFile);
  const goWorkPath = await findNearestFile(startDir, projectRoot, "go.work");
  const moduleInfos: GoModuleInfo[] = [];

  if (goWorkPath) {
    const workDir = path.dirname(goWorkPath);
    const useDirs = await parseGoWork(goWorkPath);
    for (const useDir of useDirs) {
      if (!useDir) continue;
      const moduleRoot = path.resolve(workDir, useDir);
      const modInfo = await parseGoMod(moduleRoot);
      if (modInfo) moduleInfos.push(modInfo);
    }
  }

  if (!moduleInfos.length) {
    const goModPath = await findNearestFile(startDir, projectRoot, "go.mod");
    if (goModPath) {
      const moduleRoot = path.dirname(goModPath);
      const modInfo = await parseGoMod(moduleRoot);
      if (modInfo) moduleInfos.push(modInfo);
    }
  }

  for (const moduleInfo of moduleInfos) {
    const resolved = await resolveGoModuleImport(moduleInfo, spec);
    if (resolved) return resolved;
  }

  if (isGoStdLib(spec)) {
    const goRoot = process.env.GOROOT;
    if (goRoot) {
      const stdlibDir = path.join(goRoot, "src", spec);
      const entry = await findGoPackageEntry(stdlibDir);
      if (entry) return entry;
    }
  }

  return null;
}
