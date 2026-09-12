import fsp from "node:fs/promises";
import path from "node:path";
import { isFilePathWithinRoot } from "../paths.js";
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

function parentRustModuleDir(fromFile: string, currentDir: string): string {
  if (path.basename(fromFile) === "mod.rs") {
    return path.dirname(currentDir);
  }
  return currentDir;
}

async function resolveRustModuleParts(baseDir: string, parts: readonly string[]): Promise<string | null> {
  return firstExistingFile(rustModuleCandidates(baseDir, parts));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const RUST_PATH_ATTRIBUTE_PATTERN = /#\s*\[\s*path\s*=\s*(?:r(#*)"([\s\S]*?)"\1|"([^"]*)")\s*\]/gu;

function pathAttributeFromAttributeBlock(attributes: string): string | undefined {
  let last: string | undefined;
  RUST_PATH_ATTRIBUTE_PATTERN.lastIndex = 0;
  for (const match of attributes.matchAll(RUST_PATH_ATTRIBUTE_PATTERN)) {
    last = match[2] ?? match[3];
  }
  return last;
}

function takeTrailingRustAttributes(source: string, statementIndex: number): string {
  const prefix = source.slice(0, statementIndex).trimEnd();
  let index = prefix.length;
  const chunks: string[] = [];
  while (index > 0) {
    let end = index;
    while (end > 0 && /\s/.test(prefix[end - 1]!)) end -= 1;
    if (end === 0 || prefix[end - 1] !== "]") break;
    let depth = 1;
    let cursor = end - 2;
    while (cursor >= 0 && depth > 0) {
      const character = prefix[cursor];
      if (character === "]") depth += 1;
      else if (character === "[") depth -= 1;
      cursor -= 1;
    }
    if (depth !== 0) break;
    const openBracket = cursor + 1;
    if (openBracket <= 0 || prefix[openBracket - 1] !== "#") break;
    const attrStart = openBracket - 1;
    chunks.unshift(prefix.slice(attrStart, end));
    index = attrStart;
  }
  return chunks.join("\n");
}

export function extractRustModPathAttribute(
  source: string,
  moduleName?: string,
  statementStartIndex?: number,
): string | undefined {
  if (statementStartIndex !== undefined) {
    const leadingWhitespace = source.slice(statementStartIndex).search(/\S/);
    const index = statementStartIndex + Math.max(0, leadingWhitespace);
    return pathAttributeFromAttributeBlock(takeTrailingRustAttributes(source, index));
  }
  if (!moduleName) return undefined;
  const pattern = new RegExp(String.raw`(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+${escapeRegExp(moduleName)}\s*;`, "gu");
  for (const match of source.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const value = pathAttributeFromAttributeBlock(takeTrailingRustAttributes(source, match.index));
    if (value) return value;
  }
  return undefined;
}

function resolveAttributedRustPath(fromFile: string, pathAttribute: string): string {
  const trimmed = pathAttribute.trim();
  const fromDir = path.dirname(fromFile);
  return path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(fromDir, trimmed);
}

function moduleNameForPathAttribute(parts: readonly string[]): string | undefined {
  if (!parts.length) return undefined;
  const head = parts[0];
  if (parts.length === 1) {
    if (head === "crate" || head === "self" || head === "super" || head === "*") return undefined;
    return head;
  }
  if ((head === "crate" || head === "self" || head === "super") && parts.length === 2) {
    const name = parts[1];
    return name && name !== "*" ? name : undefined;
  }
  return undefined;
}

async function discoverRustPathAttribute(fromFile: string, parts: readonly string[]): Promise<string | undefined> {
  const moduleName = moduleNameForPathAttribute(parts);
  if (!moduleName) return undefined;
  try {
    const source = await fsp.readFile(fromFile, "utf8");
    return extractRustModPathAttribute(source, moduleName);
  } catch {
    return undefined;
  }
}

export async function resolveRustImportPath(
  projectRoot: string,
  fromFile: string,
  spec: string,
  pathAttribute?: string,
): Promise<string | null> {
  const normalized = normalizeRustModuleSpecifier(spec);
  if (!normalized) return null;

  const parts = normalized.split("::").filter(Boolean);
  if (!parts.length) return null;

  const attributed = pathAttribute || (await discoverRustPathAttribute(fromFile, parts));
  if (attributed) {
    const attributedPath = resolveAttributedRustPath(fromFile, attributed);
    if ((await fileExists(attributedPath)) && isFilePathWithinRoot(projectRoot, attributedPath)) {
      return path.resolve(attributedPath);
    }
    return null;
  }

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
    const parentModuleDir = parentRustModuleDir(fromFile, currentDir);
    const parentModuleFile = await resolveRustModuleParts(parentModuleDir, []);
    if (!tail.length && parentModuleFile) {
      return parentModuleFile;
    }
    return resolveRustModuleParts(parentModuleDir, tail);
  }

  const siblingModule = await resolveRustModuleParts(currentDir, parts);
  if (siblingModule) {
    return siblingModule;
  }
  return resolveRustModuleParts(sourceRoot, parts);
}
