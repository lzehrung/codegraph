import fsp from "node:fs/promises";
import path from "node:path";
import { supportForFileWithoutHeaderSample, type LanguageExtensionMap } from "../../languages.js";
import { isJsTsLanguage } from "../../languages/js-family.js";
import { detectSFCFramework } from "../../languages/sfc.js";
import type { Edge } from "../../types.js";
import { mapLimit } from "../../util/concurrency.js";
import { fileIdentityKey, isCanonicalRelativePath, isFilePathWithinRoot, normalizePath } from "../../util/paths.js";
import { lruMapGet, lruMapSet } from "../../util/lru-map.js";
import { iterateResolutionCandidates, STYLESHEET_RESOLUTION_EXTENSIONS } from "../../util/resolution-candidates.js";
import { probeRealpath } from "../../util/fs-probe-cache.js";
import type { BuildOptions, ModuleIndex } from "../types.js";
import { cacheRoot } from "./location.js";
import { compareStrings } from "../../util/strings.js";

/** One first-party JSON candidate and the importers whose resolution can depend on it. */
export type JsonCandidateRecord = {
  file: string;
  signature: string | null;
  importers: string[];
};

export type MemoryJsonCandidates = {
  records: JsonCandidateRecord[];
  coveredFiles: ReadonlySet<string>;
  /** The last complete discovery, used to prove that unchanged importers keep their candidates. */
  scopeFiles?: ReadonlySet<string>;
  resolutionKey?: string;
};

const MAX_MEMORY_PROJECTS = 128;
const memoryCandidates = new Map<string, MemoryJsonCandidates>();

export function clearMemoryJsonCandidates(): void {
  memoryCandidates.clear();
}

function memoryKey(projectRoot: string, opts: BuildOptions | undefined): string {
  const root = fileIdentityKey(path.resolve(projectRoot));
  if (opts?.cache !== "disk") return `memory:${root}`;
  return `disk:${root}:${fileIdentityKey(cacheRoot(projectRoot, opts))}`;
}

export function memoryJsonCandidates(
  projectRoot: string,
  opts: BuildOptions | undefined,
): MemoryJsonCandidates | undefined {
  return lruMapGet(memoryCandidates, memoryKey(projectRoot, opts));
}

export function setMemoryJsonCandidates(
  projectRoot: string,
  opts: BuildOptions | undefined,
  records: JsonCandidateRecord[],
  previous: MemoryJsonCandidates | undefined,
  files: readonly string[],
  replaceScope: boolean,
  resolutionKey?: string,
): void {
  const coveredFiles = new Set(replaceScope ? [] : previous?.coveredFiles);
  for (const file of files) {
    if (canImportJson(file, opts?.languageExtensions)) coveredFiles.add(fileIdentityKey(file));
  }
  const scopeFiles = replaceScope ? new Set(files.map(fileIdentityKey)) : undefined;
  lruMapSet(
    memoryCandidates,
    memoryKey(projectRoot, opts),
    { records, coveredFiles, ...(scopeFiles ? { scopeFiles } : {}), ...(resolutionKey ? { resolutionKey } : {}) },
    MAX_MEMORY_PROJECTS,
  );
}

/** Reject the entire record on malformed or unsafe persisted input; an unknown record requires a rebuild. */
export function validateJsonCandidates(value: unknown): JsonCandidateRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const records: JsonCandidateRecord[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const { file, signature, importers } = item as Partial<JsonCandidateRecord>;
    if (typeof file !== "string" || !isCanonicalRelativePath(file) || !file.toLowerCase().endsWith(".json")) {
      return undefined;
    }
    if (signature !== null && (typeof signature !== "string" || !signature)) return undefined;
    if (!Array.isArray(importers) || !importers.length) return undefined;
    if (!importers.every((importer) => typeof importer === "string" && isCanonicalRelativePath(importer))) {
      return undefined;
    }
    const key = fileIdentityKey(file);
    if (seen.has(key)) return undefined;
    seen.add(key);
    records.push({ file, signature, importers });
  }
  return records;
}

async function candidateSignature(realRoot: string | null, file: string): Promise<string | null> {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) return null;
    // The resolver confines the physical path, not just its stat identity. In-root and
    // out-of-root hard links can have identical stats after a symlink is retargeted.
    const realFile = await probeRealpath(file);
    if (!realRoot || !realFile || !isFilePathWithinRoot(realRoot, realFile)) return null;
    const relativeRealFile = path.relative(realRoot, realFile).replace(/\\/g, "/");
    return JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs, relativeRealFile]);
  } catch {
    // An inaccessible candidate is treated as missing. If it becomes readable, its stat changes.
    return null;
  }
}

export async function inspectJsonCandidates(
  projectRoot: string,
  records: JsonCandidateRecord[],
  concurrency: number,
): Promise<{ signatures: Map<string, string | null>; changedImporters: Set<string> }> {
  const realRoot = records.length ? await probeRealpath(projectRoot) : null;
  const values = await mapLimit(records, concurrency, (record) =>
    candidateSignature(realRoot, path.resolve(projectRoot, record.file)),
  );
  const signatures = new Map<string, string | null>();
  const changedImporters = new Set<string>();
  records.forEach((record, index) => {
    const signature = values[index]!;
    signatures.set(fileIdentityKey(record.file), signature);
    if (signature === record.signature) return;
    for (const importer of record.importers) changedImporters.add(normalizePath(path.resolve(projectRoot, importer)));
  });
  return { signatures, changedImporters };
}

function relativeFile(projectRoot: string, file: string): string | undefined {
  if (!isFilePathWithinRoot(projectRoot, file)) return undefined;
  const relative = path.relative(projectRoot, file).replace(/\\/g, "/");
  return isCanonicalRelativePath(relative) ? relative : undefined;
}

type JsonCandidateInputs = {
  file: string;
  module: ModuleIndex;
  edges: readonly Edge[];
};

export function canImportJson(file: string, languageExtensions: LanguageExtensionMap | undefined): boolean {
  const support = supportForFileWithoutHeaderSample(file, languageExtensions);
  return !!detectSFCFramework(file) || (!!support && isJsTsLanguage(support.id));
}

/** Whether the relative resolver can try a JSON file for this spelling. */
export function relativeSpecifierCanImportJson(file: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const base = path.resolve(path.dirname(file), specifier);
  for (const candidate of iterateResolutionCandidates(base)) {
    if (candidate.toLowerCase().endsWith(".json")) return true;
  }
  return false;
}

/**
 * Use the relative resolver's own candidate order. A candidate after the resolved file cannot
 * change this resolution; a missing JSON candidate before it can. Alias and workspace candidate
 * generation is owned by their resolvers and is intentionally not reproduced here.
 */
function candidatesForFile(
  projectRoot: string,
  input: JsonCandidateInputs,
  languageExtensions: LanguageExtensionMap | undefined,
): Map<string, boolean | undefined> {
  if (!canImportJson(input.file, languageExtensions)) return new Map();
  const candidates = new Map<string, boolean | undefined>();
  const addSpecifier = (specifier: string, resolved: string | undefined, ambiguous = false): void => {
    if (!specifier.startsWith(".")) return;
    const base = path.resolve(path.dirname(input.file), specifier);
    const resolvedKey = resolved ? fileIdentityKey(path.resolve(resolved)) : undefined;
    for (const candidate of iterateResolutionCandidates(base)) {
      const candidateKey = fileIdentityKey(path.resolve(candidate));
      const isResolved = resolvedKey === candidateKey;
      if (candidate.toLowerCase().endsWith(".json")) {
        const relative = relativeFile(projectRoot, candidate);
        if (relative !== undefined) {
          if (ambiguous) {
            if (!candidates.has(relative)) candidates.set(relative, undefined);
          } else {
            candidates.set(relative, (candidates.get(relative) ?? false) || isResolved);
          }
        }
      }
      if (isResolved) break;
    }
  };
  let stylesheetSpecifiers: Set<string> | undefined;
  for (const binding of input.module.imports) {
    if (binding.kind === "star") {
      (stylesheetSpecifiers ??= new Set()).add(binding.from);
      continue;
    }
    addSpecifier(binding.from, typeof binding.resolved === "string" ? binding.resolved : undefined);
  }
  for (const entry of input.module.exports) {
    if (entry.type === "local") continue;
    const specifier = entry.moduleSpecifier ?? entry.fromModule;
    addSpecifier(specifier, path.isAbsolute(entry.fromModule) ? entry.fromModule : undefined);
  }
  // Side-effect and heuristic imports need not have an import binding.
  for (const edge of input.edges) {
    const target = edge.to.type === "file" ? edge.to.path : undefined;
    if (stylesheetSpecifiers?.has(edge.raw)) {
      const targetExtension = target ? path.extname(target).toLowerCase() : undefined;
      const stylesheetTarget = STYLESHEET_RESOLUTION_EXTENSIONS.some((extension) => extension === targetExtension);
      if (edge.to.type === "external" || stylesheetTarget) {
        // A style edge may also be a deduplicated script side-effect import. Observe candidate state
        // without assuming that stylesheet resolution made the JSON target absent.
        addSpecifier(edge.raw, undefined, true);
        continue;
      }
    }
    addSpecifier(edge.raw, target);
  }
  return candidates;
}

/** Update only changed importers, reusing this build's single stat of every retained candidate. */
export async function updateJsonCandidates(args: {
  projectRoot: string;
  previous: readonly JsonCandidateRecord[];
  signatures: ReadonlyMap<string, string | null>;
  replacedFiles: ReadonlySet<string>;
  files: readonly JsonCandidateInputs[];
  languageExtensions: LanguageExtensionMap | undefined;
  concurrency: number;
}): Promise<JsonCandidateRecord[]> {
  const replaced = new Set(Array.from(args.replacedFiles, (file) => fileIdentityKey(path.resolve(file))));
  const candidates = new Map<
    string,
    { file: string; importers: Set<string>; expectedPresent: boolean | "inconsistent" | undefined }
  >();
  for (const record of args.previous) {
    const importers = record.importers.filter(
      (importer) => !replaced.has(fileIdentityKey(path.resolve(args.projectRoot, importer))),
    );
    if (!importers.length) continue;
    candidates.set(fileIdentityKey(record.file), {
      file: record.file,
      importers: new Set(importers),
      expectedPresent: undefined,
    });
  }
  for (const input of args.files) {
    const importer = relativeFile(args.projectRoot, input.file);
    if (importer === undefined) continue;
    for (const [candidate, expectedPresent] of candidatesForFile(args.projectRoot, input, args.languageExtensions)) {
      const key = fileIdentityKey(candidate);
      let row = candidates.get(key);
      if (!row) {
        row = { file: candidate, importers: new Set(), expectedPresent };
        candidates.set(key, row);
      } else if (expectedPresent !== undefined) {
        if (row.expectedPresent === undefined) {
          row.expectedPresent = expectedPresent;
        } else if (row.expectedPresent !== expectedPresent) {
          // Two resolutions saw different states; force the next build to reconcile them.
          row.expectedPresent = "inconsistent";
        }
      }
      row.importers.add(importer);
    }
  }
  const missing = [...candidates.entries()].filter(([key]) => !args.signatures.has(key));
  const realRoot = missing.length ? await probeRealpath(args.projectRoot) : null;
  const newSignatures = await mapLimit(missing, args.concurrency, ([, row]) =>
    candidateSignature(realRoot, path.resolve(args.projectRoot, row.file)),
  );
  const signatures = new Map(args.signatures);
  missing.forEach(([key], index) => signatures.set(key, newSignatures[index]!));
  const records: JsonCandidateRecord[] = [];
  for (const [key, row] of candidates) {
    let signature = signatures.get(key) ?? null;
    if (row.expectedPresent === "inconsistent") signature = "changed";
    else if (row.expectedPresent !== undefined && (signature !== null) !== row.expectedPresent) signature = "changed";
    records.push({ file: row.file, signature, importers: [...row.importers].sort() });
  }
  return records.sort((left, right) => compareStrings(left.file, right.file));
}
