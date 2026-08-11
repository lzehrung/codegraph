import type {
  ApiSurface,
  ExportEntry,
  GoToResult,
  ImportBinding,
  ProjectIndex,
  SymbolDef,
  SymbolHandle,
  SymbolListItem,
} from "./types.js";
import { fileIdentityKey, normalizePath, resolveFilePathFromRoot } from "../util/paths.js";
import { findReferences, resolveExport, resolveImported } from "./navigation.js";
import { parseSourceLocationInput } from "../util/sourceLocation.js";

export function symbolId(def: SymbolDef): SymbolHandle {
  const index = def?.range?.start?.index ?? 0;
  return `${def.file}::${def.localName}::${index}`;
}

export type QualifiedSymbolPath = {
  file: string;
  name: string;
};

/** Parse a project-relative file and local symbol identity such as `src/main.ts::run`. */
export function parseQualifiedSymbolPath(value: string): QualifiedSymbolPath | null {
  const separator = value.lastIndexOf("::");
  if (separator <= 0 || separator === value.length - 2 || value.indexOf("::") !== separator) return null;
  return { file: value.slice(0, separator), name: value.slice(separator + 2) };
}

/** Return every local definition named `name` in an already-resolved indexed file. */
export function findLocalSymbolDefinitions(index: ProjectIndex, file: string, name: string): SymbolDef[] {
  const normalizedFile = normalizePath(file);
  return (
    index.byFile.get(fileIdentityKey(normalizedFile))?.locals.filter((definition) => definition.localName === name) ??
    []
  );
}

/** A canonical symbol identity paired with its indexed definition. */
export type ResolvedSymbolTarget = {
  handle: SymbolHandle;
  definition: SymbolDef;
};

/**
 * Deterministic result of resolving a symbol target against one project index.
 *
 * `exact` has one reusable handle and definition. `ambiguous` preserves every
 * deterministic candidate, while `not_found` never guesses a target.
 */
export type SymbolTargetResolution =
  | { status: "exact"; input: string; target: ResolvedSymbolTarget }
  | { status: "ambiguous"; input: string; candidates: ResolvedSymbolTarget[] }
  | { status: "not_found"; input: string };

/**
 * Resolve a canonical handle, `file::symbol`, source location, or exact name.
 *
 * Relative file targets resolve from `index.projectRoot` when it is available.
 */
export function resolveSymbolTarget(index: ProjectIndex, input: string): SymbolTargetResolution {
  const handle = resolveExactSymbolHandle(index, input);
  if (handle) {
    return { status: "exact", input, target: handle };
  }

  const qualified = parseQualifiedSymbolPath(input);
  if (qualified) {
    const file = resolveIndexedFile(index, qualified.file);
    const definitions = file ? findLocalSymbolDefinitions(index, file, qualified.name) : [];
    return resolutionForDefinitions(input, definitions);
  }

  const location = parseSourceLocationInput(input);
  const file = resolveIndexedFile(index, location.file);
  if (file) {
    const definitions = (index.byFile.get(fileIdentityKey(file))?.locals ?? []).filter((definition) => {
      if (location.line !== undefined && definition.range.start.line !== location.line) return false;
      if (location.column !== undefined && definition.range.start.column !== location.column) return false;
      return true;
    });
    return resolutionForDefinitions(input, definitions);
  }

  const definitions: SymbolDef[] = [];
  for (const module of index.byFile.values()) {
    for (const definition of module.locals) {
      if (definition.localName === input) definitions.push(definition);
    }
  }
  return resolutionForDefinitions(input, definitions);
}

function resolveIndexedFile(index: ProjectIndex, file: string): string | undefined {
  const normalized = normalizePath(file);
  if (index.byFile.has(fileIdentityKey(normalized))) return normalized;
  if (!index.projectRoot) return undefined;
  const rooted = normalizePath(resolveFilePathFromRoot(index.projectRoot, file));
  return index.byFile.has(fileIdentityKey(rooted)) ? rooted : undefined;
}

function resolveExactSymbolHandle(index: ProjectIndex, input: string): ResolvedSymbolTarget | null {
  const parts = input.split("::");
  if (parts.length !== 3 || !/^\d+$/.test(parts[2] ?? "")) return null;
  const file = resolveIndexedFile(index, parts[0] ?? "");
  if (!file) return null;
  const name = parts[1] ?? "";
  const startIndex = Number(parts[2]);
  const definition = index.byFile
    .get(fileIdentityKey(file))
    ?.locals.find((candidate) => candidate.localName === name && (candidate.range.start.index ?? 0) === startIndex);
  if (!definition) return null;
  return { handle: symbolId(definition), definition };
}

function resolutionForDefinitions(input: string, definitions: readonly SymbolDef[]): SymbolTargetResolution {
  const candidates = definitions
    .map((definition) => ({ handle: symbolId(definition), definition }))
    .sort(compareResolvedSymbolTargets);
  if (candidates.length === 1) {
    return { status: "exact", input, target: candidates[0]! };
  }
  if (candidates.length) return { status: "ambiguous", input, candidates };
  return { status: "not_found", input };
}

function compareResolvedSymbolTargets(left: ResolvedSymbolTarget, right: ResolvedSymbolTarget): number {
  return (
    left.definition.file.localeCompare(right.definition.file) ||
    (left.definition.range.start.index ?? 0) - (right.definition.range.start.index ?? 0) ||
    left.definition.localName.localeCompare(right.definition.localName)
  );
}

export function defFromSymbolId(index: ProjectIndex, id: SymbolHandle): SymbolDef | null {
  if (!id) return null;
  const parts = id.split("::");
  if (parts.length < 3) return null;
  const rawFile = parts[0]!;
  const localName = parts[1]!;
  const startStr = parts[2]!;
  const file = normalizePath(rawFile);
  const startIndex = Number(startStr);
  const mod = index.byFile.get(fileIdentityKey(file));
  if (!mod) return null;
  const exact = mod.locals.find((def) => def.localName === localName && (def.range?.start?.index ?? 0) === startIndex);
  if (exact) return exact;
  const byName = mod.locals.find((def) => def.localName === localName);
  return byName ?? null;
}

export function resolveSymbolId(index: ProjectIndex, id: SymbolHandle): SymbolDef | null {
  if (!id) return null;
  const parts = id.split("::");
  if (parts.length === 3 && parts[2] === "import") {
    const rawFile = parts[0]!;
    const alias = parts[1]!;
    const file = normalizePath(rawFile);
    const mod = index.byFile.get(fileIdentityKey(file));
    if (!mod) return null;

    const named = mod.imports.find(
      (imp): imp is ImportBinding & { kind: "named" } => imp.kind === "named" && imp.local === alias,
    );
    if (named) {
      const result = resolveImported(index, named, named.imported);
      if (result && !("namespace" in result)) return result;
      const target = typeof named.resolved === "string" ? named.resolved : undefined;
      if (target) {
        const hit = resolveExport(index, target, named.imported);
        if (hit?.kind === "resolved") return hit.def;
      }
    }

    const defaultImport = mod.imports.find(
      (imp): imp is ImportBinding & { kind: "default" } => imp.kind === "default" && imp.local === alias,
    );
    if (defaultImport) {
      const result = resolveImported(index, defaultImport, "default");
      if (result && !("namespace" in result)) return result;
      const target = typeof defaultImport.resolved === "string" ? defaultImport.resolved : undefined;
      if (target) {
        const hit = resolveExport(index, target, "default");
        if (hit?.kind === "resolved") return hit.def;
        const targetModule = index.byFile.get(fileIdentityKey(target));
        const first = targetModule?.exports.find(
          (entry): entry is ExportEntry & { type: "local" } => entry.type === "local",
        );
        if (first) return first.target;
      }
    }

    const namespaceImport = mod.imports.find((imp) => imp.kind === "namespace" && imp.localNS === alias);
    if (namespaceImport) {
      const target = typeof namespaceImport.resolved === "string" ? namespaceImport.resolved : undefined;
      if (target) {
        const targetModule = index.byFile.get(fileIdentityKey(target));
        const first = targetModule?.exports.find(
          (entry): entry is ExportEntry & { type: "local" } => entry.type === "local",
        );
        if (first) return first.target;
        const firstLocal = targetModule?.locals?.[0];
        if (firstLocal) return firstLocal;
      }
    }

    return null;
  }

  return defFromSymbolId(index, id);
}

export function goToDefinitionById(index: ProjectIndex, id: SymbolHandle): GoToResult {
  const def = resolveSymbolId(index, id);
  if (def) return { status: "ok", definition: def };
  return { status: "not_found", reason: "No matching definition for handle" };
}

export async function findReferencesById(index: ProjectIndex, id: SymbolHandle) {
  const def = resolveSymbolId(index, id);
  if (!def) {
    return {
      status: "not_found",
      reason: "No matching definition for handle",
    } as const;
  }
  return await findReferences(index, { def });
}

export function listSymbols(index: ProjectIndex, opts?: { file?: string; includeImports?: boolean }): SymbolListItem[] {
  const out: SymbolListItem[] = [];
  const files = opts?.file ? [opts.file] : Array.from(index.byFile.values(), (module) => module.file);

  for (const file of files) {
    const mod = index.byFile.get(fileIdentityKey(file));
    if (!mod) continue;
    const displayFile = mod.file;
    for (const def of mod.locals) {
      out.push({
        id: symbolId(def),
        file: displayFile,
        name: def.localName,
        kind: def.kind,
        range: def.range,
        ...(def.docstring ? { docstring: def.docstring } : {}),
      });
    }
    if (opts?.includeImports) {
      for (const imp of mod.imports) {
        if (imp.kind === "named" || imp.kind === "default") {
          out.push({
            id: `${displayFile}::${imp.local}::import`,
            file: displayFile,
            name: imp.local,
            kind: "import",
          });
        } else if (imp.kind === "namespace") {
          out.push({
            id: `${displayFile}::${imp.localNS}::import`,
            file: displayFile,
            name: imp.localNS,
            kind: "namespaceImport",
          });
        }
      }
    }
  }

  return out;
}

export function getApiSurface(index: ProjectIndex): ApiSurface {
  const out: ApiSurface = [];
  for (const mod of index.byFile.values()) {
    const exports = mod.exports.map((entry) => {
      if (entry.type === "local") {
        return {
          name: entry.target.localName,
          kind: entry.target.kind,
          exportedAs: entry.exportedAs,
        };
      }
      if (entry.type === "reexport") {
        return {
          name: entry.sourceSpecifier,
          kind: "reexport",
          exportedAs: entry.exportedAs,
          target: { file: entry.fromModule, name: entry.sourceSpecifier },
        };
      }
      if (entry.type === "namespaceReexport") {
        return {
          name: "*",
          kind: "namespaceReexport",
          exportedAs: entry.exportedAs,
          target: { file: entry.fromModule, name: "*" },
        };
      }
      return {
        name: "*",
        kind: "exportStar",
        exportedAs: "*",
        target: { file: entry.fromModule, name: "*" },
      };
    });
    if (exports.length) {
      out.push({ file: mod.file, exports });
    }
  }
  return out;
}
