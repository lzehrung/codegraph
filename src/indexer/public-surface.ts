import crypto from "node:crypto";
import path from "node:path";
import { supportForFileWithoutHeaderSample, type LanguageExtensionMap } from "../languages.js";
import { fileIdentityKey, isAbsoluteFilePath, normalizePath } from "../util/paths.js";
import { DECLARATION_RESOLVED_IMPORT_LANGUAGES } from "./import-resolution-tables.js";
import type { ModuleIndex } from "./types.js";

/**
 * A file's public surface is what other files' cached index data can derive from its content.
 *
 * A cached module keeps only its own source facts plus targets resolved from specifiers. A
 * target is chosen from file existence and config, so editing the target never changes it.
 * Content-derived data exists in three places:
 * - star-import expansion (`expand-star-imports.ts`) copies the names, kinds, and C tags of the
 *   target's local exports, or of its locals when it has none;
 * - declaration-resolved languages (`DECLARATION_RESOLVED_IMPORT_LANGUAGES`) pick import targets
 *   from the namespace, package, or module declarations of other files;
 * - Rust resolves `mod` and `#[path]` through a module tree built from other files, and a Python
 *   `from pkg import name` reads the `__init__.py` of `pkg` to decide what `name` binds.
 *
 * The first is an `api` surface: a hash of exactly those inputs plus the re-export structure, so
 * a body or signature edit leaves it unchanged. The others read arbitrary parts of the file, so
 * they are a `content` surface: every content change of such a file rebuilds its dependents.
 */
export type PublicSurfaceKind = "api" | "content";

/** Bump when the hashed inputs change, so signatures from another version never compare equal. */
const PUBLIC_SURFACE_VERSION = "s1";
const SURFACE_HEX_LENGTH = 16;
const PYTHON_PACKAGE_INIT = /^__init__\.pyi?$/iu;

/**
 * Classified from the extension map and file name alone, like the incremental plan does, so a
 * header never costs a sample read. A header the plan sees as C and extraction sees as C++ is
 * still an `api` surface: neither language declares names for other files to resolve through.
 */
export function publicSurfaceKind(file: string, languageExtensions?: LanguageExtensionMap): PublicSurfaceKind {
  const languageId = supportForFileWithoutHeaderSample(file, languageExtensions)?.id;
  if (languageId === undefined) return "api";
  if (DECLARATION_RESOLVED_IMPORT_LANGUAGES.has(languageId) || languageId === "rust") return "content";
  if (languageId === "python" && PYTHON_PACKAGE_INIT.test(path.basename(file))) return "content";
  return "api";
}

function projectRelative(projectRoot: string, file: string): string {
  const relative = normalizePath(path.relative(projectRoot, file));
  return relative.startsWith("..") || path.isAbsolute(relative) ? normalizePath(file) : relative;
}

/**
 * Hash of the exported names, their kinds, their re-export sources, and the star-expansion
 * fallback locals. Positions, callable shapes, docstrings, and complexity are left out: no
 * importer caches them, so a body or signature edit keeps the signature.
 */
export function computeApiSurface(mod: ModuleIndex, projectRoot: string): string {
  const parts: unknown[] = [];
  let hasLocalExport = false;
  for (const entry of mod.exports) {
    if (entry.type === "local") {
      hasLocalExport = true;
      parts.push([
        "l",
        entry.exportedAs,
        entry.target.kind,
        entry.target.isMember ? 1 : 0,
        entry.target.cTag ?? 0,
        entry.mechanism ?? 0,
      ]);
      continue;
    }
    parts.push([
      "r",
      entry.type,
      "exportedAs" in entry ? entry.exportedAs : 0,
      isAbsoluteFilePath(entry.fromModule) ? projectRelative(projectRoot, entry.fromModule) : entry.fromModule,
      "sourceSpecifier" in entry ? entry.sourceSpecifier : 0,
      entry.typeOnly ? 1 : 0,
    ]);
  }
  // A star import of a file without local exports binds its locals instead.
  if (!hasLocalExport) {
    for (const local of mod.locals) {
      parts.push(["f", local.localName, local.kind, local.isMember ? 1 : 0, local.cTag ?? 0]);
    }
  }
  const digest = crypto.createHash("sha1").update(JSON.stringify(parts)).digest("hex");
  return `${PUBLIC_SURFACE_VERSION}:${digest.slice(0, SURFACE_HEX_LENGTH)}`;
}

/** The signature persisted with the file's manifest entry, or `undefined` for a `content` surface. */
export function publicSurfaceSignature(
  file: string,
  mod: ModuleIndex,
  projectRoot: string,
  languageExtensions?: LanguageExtensionMap,
): string | undefined {
  if (publicSurfaceKind(file, languageExtensions) === "content") return undefined;
  return computeApiSurface(mod, projectRoot);
}

/** Resolved project files that `mod` re-exports from (`export * from`, `export { x } from`, `export * as ns from`). */
export function reexportedFiles(mod: ModuleIndex): string[] {
  const files: string[] = [];
  for (const entry of mod.exports) {
    if (entry.type !== "local" && isAbsoluteFilePath(entry.fromModule)) files.push(entry.fromModule);
  }
  return files;
}

/**
 * Closes `surfaceChanged` under re-exporting: a file that re-exports from a file whose surface
 * changed exposes different names itself, so its own importers are affected too.
 * Keys are `fileIdentityKey` values; `modules` holds the freshly extracted modules by the same key.
 */
export function propagateReexportSurfaceChanges(
  modules: ReadonlyMap<string, ModuleIndex>,
  surfaceChanged: Set<string>,
): void {
  const reexporters = new Map<string, string[]>();
  for (const [key, mod] of modules) {
    for (const target of reexportedFiles(mod)) {
      const targetKey = fileIdentityKey(target);
      const bucket = reexporters.get(targetKey);
      if (bucket) bucket.push(key);
      else reexporters.set(targetKey, [key]);
    }
  }
  const queue = [...surfaceChanged];
  for (let head = 0; head < queue.length; head += 1) {
    for (const reexporter of reexporters.get(queue[head]!) ?? []) {
      if (surfaceChanged.has(reexporter)) continue;
      surfaceChanged.add(reexporter);
      queue.push(reexporter);
    }
  }
}
