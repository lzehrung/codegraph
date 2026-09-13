import fsp from "node:fs/promises";
import path from "node:path";
import {
  isRustItemStartBoundary,
  skipRustAttribute,
  skipRustBalancedDelimiters,
  skipRustCommentOrLiteral,
  skipRustCommentsAndWhitespaceBackward,
  skipRustMacroTokenTree,
  skipRustOuterAttribute,
} from "../../languages/import-statement-parsers.js";
import { XID_IDENTIFIER_SOURCE } from "../identifiers.js";
import { lruMapGet, lruMapSet } from "../lru-map.js";
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

const RUST_PATH_ATTRIBUTE_PATTERN = /#\s*\[\s*path\s*=\s*(?:r(#*)"([\s\S]*?)"\1|"([^"]*)")\s*\]/gu;
const RUST_CFG_TEST_ATTRIBUTE_PATTERN = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/;
const RUST_VISIBILITY_PATTERN = /^(?:pub(?:\s*\([^)]*\))?\s+)/;
const RUST_MOD_NAME_PATTERN = new RegExp(String.raw`^mod\s+(${XID_IDENTIFIER_SOURCE})`, "u");
const MAX_RUST_PATH_ATTRIBUTE_CACHE_ENTRIES = 256;

type RustModuleScope = {
  pathAttributes: Map<string, string>;
  inlineModules: Map<string, RustModuleScope>;
  inlineLocation?: { start: number; end: number; directory: string };
};

type RustPathAttributeCacheEntry = {
  signature: string;
  attributes: RustModuleScope;
};

const EMPTY_RUST_MODULE_SCOPE: RustModuleScope = {
  pathAttributes: new Map(),
  inlineModules: new Map(),
};

const rustPathAttributeCache = new Map<string, RustPathAttributeCacheEntry>();
const rustPathAttributeInflight = new Map<string, Promise<RustModuleScope>>();

function createRustModuleScope(): RustModuleScope {
  return { pathAttributes: new Map(), inlineModules: new Map() };
}

function pathAttributeFromAttributeBlock(attributes: string): string | undefined {
  let last: string | undefined;
  RUST_PATH_ATTRIBUTE_PATTERN.lastIndex = 0;
  for (const match of attributes.matchAll(RUST_PATH_ATTRIBUTE_PATTERN)) {
    last = match[2] ?? match[3];
  }
  return last;
}

export function takeTrailingRustAttributes(source: string, statementIndex: number): string {
  let index = skipRustCommentsAndWhitespaceBackward(source, statementIndex);
  const chunks: string[] = [];
  while (index > 0) {
    if (source[index - 1] !== "]") break;
    const attrStart = rustOuterAttributeStartEndingAt(source, index);
    if (attrStart === null) break;
    chunks.unshift(source.slice(attrStart, index));
    index = skipRustCommentsAndWhitespaceBackward(source, attrStart);
  }
  return chunks.join("\n");
}

export function rustItemKeywordIndex(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index]!)) {
      index += 1;
      continue;
    }
    const skipped = skipRustCommentOrLiteral(source, index);
    if (skipped) {
      index = skipped.end;
      continue;
    }
    const attrEnd = skipRustOuterAttribute(source, index);
    if (attrEnd !== null) {
      index = attrEnd;
      continue;
    }
    break;
  }
  return index;
}

export function rustLeadingAttributesIncludeCfgTest(source: string, statementIndex: number): boolean {
  const keywordIndex = rustItemKeywordIndex(source, statementIndex);
  return RUST_CFG_TEST_ATTRIBUTE_PATTERN.test(takeTrailingRustAttributes(source, keywordIndex));
}

function enclosingInlineModulePath(scope: RustModuleScope, index: number): string[] {
  for (const [name, child] of scope.inlineModules) {
    const location = child.inlineLocation;
    if (!location || index < location.start || index >= location.end) continue;
    return [name, ...enclosingInlineModulePath(child, index)];
  }
  return [];
}

export function rustEnclosingInlineModulePath(source: string, statementStartIndex: number): string[] {
  return enclosingInlineModulePath(extractRustModPathAttributeScopes(source), statementStartIndex);
}

function findPathAttributedModulePath(
  scope: RustModuleScope,
  moduleName: string,
  prefix: readonly string[],
): string[] | undefined {
  if (scope.pathAttributes.has(moduleName)) return [...prefix, moduleName];
  for (const [childName, child] of scope.inlineModules) {
    const hit = findPathAttributedModulePath(child, moduleName, [...prefix, childName]);
    if (hit) return hit;
  }
  return undefined;
}

export function rustGraphModuleSpecifier(source: string, moduleName: string, statementStartIndex?: number): string {
  if (statementStartIndex !== undefined) {
    const pathAttribute = extractRustModPathAttribute(source, moduleName, statementStartIndex);
    if (!pathAttribute) return moduleName;
    const prefix = rustEnclosingInlineModulePath(source, statementStartIndex);
    return prefix.length ? `${prefix.join("::")}::${moduleName}` : moduleName;
  }
  const found = findPathAttributedModulePath(extractRustModPathAttributeScopes(source), moduleName, []);
  return found?.join("::") ?? moduleName;
}

export function rustStatementStartIndex(
  source: string,
  statementText: string,
  statementStartIndex?: number,
  searchFrom = 0,
): number | undefined {
  if (statementStartIndex !== undefined) return statementStartIndex;
  const normalized = statementText.trim();
  if (!normalized) return undefined;
  const index = source.indexOf(normalized, searchFrom);
  return index >= 0 ? index : undefined;
}

function rustOuterAttributeStartEndingAt(source: string, end: number): number | null {
  for (let start = end - 2; start >= 0; start -= 1) {
    if (source[start] !== "#") continue;
    if (skipRustOuterAttribute(source, start) === end) return start;
  }
  return null;
}

function collectLeadingRustOuterAttributes(source: string, start: number): string {
  let cursor = start;
  const chunks: string[] = [];
  while (cursor < source.length) {
    if (/\s/.test(source[cursor]!)) {
      cursor += 1;
      continue;
    }
    const skipped = skipRustCommentOrLiteral(source, cursor);
    if (skipped) {
      cursor = skipped.end;
      continue;
    }
    const attrEnd = skipRustOuterAttribute(source, cursor);
    if (attrEnd === null) break;
    chunks.push(source.slice(cursor, attrEnd));
    cursor = attrEnd;
  }
  return chunks.join("\n");
}

function skipRustTrivia(source: string, index: number, end: number): number {
  let cursor = index;
  while (cursor < end) {
    if (/\s/.test(source[cursor]!)) {
      cursor += 1;
      continue;
    }
    const skipped = skipRustCommentOrLiteral(source, cursor);
    if (skipped) {
      cursor = skipped.end < end ? skipped.end : end;
      continue;
    }
    break;
  }
  return cursor;
}

function extractRustModPathAttributeScopes(source: string): RustModuleScope {
  const root = createRustModuleScope();
  scanRustModuleScope(source, 0, source.length, root);
  return root;
}

function scanRustModuleScope(source: string, start: number, end: number, scope: RustModuleScope): void {
  let index = start;
  while (index < end) {
    const skipped = skipRustCommentOrLiteral(source, index) ?? skipRustMacroTokenTree(source, index);
    if (skipped) {
      index = skipped.end < end ? skipped.end : end;
      continue;
    }
    if (/\s/.test(source[index]!)) {
      index += 1;
      continue;
    }
    const attrEnd = skipRustAttribute(source, index);
    if (attrEnd !== null) {
      index = attrEnd < end ? attrEnd : end;
      continue;
    }

    if (!isRustItemStartBoundary(source, index)) {
      index += 1;
      continue;
    }

    const visMatch = source.slice(index, end).match(RUST_VISIBILITY_PATTERN);
    const afterVis = visMatch ? index + visMatch[0].length : index;
    const modMatch = source.slice(afterVis, end).match(RUST_MOD_NAME_PATTERN);
    if (modMatch?.[1]) {
      const moduleName = modMatch[1];
      const headerEnd = afterVis + modMatch[0].length;
      const attrs = takeTrailingRustAttributes(source, index);
      const testOnly = RUST_CFG_TEST_ATTRIBUTE_PATTERN.test(attrs);
      const pathValue = pathAttributeFromAttributeBlock(attrs);
      const cursor = skipRustTrivia(source, headerEnd, end);
      if (source[cursor] === ";") {
        if (!testOnly && pathValue && !scope.pathAttributes.has(moduleName)) {
          scope.pathAttributes.set(moduleName, pathValue);
        }
        index = cursor + 1;
        continue;
      }
      if (source[cursor] === "{") {
        const bodyEnd = skipRustBalancedDelimiters(source, cursor + 1, "}");
        const boundedEnd = bodyEnd < end ? bodyEnd : end;
        if (!testOnly) {
          let child = scope.inlineModules.get(moduleName);
          if (!child) {
            child = createRustModuleScope();
            scope.inlineModules.set(moduleName, child);
          }
          const bodyExclusiveEnd = boundedEnd > cursor + 1 ? boundedEnd - 1 : boundedEnd;
          child.inlineLocation = { start: cursor + 1, end: bodyExclusiveEnd, directory: pathValue ?? moduleName };
          scanRustModuleScope(source, cursor + 1, bodyExclusiveEnd, child);
        }
        index = boundedEnd;
        continue;
      }
      index = headerEnd;
      continue;
    }

    if (source[index] === "{") {
      const skippedBlock = skipRustBalancedDelimiters(source, index + 1, "}");
      index = skippedBlock < end ? skippedBlock : end;
      continue;
    }
    index += 1;
  }
}

export function extractRustModPathAttribute(
  source: string,
  moduleName?: string,
  statementStartIndex?: number,
): string | undefined {
  if (statementStartIndex !== undefined) {
    const leadingWhitespace = source.slice(statementStartIndex).search(/\S/);
    const index = statementStartIndex + Math.max(0, leadingWhitespace);
    if (source[index] === "#") {
      return pathAttributeFromAttributeBlock(collectLeadingRustOuterAttributes(source, index));
    }
    return pathAttributeFromAttributeBlock(takeTrailingRustAttributes(source, index));
  }
  if (!moduleName) return undefined;
  return extractRustModPathAttributeScopes(source).pathAttributes.get(moduleName);
}

async function isExistingAttributedPathInsideProject(projectRoot: string, attributedPath: string): Promise<boolean> {
  if (!(await fileExists(attributedPath))) return false;
  if (!isFilePathWithinRoot(projectRoot, attributedPath)) return false;
  try {
    const realRoot = await fsp.realpath(projectRoot);
    const realCandidate = await fsp.realpath(attributedPath);
    return isFilePathWithinRoot(realRoot, realCandidate);
  } catch {
    return false;
  }
}

function rustPathAttributeSignature(stat: { size: number; mtimeMs: number }): string {
  return `${stat.size}:${stat.mtimeMs}`;
}

async function loadRustPathAttributeScope(file: string): Promise<RustModuleScope> {
  const resolved = path.resolve(file);
  let signature: string;
  try {
    const stat = await fsp.stat(resolved);
    if (!stat.isFile()) return EMPTY_RUST_MODULE_SCOPE;
    signature = rustPathAttributeSignature(stat);
  } catch {
    return EMPTY_RUST_MODULE_SCOPE;
  }

  const cached = lruMapGet(rustPathAttributeCache, resolved);
  if (cached && cached.signature === signature) return cached.attributes;

  const inflightKey = `${resolved}::${signature}`;
  const inflight = rustPathAttributeInflight.get(inflightKey);
  if (inflight) return await inflight;

  const pending = (async (): Promise<RustModuleScope> => {
    try {
      const source = await fsp.readFile(resolved, "utf8");
      const attributes = extractRustModPathAttributeScopes(source);
      lruMapSet(rustPathAttributeCache, resolved, { signature, attributes }, MAX_RUST_PATH_ATTRIBUTE_CACHE_ENTRIES);
      return attributes;
    } catch {
      return EMPTY_RUST_MODULE_SCOPE;
    } finally {
      rustPathAttributeInflight.delete(inflightKey);
    }
  })();
  rustPathAttributeInflight.set(inflightKey, pending);
  return await pending;
}

function rustChildModuleDir(parentFile: string): string {
  const dir = path.dirname(parentFile);
  const stem = path.basename(parentFile, ".rs");
  if (stem === "mod" || stem === "lib" || stem === "main") return dir;
  return path.join(dir, stem);
}

async function rustDeclaringFileCandidates(fromFile: string, sourceRoot: string): Promise<string[]> {
  const files: string[] = [];
  const seen = new Set<string>();
  const root = path.resolve(sourceRoot);
  const resolvedFrom = path.resolve(fromFile);
  let dir = path.dirname(resolvedFrom);
  for (let depth = 0; depth < 16; depth += 1) {
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.endsWith(".rs")) continue;
      const abs = path.resolve(dir, entry);
      if (abs === resolvedFrom || seen.has(abs)) continue;
      seen.add(abs);
      files.push(abs);
    }
    if (path.resolve(dir) === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (!isWithinOrEqual(parent, root) && path.resolve(dir) !== root) {
      if (!seen.has(root)) {
        let rootEntries: string[] = [];
        try {
          rootEntries = await fsp.readdir(root);
        } catch {
          rootEntries = [];
        }
        for (const entry of rootEntries) {
          if (!entry.endsWith(".rs")) continue;
          const abs = path.resolve(root, entry);
          if (abs === resolvedFrom || seen.has(abs)) continue;
          seen.add(abs);
          files.push(abs);
        }
      }
      break;
    }
    dir = parent;
  }
  return files;
}

async function findAttributedDeclarationParent(
  projectRoot: string,
  declaringFile: string,
  targetFile: string,
): Promise<{ parentFile: string; parentModuleDir: string } | null> {
  const resolvedTarget = path.resolve(targetFile);
  const walk = async (
    scope: RustModuleScope,
    currentFile: string,
    currentModuleDir: string,
    attributeDirectory: string,
  ): Promise<{ parentFile: string; parentModuleDir: string } | null> => {
    for (const pathValue of scope.pathAttributes.values()) {
      const attributedPath = path.resolve(attributeDirectory, pathValue);
      if (path.resolve(attributedPath) !== resolvedTarget) continue;
      if (!(await isExistingAttributedPathInsideProject(projectRoot, attributedPath))) continue;
      return { parentFile: currentFile, parentModuleDir: currentModuleDir };
    }
    for (const [name, child] of scope.inlineModules) {
      const nextDir = path.resolve(currentModuleDir, child.inlineLocation?.directory ?? name);
      const hit = await walk(child, currentFile, nextDir, nextDir);
      if (hit) return hit;
    }
    return null;
  };
  const scope = await loadRustPathAttributeScope(declaringFile);
  return walk(scope, path.resolve(declaringFile), rustChildModuleDir(declaringFile), path.dirname(declaringFile));
}

async function findPathAttributeParent(
  projectRoot: string,
  fromFile: string,
  sourceRoot: string,
): Promise<{ parentFile: string; parentModuleDir: string } | null> {
  const candidates = await rustDeclaringFileCandidates(fromFile, sourceRoot);
  for (const candidate of candidates) {
    const found = await findAttributedDeclarationParent(projectRoot, candidate, fromFile);
    if (found) return found;
  }
  return null;
}

async function rustSuperModuleContext(
  projectRoot: string,
  fromFile: string,
  sourceRoot: string,
): Promise<{ parentFile: string | null; parentModuleDir: string }> {
  const attributed = await findPathAttributeParent(projectRoot, fromFile, sourceRoot);
  if (attributed) return attributed;
  const currentDir = path.dirname(fromFile);
  const parentModuleDir = parentRustModuleDir(fromFile, currentDir);
  return { parentFile: await resolveRustModuleParts(parentModuleDir, []), parentModuleDir };
}

async function declaringFileForSpecifierHead(
  projectRoot: string,
  fromFile: string,
  sourceRoot: string,
  head: string,
): Promise<string | null> {
  if (head === "*") return null;
  if (head === "crate") {
    return resolveRustModuleParts(sourceRoot, []);
  }
  if (head === "self") {
    return path.resolve(fromFile);
  }
  if (head === "super") {
    const context = await rustSuperModuleContext(projectRoot, fromFile, sourceRoot);
    return context.parentFile;
  }
  return path.resolve(fromFile);
}

function rustScopeAtDirectory(scope: RustModuleScope, fromDir: string, toDir: string): RustModuleScope {
  const relative = path.relative(fromDir, toDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return scope;
  let current = scope;
  for (const part of relative.split(/[\\/]/).filter(Boolean)) {
    const child = current.inlineModules.get(part);
    if (!child) return current;
    current = child;
  }
  return current;
}

async function resolveAttributedRustModulePath(
  projectRoot: string,
  fromFile: string,
  parts: readonly string[],
  sourceRoot: string,
): Promise<string | null | undefined> {
  const head = parts[0];
  if (!head) return undefined;

  let startFile: string | null;
  let startModuleDir: string | undefined;
  if (head === "super") {
    const context = await rustSuperModuleContext(projectRoot, fromFile, sourceRoot);
    startFile = context.parentFile;
    startModuleDir = context.parentModuleDir;
  } else {
    startFile = await declaringFileForSpecifierHead(projectRoot, fromFile, sourceRoot, head);
  }
  if (!startFile) return undefined;

  let childParts: readonly string[] = parts;
  if (head === "crate" || head === "self" || head === "super") {
    childParts = parts.slice(1);
  }
  let currentFile = startFile;
  let currentScope = await loadRustPathAttributeScope(currentFile);
  let currentModuleDir = startModuleDir ?? rustChildModuleDir(currentFile);
  if (startModuleDir) {
    currentScope = rustScopeAtDirectory(currentScope, rustChildModuleDir(currentFile), startModuleDir);
  }
  let attributeDirectory = path.dirname(currentFile);
  if (startModuleDir) attributeDirectory = startModuleDir;
  let usedAttribute = false;

  for (const child of childParts) {
    if (!child || child === "*") {
      if (usedAttribute) return currentFile;
      return undefined;
    }
    const pathValue = currentScope.pathAttributes.get(child);
    if (pathValue) {
      const attributedPath = path.resolve(attributeDirectory, pathValue);
      if (!(await isExistingAttributedPathInsideProject(projectRoot, attributedPath))) {
        return null;
      }
      currentFile = path.resolve(attributedPath);
      currentScope = await loadRustPathAttributeScope(currentFile);
      currentModuleDir = rustChildModuleDir(currentFile);
      attributeDirectory = path.dirname(currentFile);
      usedAttribute = true;
      continue;
    }
    const inline = currentScope.inlineModules.get(child);
    if (inline) {
      currentScope = inline;
      currentModuleDir = path.resolve(currentModuleDir, inline.inlineLocation?.directory ?? child);
      attributeDirectory = currentModuleDir;
      continue;
    }
    const conventional = await resolveRustModuleParts(currentModuleDir, [child]);
    if (!conventional) {
      if (usedAttribute) return null;
      return undefined;
    }
    currentFile = conventional;
    currentScope = await loadRustPathAttributeScope(currentFile);
    currentModuleDir = rustChildModuleDir(currentFile);
    attributeDirectory = path.dirname(currentFile);
  }

  if (usedAttribute) return currentFile;
  return undefined;
}

function inlineAttributeDirectory(scope: RustModuleScope, index: number, moduleDir: string): string | undefined {
  for (const child of scope.inlineModules.values()) {
    const location = child.inlineLocation;
    if (!location || index < location.start || index >= location.end) continue;
    const directory = path.resolve(moduleDir, location.directory);
    return inlineAttributeDirectory(child, index, directory) ?? directory;
  }
  return undefined;
}

export async function resolveRustImportPath(
  projectRoot: string,
  fromFile: string,
  spec: string,
  pathAttribute?: string,
  statementStartIndex?: number,
): Promise<string | null> {
  const normalized = normalizeRustModuleSpecifier(spec);
  if (!normalized) return null;

  const parts = normalized.split("::").filter(Boolean);
  if (!parts.length) return null;

  if (pathAttribute) {
    let attributeDirectory = path.dirname(fromFile);
    if (statementStartIndex !== undefined) {
      const scope = await loadRustPathAttributeScope(fromFile);
      attributeDirectory =
        inlineAttributeDirectory(scope, statementStartIndex, rustChildModuleDir(fromFile)) ?? attributeDirectory;
    }
    const attributedPath = path.resolve(attributeDirectory, pathAttribute);
    if (await isExistingAttributedPathInsideProject(projectRoot, attributedPath)) {
      return path.resolve(attributedPath);
    }
    return null;
  }

  const cargoRoot = await findNearestCargoRoot(fromFile, projectRoot);
  const sourceRoot = crateSourceRoot(cargoRoot, projectRoot);
  const walked = await resolveAttributedRustModulePath(projectRoot, fromFile, parts, sourceRoot);
  if (walked !== undefined) return walked;

  const currentDir = path.dirname(fromFile);
  const head = parts[0];
  const tail = parts.slice(1);

  if (head === "crate") {
    return resolveRustModuleParts(sourceRoot, tail);
  }
  if (head === "self") {
    if (!tail.length) return path.resolve(fromFile);
    return resolveRustModuleParts(currentDir, tail);
  }
  if (head === "super") {
    const context = await rustSuperModuleContext(projectRoot, fromFile, sourceRoot);
    if (!tail.length) return context.parentFile;
    return resolveRustModuleParts(context.parentModuleDir, tail);
  }

  const siblingModule = await resolveRustModuleParts(currentDir, parts);
  if (siblingModule) {
    return siblingModule;
  }
  return resolveRustModuleParts(sourceRoot, parts);
}
