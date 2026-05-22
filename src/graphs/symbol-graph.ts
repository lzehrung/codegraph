import type { ProjectIndex } from "../indexer/types.js";
import type { FileId } from "../types.js";

export type SymbolNodeKind =
  | "function"
  | "class"
  | "variable"
  | "interface"
  | "type"
  | "default"
  | "table"
  | "view"
  | "index"
  | "constraint"
  | "routine"
  | "import"
  | "namespaceImport";

export type SymbolVisibility = "public" | "private" | "protected" | "internal";

export type SymbolNode = {
  id: string;
  file: FileId;
  name: string;
  kind: SymbolNodeKind;
  docstring?: string;
  lineSpan?: number;
  complexity?: number;
  visibility?: SymbolVisibility;
};

export type SymbolEdge = { from: string; to: string; label?: string };

export type SymbolGraph = {
  nodes: Map<string, SymbolNode>;
  edges: SymbolEdge[];
};

export type BuildSymbolGraphOptions = {
  files?: Set<FileId>;
};

function normalizeSymbolNodeKind(kind: string): SymbolNodeKind {
  if (kind === "function") return "function";
  if (kind === "class") return "class";
  if (kind === "variable") return "variable";
  if (kind === "interface") return "interface";
  if (kind === "type") return "type";
  if (kind === "default") return "default";
  if (kind === "table") return "table";
  if (kind === "view") return "view";
  if (kind === "index") return "index";
  if (kind === "constraint") return "constraint";
  if (kind === "routine") return "routine";
  if (kind === "import") return "import";
  if (kind === "namespaceImport") return "namespaceImport";
  return "variable";
}

export function defNodeId(def: { file: string; localName: string; range?: { start: { index?: number } } }): string {
  const index = def.range?.start?.index ?? 0;
  const file = typeof def.file === "string" ? def.file.replace(/\\/g, "/") : def.file;
  return `${file}::${def.localName}::${index}`;
}

export function nodeForDef(def: {
  file: string;
  localName: string;
  kind: string;
  range?: { start: { index?: number } };
  docstring?: string;
  lineSpan?: number;
  complexity?: number;
}): SymbolNode {
  return {
    id: defNodeId(def),
    file: def.file,
    name: def.localName,
    kind: normalizeSymbolNodeKind(def.kind),
    ...(def.docstring ? { docstring: def.docstring } : {}),
    ...(def.lineSpan ? { lineSpan: def.lineSpan } : {}),
    ...(typeof def.complexity === "number" ? { complexity: def.complexity } : {}),
  };
}

const normalizeFilePath = (file: string) => file.replace(/\\/g, "/");

function normalizeFileFilter(files?: Set<FileId>): Set<FileId> | undefined {
  if (!files) return undefined;
  return new Set(Array.from(files, normalizeFilePath));
}

export async function buildSymbolGraph(index: ProjectIndex, opts?: BuildSymbolGraphOptions): Promise<SymbolGraph> {
  await Promise.resolve();
  const nodes = new Map<string, SymbolNode>();
  const edges: SymbolEdge[] = [];
  const seenEdges = new Set<string>();
  const includedFiles = normalizeFileFilter(opts?.files);

  const shouldIncludeFile = (file: FileId): boolean => {
    if (!includedFiles) return true;
    return includedFiles.has(normalizeFilePath(file));
  };

  const addEdge = (from: string, to: string, label?: string) => {
    const key = `${from}->${to}::${label ?? ""}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push(label ? { from, to, label } : { from, to });
  };

  for (const [file, mod] of index.byFile) {
    if (!shouldIncludeFile(file)) continue;
    for (const def of mod.locals) {
      const node = nodeForDef(def);
      if (!nodes.has(node.id)) nodes.set(node.id, node);
    }
  }

  for (const [file, mod] of index.byFile) {
    if (!shouldIncludeFile(file)) continue;
    for (const imp of mod.imports) {
      if (!imp) continue;
      const targetFile = typeof imp.resolved === "string" ? normalizeFilePath(imp.resolved) : undefined;
      const targetMod = targetFile ? index.byFile.get(targetFile) : undefined;

      if (imp.kind === "named") {
        const aliasId = `${file}::${imp.local}::import`;
        if (!nodes.has(aliasId)) {
          nodes.set(aliasId, {
            id: aliasId,
            file,
            name: imp.local,
            kind: "import",
          });
        }
        if (targetMod) {
          let resolvedExport = targetMod.exports.find(
            (entry) => entry.type === "local" && entry.exportedAs === imp.imported,
          );
          if (!resolvedExport) {
            const local = targetMod.locals.find((entry) => entry.localName === imp.imported);
            if (local) {
              resolvedExport = {
                type: "local",
                exportedAs: imp.imported,
                target: local,
              };
            }
          }
          if (resolvedExport && resolvedExport.type === "local") {
            const def = resolvedExport.target;
            const targetId = defNodeId(def);
            if (!nodes.has(targetId)) nodes.set(targetId, nodeForDef(def));
            addEdge(aliasId, targetId, imp.imported);
          }
        }
      } else if (imp.kind === "default") {
        const aliasId = `${file}::${imp.local}::import`;
        if (!nodes.has(aliasId)) {
          nodes.set(aliasId, {
            id: aliasId,
            file,
            name: imp.local,
            kind: "import",
          });
        }
        if (targetMod) {
          let resolvedExport = targetMod.exports.find(
            (entry) => entry.type === "local" && entry.exportedAs === "default",
          );
          if (!resolvedExport) {
            resolvedExport = targetMod.exports.find((entry) => entry.type === "local");
          }
          if (resolvedExport && resolvedExport.type === "local") {
            const def = resolvedExport.target;
            const targetId = defNodeId(def);
            if (!nodes.has(targetId)) nodes.set(targetId, nodeForDef(def));
            addEdge(aliasId, targetId, "default");
          }
        }
      } else if (imp.kind === "namespace") {
        const aliasId = `${file}::${imp.localNS}::import`;
        if (!nodes.has(aliasId)) {
          nodes.set(aliasId, {
            id: aliasId,
            file,
            name: imp.localNS,
            kind: "namespaceImport",
          });
        }
        if (targetMod) {
          const exportedLocals = targetMod.exports.filter((entry) => entry.type === "local");
          for (const entry of exportedLocals) {
            const def = entry.target;
            const targetId = defNodeId(def);
            if (!nodes.has(targetId)) nodes.set(targetId, nodeForDef(def));
            addEdge(aliasId, targetId, entry.exportedAs);
          }
        }
      }
    }
  }

  return { nodes, edges };
}
