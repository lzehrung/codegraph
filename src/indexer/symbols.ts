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
import { findReferences, resolveExport, resolveImported } from "./navigation.js";

export function symbolId(def: SymbolDef): SymbolHandle {
  const index = def?.range?.start?.index ?? 0;
  return `${def.file}::${def.localName}::${index}`;
}

export function defFromSymbolId(index: ProjectIndex, id: SymbolHandle): SymbolDef | null {
  if (!id) return null;
  const parts = id.split("::");
  if (parts.length < 3) return null;
  const rawFile = parts[0]!;
  const localName = parts[1]!;
  const startStr = parts[2]!;
  const file = rawFile.replace(/\\/g, "/");
  const startIndex = Number(startStr);
  const mod = index.byFile.get(file);
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
    const file = rawFile.replace(/\\/g, "/");
    const mod = index.byFile.get(file);
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
        const targetModule = index.byFile.get(target);
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
        const targetModule = index.byFile.get(target);
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
  const files = opts?.file ? [opts.file.replace(/\\/g, "/")] : Array.from(index.byFile.keys());

  for (const file of files) {
    const mod = index.byFile.get(file);
    if (!mod) continue;
    for (const def of mod.locals) {
      out.push({
        id: symbolId(def),
        file,
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
            id: `${file}::${imp.local}::import`,
            file,
            name: imp.local,
            kind: "import",
          });
        } else if (imp.kind === "namespace") {
          out.push({
            id: `${file}::${imp.localNS}::import`,
            file,
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
  for (const [file, mod] of index.byFile) {
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
    if (exports.length > 0) {
      out.push({ file, exports });
    }
  }
  return out;
}
